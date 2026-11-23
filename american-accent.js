const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const multer = require("multer");

const execFileAsync = promisify(execFile);

const router = express.Router();

const DATA_DIR = path.join(__dirname, "data");
const REF_DIR = path.join(DATA_DIR, "accent-ref");
const USER_DIR = path.join(DATA_DIR, "accent-user");
fs.mkdirSync(REF_DIR, { recursive: true });
fs.mkdirSync(USER_DIR, { recursive: true });

const upload = multer({
  dest: path.join(os.tmpdir(), "accent-uploads"),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// --------------------------------------------------
// AUDIO DECODING & WAV HELPERS (16 kHz mono float32)
// --------------------------------------------------

function encodeWav16kMono(samples) {
  const sampleRate = 16000;
  const numSamples = samples.length;
  const byteRate = sampleRate * 2;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(1, 22);  // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(2, 32);  // Block align
  buffer.writeUInt16LE(16, 34); // Bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] || 0));
    const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    buffer.writeInt16LE(int16, 44 + i * 2);
  }
  return buffer;
}

function decodeWavBuffer(wavBuf) {
  if (!Buffer.isBuffer(wavBuf) || wavBuf.length < 44) {
    throw new Error("Invalid WAV buffer");
  }
  if (wavBuf.toString("ascii", 0, 4) !== "RIFF" || wavBuf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let offset = 12;
  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= wavBuf.length) {
    const chunkId = wavBuf.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === "fmt " && chunkSize >= 16) {
      audioFormat = wavBuf.readUInt16LE(chunkStart);
      channels = wavBuf.readUInt16LE(chunkStart + 2);
      sampleRate = wavBuf.readUInt32LE(chunkStart + 4);
      bitsPerSample = wavBuf.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataSize = Math.min(chunkSize, wavBuf.length - chunkStart);
      break;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error("WAV data chunk missing");
  }

  const bytesPerSample = Math.max(1, Math.floor(bitsPerSample / 8));
  const totalFrames = Math.floor(dataSize / (bytesPerSample * Math.max(1, channels)));
  const rawMono = new Float32Array(totalFrames);

  for (let i = 0; i < totalFrames; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const idx = dataOffset + (i * channels + ch) * bytesPerSample;
      let s = 0;
      if (audioFormat === 3 && bitsPerSample === 32 && idx + 4 <= wavBuf.length) {
        s = wavBuf.readFloatLE(idx);
      } else if (bitsPerSample === 16 && idx + 2 <= wavBuf.length) {
        s = wavBuf.readInt16LE(idx) / 32768;
      } else if (bitsPerSample === 8 && idx + 1 <= wavBuf.length) {
        s = (wavBuf.readUInt8(idx) - 128) / 128;
      }
      sum += s;
    }
    rawMono[i] = sum / Math.max(1, channels);
  }

  if (sampleRate === 16000) {
    return rawMono;
  }

  // Linear resample to 16000 Hz
  const targetLen = Math.max(1, Math.round((totalFrames * 16000) / sampleRate));
  const resampled = new Float32Array(targetLen);
  const ratio = totalFrames / targetLen;
  for (let i = 0; i < targetLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(totalFrames - 1, i0 + 1);
    const frac = pos - i0;
    resampled[i] = rawMono[i0] * (1 - frac) + rawMono[i1] * frac;
  }
  return resampled;
}

async function decodeUploadedAudioTo16kMono(filePath) {
  const tempWav = path.join(
    os.tmpdir(),
    `accent-norm-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
  );

  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", filePath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      tempWav
    ]);
    const wavBytes = await fs.promises.readFile(tempWav);
    return decodeWavBuffer(wavBytes);
  } catch (_) {
    // Fallback if ffmpeg is unavailable or file is already WAV
    const raw = await fs.promises.readFile(filePath);
    return decodeWavBuffer(raw);
  } finally {
    await fs.promises.unlink(tempWav).catch(() => {});
  }
}

function trimSilence(samples, sampleRate = 16000, threshold = 0.018, padMs = 80) {
  if (!samples || samples.length === 0) return new Float32Array(1600);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-5) return samples.slice(0, Math.min(samples.length, sampleRate));

  const thresh = Math.max(threshold, peak * 0.08);
  let start = 0;
  let end = samples.length - 1;
  while (start < samples.length && Math.abs(samples[start]) < thresh) start++;
  while (end > start && Math.abs(samples[end]) < thresh) end--;

  const pad = Math.round((padMs / 1000) * sampleRate);
  start = Math.max(0, start - pad);
  end = Math.min(samples.length - 1, end + pad);

  const trimmed = samples.slice(start, end + 1);
  return trimmed.length >= 400 ? trimmed : samples;
}

function normalizePeak(samples, targetPeak = 0.85) {
  const out = new Float32Array(samples.length);
  let maxVal = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > maxVal) maxVal = v;
  }
  const gain = maxVal > 1e-5 ? targetPeak / maxVal : 1;
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return out;
}

// --------------------------------------------------
// SYLLABLE ESTIMATION (ENGLISH WORD & ACOUSTIC PEAKS)
// --------------------------------------------------

function estimateWordSyllables(word) {
  const clean = String(word || "")
    .toLowerCase()
    .replace(/[^a-z']/g, "");
  if (!clean) return { count: 1, labels: ["Syl 1"], stressedIndex: 0 };

  let base = clean.replace(/'/g, "");
  if (base.length <= 3) {
    return { count: 1, labels: [`${base} (1)`], stressedIndex: 0 };
  }

  base = base
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/i, "")
    .replace(/^y/i, "");

  const vowelGroups = base.match(/[aeiouy]{1,2}/g);
  let count = vowelGroups ? vowelGroups.length : 1;
  if (/(?:[^aeiouy]le|[^aeiouy]les)$/i.test(clean) && !/[aeiouy]{2}le$/i.test(clean)) {
    count = Math.max(1, count);
  }
  count = Math.max(1, Math.min(6, count));

  // Primary stress heuristic for common English words
  let stressedIndex = 0;
  if (count >= 2) {
    if (/(?:tion|sion|ic|ical|ity|graphy|logy|metry)$/i.test(clean)) {
      stressedIndex = Math.max(0, count - 2);
    } else if (/^(?:re|un|in|im|dis|mis|de|pre|over|under|out|be|a)[a-z]/i.test(clean) && count >= 2) {
      stressedIndex = 1;
    } else {
      stressedIndex = 0;
    }
  }

  const labels = [];
  for (let i = 0; i < count; i++) {
    labels.push(i === stressedIndex ? `Syl ${i + 1} [STRESS]` : `Syl ${i + 1}`);
  }
  return { count, labels, stressedIndex };
}

function detectAcousticSyllableBoundaries(samples, sampleRate, expectedCount) {
  const frameSize = Math.round(0.02 * sampleRate); // 20 ms
  const hopSize = Math.round(0.01 * sampleRate);   // 10 ms
  const energies = [];

  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    let sumSq = 0;
    for (let i = 0; i < frameSize; i++) {
      const v = samples[start + i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    energies.push(db);
  }

  if (energies.length === 0) {
    return [[0, samples.length]];
  }

  // Smooth energy contour
  const smooth = energies.map((_, idx) => {
    const lo = Math.max(0, idx - 2);
    const hi = Math.min(energies.length - 1, idx + 2);
    let acc = 0;
    for (let k = lo; k <= hi; k++) acc += energies[k];
    return acc / (hi - lo + 1);
  });

  // Find local maxima (syllable nuclei)
  const peaks = [];
  for (let i = 2; i < smooth.length - 2; i++) {
    if (
      smooth[i] >= smooth[i - 1] &&
      smooth[i] >= smooth[i + 1] &&
      smooth[i] >= smooth[i - 2] &&
      smooth[i] >= smooth[i + 2] &&
      smooth[i] > -42
    ) {
      if (peaks.length === 0 || i - peaks[peaks.length - 1].idx >= 8) {
        peaks.push({ idx: i, db: smooth[i] });
      } else if (smooth[i] > peaks[peaks.length - 1].db) {
        peaks[peaks.length - 1] = { idx: i, db: smooth[i] };
      }
    }
  }

  let boundsFrameIdx = [];
  if (peaks.length === expectedCount) {
    boundsFrameIdx.push(0);
    for (let p = 0; p < peaks.length - 1; p++) {
      let minIdx = peaks[p].idx;
      let minVal = smooth[minIdx];
      for (let k = peaks[p].idx; k <= peaks[p + 1].idx; k++) {
        if (smooth[k] < minVal) {
          minVal = smooth[k];
          minIdx = k;
        }
      }
      boundsFrameIdx.push(minIdx);
    }
    boundsFrameIdx.push(smooth.length - 1);
  } else {
    // Evenly divide acoustic duration into expected syllables
    for (let s = 0; s <= expectedCount; s++) {
      boundsFrameIdx.push(Math.round((s / expectedCount) * (smooth.length - 1)));
    }
  }

  const segments = [];
  for (let s = 0; s < expectedCount; s++) {
    const startSample = Math.min(samples.length, boundsFrameIdx[s] * hopSize);
    const endSample =
      s === expectedCount - 1
        ? samples.length
        : Math.min(samples.length, Math.max(startSample + 1, boundsFrameIdx[s + 1] * hopSize));
    segments.push([startSample, Math.max(startSample + 1, endSample)]);
  }
  return segments;
}

// --------------------------------------------------
// ACOUSTIC ANALYSIS: PITCH (F0), FORMANT ENVELOPE, SPECTROGRAM
// --------------------------------------------------

function estimatePitchFrame(frame, sampleRate) {
  // Autocorrelation pitch tracker for speech (75 Hz - 420 Hz)
  let rms = 0;
  for (let i = 0; i < frame.length; i++) rms += frame[i] * frame[i];
  rms = Math.sqrt(rms / frame.length);
  if (rms < 0.015) return null;

  const minLag = Math.floor(sampleRate / 420);
  const maxLag = Math.min(frame.length - 2, Math.floor(sampleRate / 75));
  if (maxLag <= minLag) return null;

  let bestLag = -1;
  let bestCorr = 0;
  let energy0 = 0;
  for (let i = 0; i < frame.length; i++) energy0 += frame[i] * frame[i];
  if (energy0 < 1e-8) return null;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let energyLag = 0;
    for (let i = 0; i < frame.length - lag; i++) {
      const a = frame[i];
      const b = frame[i + lag];
      corr += a * b;
      energyLag += b * b;
    }
    const normCorr = corr / Math.sqrt(energy0 * Math.max(energyLag, 1e-8));
    if (normCorr > bestCorr) {
      bestCorr = normCorr;
      bestLag = lag;
    }
  }

  if (bestLag > 0 && bestCorr >= 0.45) {
    return sampleRate / bestLag;
  }
  return null;
}

function computeSpectrumAndFormants(frame, sampleRate = 16000, numBins = 128) {
  // Hann-windowed DFT magnitude bins up to Nyquist (8000 Hz)
  const N = frame.length;
  const mags = new Float32Array(numBins);

  // Pre-emphasis filter to make F2/F3 peaks clearer
  const pre = new Float32Array(N);
  pre[0] = frame[0];
  for (let i = 1; i < N; i++) {
    pre[i] = frame[i] - 0.94 * frame[i - 1];
  }

  for (let k = 0; k < numBins; k++) {
    // Map bin k to frequency in [0, sampleRate/2]
    const freq = (k / numBins) * (sampleRate / 2);
    const omega = (2 * Math.PI * freq) / sampleRate;
    let re = 0;
    let im = 0;
    // Subsample step for fast real-time server execution
    const step = N > 512 ? 2 : 1;
    for (let n = 0; n < N; n += step) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / Math.max(1, N - 1));
      const x = pre[n] * win;
      re += x * Math.cos(omega * n);
      im -= x * Math.sin(omega * n);
    }
    mags[k] = Math.sqrt(re * re + im * im) / Math.max(1, N / step);
  }

  // Smooth spectral envelope to pick formant peaks (F1: 250-1100 Hz, F2: 750-2600 Hz, F3: 1700-3600 Hz)
  const env = new Float32Array(numBins);
  for (let k = 0; k < numBins; k++) {
    const lo = Math.max(0, k - 3);
    const hi = Math.min(numBins - 1, k + 3);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += mags[j];
    env[k] = s / (hi - lo + 1);
  }

  const binToHz = k => (k / numBins) * (sampleRate / 2);
  const hzToBin = hz => Math.max(1, Math.min(numBins - 2, Math.round((hz / (sampleRate / 2)) * numBins)));

  function peakInBand(minHz, maxHz, fallbackHz) {
    const lo = hzToBin(minHz);
    const hi = hzToBin(maxHz);
    let bestBin = -1;
    let bestVal = -1;
    for (let k = lo; k <= hi; k++) {
      if (env[k] > bestVal) {
        bestVal = env[k];
        bestBin = k;
      }
    }
    return bestBin > 0 && bestVal > 1e-6 ? Math.round(binToHz(bestBin)) : fallbackHz;
  }

  const f1 = peakInBand(260, 1050, 520);
  const f2 = Math.max(f1 + 350, peakInBand(850, 2550, 1550));
  const f3 = Math.max(f2 + 350, peakInBand(1750, 3500, 2550));

  // Normalize spectrogram row to [0..1] dB scale
  const normRow = Array.from(mags).map(m => {
    const db = 20 * Math.log10(Math.max(m, 1e-6));
    return Math.max(0, Math.min(1, (db + 75) / 55));
  });

  // Compact 13-band MFCC-like cepstral summary for DTW alignment
  const mfcc = [];
  const bands = 13;
  const binsPerBand = Math.max(1, Math.floor(numBins / bands));
  for (let b = 0; b < bands; b++) {
    let sum = 0;
    for (let j = 0; j < binsPerBand; j++) {
      sum += normRow[b * binsPerBand + j] || 0;
    }
    mfcc.push(sum / binsPerBand);
  }

  return { f1, f2, f3, normRow, mfcc };
}

function analyzeSignal(samples, sampleRate = 16000, wordText = "word") {
  const frameLen = Math.round(0.025 * sampleRate); // 25 ms
  const hopLen = Math.round(0.0125 * sampleRate); // 12.5 ms
  const numFrames = Math.max(1, Math.floor((samples.length - frameLen) / hopLen) + 1);

  const pitchHz = [];
  const intensityDb = [];
  const f1Hz = [];
  const f2Hz = [];
  const f3Hz = [];
  const spectrogram = [];
  const mfccFrames = [];

  for (let f = 0; f < numFrames; f++) {
    const start = Math.min(samples.length - 1, f * hopLen);
    const frame = new Float32Array(frameLen);
    let sumSq = 0;
    for (let i = 0; i < frameLen; i++) {
      const v = samples[start + i] || 0;
      frame[i] = v;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / frameLen);
    const db = Number((20 * Math.log10(Math.max(rms, 1e-6))).toFixed(1));
    intensityDb.push(db);

    const f0 = estimatePitchFrame(frame, sampleRate);
    pitchHz.push(f0 ? Math.round(f0) : null);

    const spec = computeSpectrumAndFormants(frame, sampleRate, 96);
    f1Hz.push(spec.f1);
    f2Hz.push(spec.f2);
    f3Hz.push(spec.f3);
    spectrogram.push(spec.normRow);
    mfccFrames.push(spec.mfcc);
  }

  // Downsampled waveform envelope for clean canvas plotting (180 points)
  const wavePoints = [];
  const targetWaveLen = 180;
  const blockSize = Math.max(1, Math.floor(samples.length / targetWaveLen));
  for (let i = 0; i < targetWaveLen; i++) {
    const sIdx = Math.min(samples.length - 1, i * blockSize);
    const eIdx = Math.min(samples.length, sIdx + blockSize);
    let minV = 0;
    let maxV = 0;
    for (let j = sIdx; j < eIdx; j++) {
      const v = samples[j];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    wavePoints.push([Number(minV.toFixed(3)), Number(maxV.toFixed(3))]);
  }

  const voiced = pitchHz.filter(v => typeof v === "number");
  const avgF0 = voiced.length
    ? Math.round(voiced.reduce((a, b) => a + b, 0) / voiced.length)
    : 0;
  const minF0 = voiced.length ? Math.min(...voiced) : 0;
  const maxF0 = voiced.length ? Math.max(...voiced) : 0;

  const avg = arr => Math.round(arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length));
  const avgF1 = avg(f1Hz);
  const avgF2 = avg(f2Hz);
  const avgF3 = avg(f3Hz);
  const maxDb = Number(Math.max(...intensityDb).toFixed(1));
  const durationMs = Math.round((samples.length / sampleRate) * 1000);

  // Syllable segmentation and per-syllable metrics
  const sylMeta = estimateWordSyllables(wordText);
  const segments = detectAcousticSyllableBoundaries(samples, sampleRate, sylMeta.count);

  const syllables = segments.map(([sStart, sEnd], idx) => {
    const segSamples = samples.slice(sStart, sEnd);
    let sq = 0;
    for (let i = 0; i < segSamples.length; i++) sq += segSamples[i] * segSamples[i];
    const segDb = Number((20 * Math.log10(Math.max(Math.sqrt(sq / Math.max(1, segSamples.length)), 1e-6))).toFixed(1));

    const fStart = Math.min(numFrames - 1, Math.floor((sStart / Math.max(1, samples.length)) * numFrames));
    const fEnd = Math.max(fStart + 1, Math.min(numFrames, Math.ceil((sEnd / Math.max(1, samples.length)) * numFrames)));
    const segPitch = pitchHz.slice(fStart, fEnd).filter(v => typeof v === "number");
    const segF0 = segPitch.length
      ? Math.round(segPitch.reduce((a, b) => a + b, 0) / segPitch.length)
      : avgF0;
    const segF1 = avg(f1Hz.slice(fStart, fEnd));
    const segF2 = avg(f2Hz.slice(fStart, fEnd));

    return {
      index: idx + 1,
      label: sylMeta.labels[idx] || `Syl ${idx + 1}`,
      isStressed: idx === sylMeta.stressedIndex,
      startMs: Math.round((sStart / sampleRate) * 1000),
      endMs: Math.round((sEnd / sampleRate) * 1000),
      durationMs: Math.round(((sEnd - sStart) / sampleRate) * 1000),
      peakDb: segDb,
      meanF0: segF0,
      meanF1: segF1,
      meanF2: segF2
    };
  });

  return {
    durationMs,
    avgF0,
    minF0,
    maxF0,
    avgF1,
    avgF2,
    avgF3,
    maxDb,
    wavePoints,
    pitchHz,
    intensityDb,
    f1Hz,
    f2Hz,
    f3Hz,
    spectrogram,
    mfccFrames,
    syllables
  };
}

// --------------------------------------------------
// DYNAMIC TIME WARPING (DTW) & SYLLABLE MATCHING
// --------------------------------------------------

function euclidean(a, b) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / Math.max(1, len));
}

function alignWithDTW(refAnalysis, userAnalysis) {
  const rSeq = refAnalysis.mfccFrames;
  const uSeq = userAnalysis.mfccFrames;
  const n = rSeq.length;
  const m = uSeq.length;

  const cost = Array.from({ length: n + 1 }, () => Array(m + 1).fill(Infinity));
  cost[0][0] = 0;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = euclidean(rSeq[i - 1], uSeq[j - 1]);
      const prev = Math.min(cost[i - 1][j], cost[i][j - 1], cost[i - 1][j - 1]);
      cost[i][j] = d + prev;
    }
  }

  const pathPairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    pathPairs.unshift([i - 1, j - 1]);
    const diag = cost[i - 1][j - 1];
    const up = cost[i - 1][j];
    const left = cost[i][j - 1];
    if (diag <= up && diag <= left) {
      i--;
      j--;
    } else if (up < left) {
      i--;
    } else {
      j--;
    }
  }

  const avgDtwDistance = Number((cost[n][m] / Math.max(1, pathPairs.length)).toFixed(3));

  // Build aligned frame series for side-by-side visual comparison
  const alignedRefPitch = [];
  const alignedUserPitch = [];
  const alignedRefF1 = [];
  const alignedUserF1 = [];
  const alignedRefF2 = [];
  const alignedUserF2 = [];
  const alignedRefF3 = [];
  const alignedUserF3 = [];
  const alignedRefDb = [];
  const alignedUserDb = [];
  const alignedRefSpec = [];
  const alignedUserSpec = [];

  // Normalize pitch relative to each speaker's mean F0 so vocal-tract pitch floor doesn't artificially penalize
  const refBaseF0 = refAnalysis.avgF0 || 160;
  const userBaseF0 = userAnalysis.avgF0 || 160;

  let pitchSemitoneDiffSum = 0;
  let pitchSemitoneCount = 0;
  let formantNormDiffSum = 0;

  for (const [ri, ui] of pathPairs) {
    alignedRefPitch.push(refAnalysis.pitchHz[ri]);
    alignedUserPitch.push(userAnalysis.pitchHz[ui]);
    alignedRefF1.push(refAnalysis.f1Hz[ri]);
    alignedUserF1.push(userAnalysis.f1Hz[ui]);
    alignedRefF2.push(refAnalysis.f2Hz[ri]);
    alignedUserF2.push(userAnalysis.f2Hz[ui]);
    alignedRefF3.push(refAnalysis.f3Hz[ri]);
    alignedUserF3.push(userAnalysis.f3Hz[ui]);
    alignedRefDb.push(refAnalysis.intensityDb[ri]);
    alignedUserDb.push(userAnalysis.intensityDb[ui]);
    alignedRefSpec.push(refAnalysis.spectrogram[ri]);
    alignedUserSpec.push(userAnalysis.spectrogram[ui]);

    const f1Diff = Math.abs(refAnalysis.f1Hz[ri] - userAnalysis.f1Hz[ui]) / 700;
    const f2Diff = Math.abs(refAnalysis.f2Hz[ri] - userAnalysis.f2Hz[ui]) / 1600;
    formantNormDiffSum += (f1Diff + f2Diff) / 2;

    if (refAnalysis.pitchHz[ri] && userAnalysis.pitchHz[ui]) {
      const refRel = refAnalysis.pitchHz[ri] / refBaseF0;
      const usrRel = userAnalysis.pitchHz[ui] / userBaseF0;
      const semitones = Math.abs(12 * Math.log2(Math.max(0.4, Math.min(2.5, refRel / usrRel))));
      pitchSemitoneDiffSum += semitones;
      pitchSemitoneCount++;
    }
  }

  const steps = Math.max(1, pathPairs.length);
  const avgFormantErr = formantNormDiffSum / steps;
  const avgPitchSemitoneErr = pitchSemitoneCount > 0 ? pitchSemitoneDiffSum / pitchSemitoneCount : 1.5;

  // Convert DTW spectral distance, formant proximity, and relative pitch contour into 0-100 match score
  const spectralScore = Math.max(0, Math.min(100, (1 - avgDtwDistance / 0.42) * 100));
  const formantScore = Math.max(0, Math.min(100, (1 - avgFormantErr / 0.45) * 100));
  const prosodyScore = Math.max(0, Math.min(100, (1 - avgPitchSemitoneErr / 5.0) * 100));

  const overallScore = Number(
    (spectralScore * 0.5 + formantScore * 0.3 + prosodyScore * 0.2).toFixed(1)
  );

  // Per-syllable comparison & pinpointing which syllable needs self-correction
  const sylCount = Math.max(refAnalysis.syllables.length, userAnalysis.syllables.length);
  const syllableComparisons = [];

  for (let idx = 0; idx < sylCount; idx++) {
    const rSyl = refAnalysis.syllables[idx] || refAnalysis.syllables[refAnalysis.syllables.length - 1];
    const uSyl = userAnalysis.syllables[idx] || null;

    if (!uSyl) {
      syllableComparisons.push({
        syllableNumber: idx + 1,
        label: rSyl.label,
        isStressed: rSyl.isStressed,
        matchScore: 25,
        status: "Missing / Clipped",
        refDurationMs: rSyl.durationMs,
        userDurationMs: 0,
        f1DiffHz: rSyl.meanF1,
        f2DiffHz: rSyl.meanF2,
        dbDiff: Number((rSyl.peakDb + 50).toFixed(1)),
        tip: `Syllable ${idx + 1} was not clearly detected—articulate this syllable more distinctly.`
      });
      continue;
    }

    const durRatioErr = Math.abs(uSyl.durationMs - rSyl.durationMs) / Math.max(80, rSyl.durationMs);
    const f1DiffHz = Math.abs(uSyl.meanF1 - rSyl.meanF1);
    const f2DiffHz = Math.abs(uSyl.meanF2 - rSyl.meanF2);
    const dbDiff = Number(Math.abs(uSyl.peakDb - rSyl.peakDb).toFixed(1));

    const sylPenalty =
      Math.min(45, (f1DiffHz / 500) * 22 + (f2DiffHz / 1200) * 23) +
      Math.min(30, durRatioErr * 25) +
      Math.min(25, (dbDiff / 18) * 20);

    const matchScore = Number(Math.max(10, Math.min(99, 100 - sylPenalty)).toFixed(1));

    let status = "Close Match";
    if (matchScore < 65) status = "Needs Focus";
    else if (matchScore < 82) status = "Fair — Refine";

    let tip = "Good alignment on this syllable.";
    if (f2DiffHz > 380 || f1DiffHz > 180) {
      tip = `Adjust vowel tongue position (F1 ${uSyl.meanF1} Hz vs ref ${rSyl.meanF1} Hz, F2 ${uSyl.meanF2} Hz vs ref ${rSyl.meanF2} Hz).`;
    } else if (durRatioErr > 0.35) {
      tip =
        uSyl.durationMs < rSyl.durationMs
          ? `Hold Syllable ${idx + 1} slightly longer (${uSyl.durationMs} ms vs ref ${rSyl.durationMs} ms).`
          : `Trim extra length on Syllable ${idx + 1} (${uSyl.durationMs} ms vs ref ${rSyl.durationMs} ms).`;
    } else if (dbDiff > 6) {
      tip =
        uSyl.peakDb < rSyl.peakDb
          ? `Give Syllable ${idx + 1} stronger vocal projection/stress.`
          : `Ease off excessive loudness on Syllable ${idx + 1}.`;
    }

    syllableComparisons.push({
      syllableNumber: idx + 1,
      label: rSyl.label,
      isStressed: rSyl.isStressed,
      matchScore,
      status,
      refDurationMs: rSyl.durationMs,
      userDurationMs: uSyl.durationMs,
      f1DiffHz,
      f2DiffHz,
      dbDiff,
      tip
    });
  }

  let focusSyllable = null;
  if (syllableComparisons.length > 0) {
    focusSyllable = syllableComparisons.reduce((worst, cur) =>
      cur.matchScore < worst.matchScore ? cur : worst
    );
  }

  return {
    overallScore,
    spectralScore: Number(spectralScore.toFixed(1)),
    formantScore: Number(formantScore.toFixed(1)),
    prosodyScore: Number(prosodyScore.toFixed(1)),
    avgDtwDistance,
    syllableCount: sylCount,
    focusSyllable,
    syllableComparisons,
    alignedVisuals: {
      alignedRefPitch,
      alignedUserPitch,
      alignedRefF1,
      alignedUserF1,
      alignedRefF2,
      alignedUserF2,
      alignedRefF3,
      alignedUserF3,
      alignedRefDb,
      alignedUserDb,
      alignedRefSpec,
      alignedUserSpec
    }
  };
}

// --------------------------------------------------
// REFERENCE AUDIO PROVIDER (OPENAI TTS -> SYNTH FALLBACK)
// --------------------------------------------------

function synthesizeFallbackReferenceWord(word, sampleRate = 16000) {
  const syl = estimateWordSyllables(word);
  const sylDurationSec = 0.24;
  const totalSec = Math.max(0.35, syl.count * sylDurationSec + 0.08);
  const totalSamples = Math.round(totalSec * sampleRate);
  const out = new Float32Array(totalSamples);

  const lower = String(word || "word").toLowerCase();
  const hasR = /r/.test(lower);
  const hasSibilant = /[szx]|sh|ch|th/.test(lower);

  for (let s = 0; s < syl.count; s++) {
    const startIdx = Math.floor((s * sylDurationSec) * sampleRate);
    const endIdx = Math.min(totalSamples, Math.floor(((s + 1) * sylDurationSec) * sampleRate));
    const len = Math.max(1, endIdx - startIdx);
    const isStressed = s === syl.stressedIndex;
    const baseF0 = isStressed ? 168 : 138;
    const f1 = isStressed ? 620 : 480;
    const f2 = hasR ? 1320 : isStressed ? 1620 : 1450;
    const f3 = hasR ? 1850 : 2580;
    const amp = isStressed ? 0.78 : 0.46;

    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const env = Math.sin(Math.PI * Math.min(1, i / len));
      const f0 = baseF0 * (1 - 0.14 * (i / len));
      const phase = 2 * Math.PI * f0 * t;

      // Glottal pulse + formant resonators
      const pulse =
        Math.sin(phase) +
        0.55 * Math.sin(2 * phase) +
        0.3 * Math.sin(3 * phase);
      const formantWave =
        0.5 * Math.sin(2 * Math.PI * f1 * t) +
        0.3 * Math.sin(2 * Math.PI * f2 * t) +
        0.2 * Math.sin(2 * Math.PI * f3 * t);
      const fric = hasSibilant ? (Math.random() * 2 - 1) * 0.12 : 0;

      out[startIdx + i] = (pulse * 0.45 + formantWave + fric) * env * amp;
    }
  }

  return normalizePeak(trimSilence(out, sampleRate), 0.85);
}

async function getAmericanReferenceSamples(word, voice = "alloy") {
  const cleanWord = String(word || "").trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(`en-US:${voice}:${cleanWord}`).digest("hex").slice(0, 16);
  const cachedWavPath = path.join(REF_DIR, `ref-${hash}.wav`);
  const publicUrl = `/american-accent/audio/ref/ref-${hash}.wav`;

  if (fs.existsSync(cachedWavPath)) {
    const buf = await fs.promises.readFile(cachedWavPath);
    return {
      samples: decodeWavBuffer(buf),
      audioUrl: publicUrl,
      source: "cached-american-reference"
    };
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const ttsModel = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: ttsModel,
          voice,
          input: cleanWord,
          instructions: "Pronounce this single English word clearly in a natural General American accent.",
          response_format: "wav"
        })
      });

      if (response.ok) {
        const arrayBuf = await response.arrayBuffer();
        const rawWav = Buffer.from(arrayBuf);
        const decoded = decodeWavBuffer(rawWav);
        const trimmed = normalizePeak(trimSilence(decoded, 16000), 0.85);
        await fs.promises.writeFile(cachedWavPath, encodeWav16kMono(trimmed));
        return {
          samples: trimmed,
          audioUrl: publicUrl,
          source: `openai-tts (${ttsModel}, ${voice})`
        };
      }
    } catch (err) {
      console.warn("TTS reference fallback triggered:", err.message);
    }
  }

  const synth = synthesizeFallbackReferenceWord(cleanWord, 16000);
  await fs.promises.writeFile(cachedWavPath, encodeWav16kMono(synth));
  return {
    samples: synth,
    audioUrl: publicUrl,
    source: "built-in-formant-synthesizer (no API key / offline fallback)"
  };
}

// --------------------------------------------------
// API ROUTES
// --------------------------------------------------

router.use("/audio/ref", express.static(REF_DIR));
router.use("/audio/user", express.static(USER_DIR));

router.post("/api/compare", upload.single("audio"), async (req, res) => {
  try {
    const word = String(req.body?.word || "").trim();
    const voice = String(req.body?.voice || "alloy").trim();

    if (!word) {
      return res.status(400).json({ error: "Please enter a target word." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Please record your pronunciation first." });
    }

    const rawUser = await decodeUploadedAudioTo16kMono(req.file.path);
    const cleanUser = normalizePeak(trimSilence(rawUser, 16000), 0.85);

    const userId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userWavName = `user-${userId}.wav`;
    await fs.promises.writeFile(path.join(USER_DIR, userWavName), encodeWav16kMono(cleanUser));

    const ref = await getAmericanReferenceSamples(word, voice);

    const referenceAnalysis = analyzeSignal(ref.samples, 16000, word);
    const userAnalysis = analyzeSignal(cleanUser, 16000, word);
    const comparison = alignWithDTW(referenceAnalysis, userAnalysis);

    return res.json({
      success: true,
      word,
      referenceSource: ref.source,
      referenceAudioUrl: ref.audioUrl,
      userAudioUrl: `/american-accent/audio/user/${userWavName}`,
      referenceMetrics: {
        durationMs: referenceAnalysis.durationMs,
        avgF0: referenceAnalysis.avgF0,
        minF0: referenceAnalysis.minF0,
        maxF0: referenceAnalysis.maxF0,
        avgF1: referenceAnalysis.avgF1,
        avgF2: referenceAnalysis.avgF2,
        avgF3: referenceAnalysis.avgF3,
        maxDb: referenceAnalysis.maxDb,
        wavePoints: referenceAnalysis.wavePoints,
        syllables: referenceAnalysis.syllables
      },
      userMetrics: {
        durationMs: userAnalysis.durationMs,
        avgF0: userAnalysis.avgF0,
        minF0: userAnalysis.minF0,
        maxF0: userAnalysis.maxF0,
        avgF1: userAnalysis.avgF1,
        avgF2: userAnalysis.avgF2,
        avgF3: userAnalysis.avgF3,
        maxDb: userAnalysis.maxDb,
        wavePoints: userAnalysis.wavePoints,
        syllables: userAnalysis.syllables
      },
      comparison
    });
  } catch (err) {
    console.error("Word accent comparison error:", err);
    return res.status(500).json({
      error: "Failed to compare word pronunciation.",
      details: err.message
    });
  } finally {
    if (req.file?.path) {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }
  }
});

// --------------------------------------------------
// STANDALONE WORD-LEVEL SELF-CORRECTION PAGE
// --------------------------------------------------

router.get(["/", ""], (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>American Accent Word Lab (Praat-Style)</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f141c;
    color: #e6edf5;
  }
  header {
    background: #172131;
    border-bottom: 1px solid #29384f;
    padding: 18px 24px;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  header h1 { margin: 0; font-size: 20px; }
  header p { margin: 4px 0 0; color: #9fb0c7; font-size: 13px; }
  a.back-link {
    color: #8cc2ff;
    text-decoration: none;
    font-size: 13px;
    border: 1px solid #355075;
    padding: 7px 12px;
    border-radius: 6px;
  }
  main {
    max-width: 1240px;
    margin: 22px auto;
    padding: 0 18px 50px;
  }
  .card {
    background: #161f2e;
    border: 1px solid #28364c;
    border-radius: 12px;
    padding: 18px;
    margin-bottom: 18px;
  }
  .controls-row {
    display: grid;
    grid-template-columns: 1.4fr 0.8fr auto auto;
    gap: 12px;
    align-items: end;
  }
  @media (max-width: 820px) {
    .controls-row { grid-template-columns: 1fr; }
  }
  label {
    display: block;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #9fb0c7;
    margin-bottom: 6px;
  }
  input[type="text"], select {
    width: 100%;
    padding: 11px 12px;
    border-radius: 8px;
    border: 1px solid #334663;
    background: #0e1520;
    color: #f0f5fb;
    font-size: 15px;
  }
  button {
    padding: 11px 16px;
    border-radius: 8px;
    border: 0;
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    background: #2b7de9;
    color: #fff;
  }
  button.record { background: #d64545; }
  button.stop { background: #22a06b; }
  button.secondary { background: #26354b; color: #dce7f5; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .samples {
    margin-top: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .chip {
    background: #213047;
    color: #b9d2f2;
    border: 1px solid #32496b;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    cursor: pointer;
  }
  .chip:hover { background: #2d4261; }
  .status {
    margin-top: 12px;
    font-size: 13px;
    color: #b7c8de;
  }
  .score-banner {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
  }
  @media (max-width: 780px) {
    .score-banner { grid-template-columns: repeat(2, 1fr); }
  }
  .kpi {
    background: #101824;
    border: 1px solid #25344b;
    border-radius: 10px;
    padding: 14px;
  }
  .kpi span { font-size: 12px; color: #93a6bf; display: block; }
  .kpi strong { font-size: 24px; margin-top: 4px; display: block; color: #7cc0ff; }
  .focus-box {
    margin-top: 14px;
    background: #281e12;
    border: 1px solid #8a5a19;
    border-radius: 10px;
    padding: 12px 14px;
    color: #ffd79a;
    font-size: 14px;
  }
  .side-by-side {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  @media (max-width: 900px) {
    .side-by-side { grid-template-columns: 1fr; }
  }
  .pane-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .pane-header h3 { margin: 0; font-size: 15px; }
  canvas.praat-canvas {
    width: 100%;
    height: 330px;
    background: #090d14;
    border: 1px solid #24334a;
    border-radius: 8px;
    display: block;
  }
  .legend {
    margin-top: 8px;
    font-size: 12px;
    color: #9cb0c9;
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }
  .nums-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    margin-top: 12px;
    font-size: 13px;
  }
  .num-cell {
    background: #0f1722;
    border: 1px solid #223047;
    border-radius: 7px;
    padding: 8px 10px;
    display: flex;
    justify-content: space-between;
  }
  .num-cell b { color: #dce8f8; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 10px;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 9px 10px;
    border-bottom: 1px solid #233249;
  }
  th { color: #9cb0c9; font-weight: 600; }
  .bad-syl { color: #ff9d76; font-weight: 700; }
  .ok-syl { color: #6ee7a8; font-weight: 600; }
  audio { width: 100%; margin-top: 10px; height: 34px; }
</style>
</head>
<body>

<header>
  <div>
    <h1>American Accent Word Lab — Praat-Style Side-by-Side</h1>
    <p>Single-word acoustic comparison: Waveform, 0–8 kHz Spectrogram + F1/F2/F3 Formants, Pitch (F0), Matching Score &amp; Syllable Self-Correction</p>
  </div>
  <a class="back-link" href="/">← Back to Main Lab</a>
</header>

<main>
  <section class="card">
    <div class="controls-row">
      <div>
        <label for="wordInput">Target English Word</label>
        <input id="wordInput" type="text" value="water" placeholder="Type a single word (e.g., water, tracks, three)" />
      </div>
      <div>
        <label for="voiceSelect">Reference Voice</label>
        <select id="voiceSelect">
          <option value="alloy" selected>Alloy (General American)</option>
          <option value="nova">Nova (General American)</option>
          <option value="onyx">Onyx (General American)</option>
        </select>
      </div>
      <div>
        <button id="startBtn" class="record" onclick="startWordRecording()">● Start Recording</button>
      </div>
      <div>
        <button id="stopBtn" class="stop" onclick="stopWordRecording()" disabled>■ Stop &amp; Compare</button>
      </div>
    </div>

    <div class="samples">
      <span style="font-size:12px;color:#8fa3bd;">Quick words:</span>
      <span class="chip" onclick="setWord('water')">water</span>
      <span class="chip" onclick="setWord('tracks')">tracks</span>
      <span class="chip" onclick="setWord('trucks')">trucks</span>
      <span class="chip" onclick="setWord('three')">three</span>
      <span class="chip" onclick="setWord('thirty')">thirty</span>
      <span class="chip" onclick="setWord('emerge')">emerge</span>
      <span class="chip" onclick="setWord('immerse')">immerse</span>
      <span class="chip" onclick="setWord('variation')">variation</span>
    </div>

    <div id="statusMsg" class="status">Enter a word, click <strong>Start Recording</strong>, say the word clearly, then click <strong>Stop &amp; Compare</strong>.</div>
  </section>

  <section id="resultsSection" class="card" hidden>
    <div class="score-banner">
      <div class="kpi">
        <span>Overall Accent Match</span>
        <strong id="overallScore">--%</strong>
      </div>
      <div class="kpi">
        <span>Syllable Count</span>
        <strong id="syllableCount">--</strong>
      </div>
      <div class="kpi">
        <span>Syllable to Self-Correct</span>
        <strong id="focusSyllableTitle">--</strong>
      </div>
      <div class="kpi">
        <span>DTW Acoustic Distance</span>
        <strong id="dtwDist">--</strong>
      </div>
    </div>

    <div id="focusAdvice" class="focus-box"></div>

    <div class="side-by-side" style="margin-top:16px;">
      <div>
        <div class="pane-header">
          <h3>American Reference</h3>
          <button class="secondary" onclick="playEl('refAudio')">▶ Play Ref</button>
        </div>
        <canvas id="refCanvas" class="praat-canvas" width="560" height="330"></canvas>
        <audio id="refAudio" controls></audio>
        <div id="refNums" class="nums-grid"></div>
      </div>

      <div>
        <div class="pane-header">
          <h3>Your Recording (DTW-Aligned)</h3>
          <button class="secondary" onclick="playEl('userAudio')">▶ Play Yours</button>
        </div>
        <canvas id="userCanvas" class="praat-canvas" width="560" height="330"></canvas>
        <audio id="userAudio" controls></audio>
        <div id="userNums" class="nums-grid"></div>
      </div>
    </div>

    <div class="legend">
      <span><strong style="color:#58a6ff;">■</strong> Top Track: Waveform</span>
      <span><strong style="color:#38bdf8;">—</strong> F1 (tongue height)</span>
      <span><strong style="color:#4ade80;">—</strong> F2 (tongue front/back)</span>
      <span><strong style="color:#fb923c;">—</strong> F3 (rhotic /r/ cue)</span>
      <span><strong style="color:#facc15;">—</strong> Pitch F0 (Hz)</span>
    </div>

    <h3 style="margin-top:20px;margin-bottom:6px;">Syllable-by-Syllable Breakdown</h3>
    <table>
      <thead>
        <tr>
          <th>Syllable</th>
          <th>Match</th>
          <th>Duration (You vs Ref)</th>
          <th>F1 / F2 Diff</th>
          <th>Loudness Diff</th>
          <th>Self-Correction Cue</th>
        </tr>
      </thead>
      <tbody id="syllableTableBody"></tbody>
    </table>
  </section>
</main>

<script>
let mediaRecorder = null;
let chunks = [];
let streamRef = null;
let lastResult = null;

function setWord(w) {
  document.getElementById("wordInput").value = w;
}

function playEl(id) {
  const el = document.getElementById(id);
  if (el && el.src) {
    el.currentTime = 0;
    el.play().catch(() => {});
  }
}

async function startWordRecording() {
  const word = document.getElementById("wordInput").value.trim();
  const status = document.getElementById("statusMsg");
  if (!word) {
    status.textContent = "Please type a word first.";
    return;
  }

  try {
    streamRef = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    chunks = [];
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(t =>
      MediaRecorder.isTypeSupported(t)
    );
    mediaRecorder = mime ? new MediaRecorder(streamRef, { mimeType: mime }) : new MediaRecorder(streamRef);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      if (streamRef) {
        streamRef.getTracks().forEach(t => t.stop());
        streamRef = null;
      }
      document.getElementById("startBtn").disabled = false;
      document.getElementById("stopBtn").disabled = true;
      await submitWordComparison(blob, word);
    };

    mediaRecorder.start();
    document.getElementById("startBtn").disabled = true;
    document.getElementById("stopBtn").disabled = false;
    status.textContent = '🔴 Recording "' + word + '"... Click Stop & Compare when finished.';
  } catch (err) {
    status.textContent = "Microphone error: " + err.message;
  }
}

function stopWordRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    document.getElementById("statusMsg").textContent = "Processing audio & computing Praat-style acoustic alignment...";
    mediaRecorder.stop();
  }
}

async function submitWordComparison(blob, word) {
  const status = document.getElementById("statusMsg");
  const voice = document.getElementById("voiceSelect").value;
  try {
    const fd = new FormData();
    fd.append("word", word);
    fd.append("voice", voice);
    fd.append("audio", blob, "word.webm");

    const resp = await fetch("/american-accent/api/compare", { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Comparison failed");

    lastResult = data;
    renderComparison(data);
    status.textContent = 'Compared "' + data.word + '" (' + data.referenceSource + ').';
  } catch (err) {
    status.textContent = "Error: " + err.message;
  }
}

function renderNums(containerId, m) {
  const el = document.getElementById(containerId);
  el.innerHTML = [
    ["Duration", m.durationMs + " ms"],
    ["Pitch (F0)", m.avgF0 ? m.avgF0 + " Hz (" + m.minF0 + "-" + m.maxF0 + ")" : "Unvoiced"],
    ["Formant F1", m.avgF1 + " Hz"],
    ["Formant F2", m.avgF2 + " Hz"],
    ["Formant F3", m.avgF3 + " Hz"],
    ["Peak Level", m.maxDb + " dB"]
  ].map(([k, v]) => '<div class="num-cell"><span>' + k + '</span><b>' + v + '</b></div>').join("");
}

function drawPraatPane(canvasId, metrics, specRows, pitchArr, f1Arr, f2Arr, f3Arr, isUserAligned) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Layout: [0..82] Waveform, [88..248] Spectrogram + Formants, [254..322] Pitch F0
  const waveTop = 8, waveH = 72;
  const specTop = 88, specH = 158;
  const pitchTop = 254, pitchH = 66;

  // 1. Waveform
  ctx.fillStyle = "#0b1019";
  ctx.fillRect(0, waveTop, w, waveH);
  ctx.strokeStyle = "#22324a";
  ctx.beginPath();
  ctx.moveTo(0, waveTop + waveH / 2);
  ctx.lineTo(w, waveTop + waveH / 2);
  ctx.stroke();

  const pts = metrics.wavePoints || [];
  ctx.strokeStyle = isUserAligned ? "#58a6ff" : "#93c5fd";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < pts.length; i++) {
    const x = (i / Math.max(1, pts.length - 1)) * w;
    const [minV, maxV] = pts[i];
    const y1 = waveTop + waveH / 2 - maxV * (waveH * 0.45);
    const y2 = waveTop + waveH / 2 - minV * (waveH * 0.45);
    ctx.beginPath();
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y2);
    ctx.stroke();
  }

  // Syllable boundary markers on waveform (when unwarped metrics exist)
  if (!isUserAligned && Array.isArray(metrics.syllables) && metrics.durationMs > 0) {
    ctx.strokeStyle = "rgba(250, 204, 21, 0.55)";
    ctx.setLineDash([3, 3]);
    metrics.syllables.forEach(s => {
      const sx = (s.startMs / metrics.durationMs) * w;
      ctx.beginPath();
      ctx.moveTo(sx, waveTop);
      ctx.lineTo(sx, specTop + specH);
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  // 2. Spectrogram (0 - 8000 Hz)
  ctx.fillStyle = "#06090f";
  ctx.fillRect(0, specTop, w, specH);
  const cols = specRows.length;
  if (cols > 0) {
    const rows = specRows[0].length;
    const colW = w / cols;
    const rowH = specH / rows;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const val = specRows[c][r] || 0;
        const lum = Math.round(val * 220);
        ctx.fillStyle = "rgb(" + Math.round(lum * 0.55) + "," + Math.round(lum * 0.8) + "," + lum + ")";
        const y = specTop + specH - (r + 1) * rowH;
        ctx.fillRect(c * colW, y, Math.ceil(colW + 0.5), Math.ceil(rowH + 0.5));
      }
    }

    // Formant tracks F1 (cyan), F2 (green), F3 (orange) mapped over 0..8000 Hz
    const hzToY = hz => specTop + specH - Math.max(0, Math.min(1, hz / 8000)) * specH;
    const drawContour = (arr, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      let started = false;
      for (let c = 0; c < arr.length; c++) {
        const val = arr[c];
        if (typeof val !== "number") { started = false; continue; }
        const x = ((c + 0.5) / Math.max(1, arr.length)) * w;
        const y = hzToY(val);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawContour(f1Arr, "#38bdf8", 2);
    drawContour(f2Arr, "#4ade80", 2);
    drawContour(f3Arr, "#fb923c", 1.6);
  }

  // 3. Pitch F0 Contour (75 - 400 Hz)
  ctx.fillStyle = "#0b1019";
  ctx.fillRect(0, pitchTop, w, pitchH);
  ctx.strokeStyle = "#facc15";
  ctx.lineWidth = 2;
  ctx.beginPath();
  let pStarted = false;
  for (let i = 0; i < pitchArr.length; i++) {
    const f0 = pitchArr[i];
    if (typeof f0 !== "number") { pStarted = false; continue; }
    const x = ((i + 0.5) / Math.max(1, pitchArr.length)) * w;
    const norm = Math.max(0, Math.min(1, (f0 - 75) / 325));
    const y = pitchTop + pitchH - 6 - norm * (pitchH - 12);
    if (!pStarted) { ctx.moveTo(x, y); pStarted = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function renderComparison(data) {
  document.getElementById("resultsSection").hidden = false;
  const comp = data.comparison;
  const vis = comp.alignedVisuals;

  document.getElementById("overallScore").textContent = comp.overallScore + "%";
  document.getElementById("syllableCount").textContent = String(comp.syllableCount);
  document.getElementById("focusSyllableTitle").textContent = comp.focusSyllable
    ? comp.focusSyllable.label
    : "All Good";
  document.getElementById("dtwDist").textContent = String(comp.avgDtwDistance);

  document.getElementById("focusAdvice").innerHTML = comp.focusSyllable
    ? "<strong>Where to self-correct:</strong> Focus on <strong>" +
      comp.focusSyllable.label +
      "</strong> (Match: " +
      comp.focusSyllable.matchScore +
      "%). " +
      comp.focusSyllable.tip
    : "No syllable-level discrepancy detected.";

  document.getElementById("refAudio").src = data.referenceAudioUrl;
  document.getElementById("userAudio").src = data.userAudioUrl;

  renderNums("refNums", data.referenceMetrics);
  renderNums("userNums", data.userMetrics);

  drawPraatPane(
    "refCanvas",
    data.referenceMetrics,
    vis.alignedRefSpec,
    vis.alignedRefPitch,
    vis.alignedRefF1,
    vis.alignedRefF2,
    vis.alignedRefF3,
    false
  );

  drawPraatPane(
    "userCanvas",
    data.userMetrics,
    vis.alignedUserSpec,
    vis.alignedUserPitch,
    vis.alignedUserF1,
    vis.alignedUserF2,
    vis.alignedUserF3,
    true
  );

  const tbody = document.getElementById("syllableTableBody");
  const worstNum = comp.focusSyllable ? comp.focusSyllable.syllableNumber : -1;

  tbody.innerHTML = comp.syllableComparisons.map(s => {
    const isWorst = s.syllableNumber === worstNum && s.matchScore < 85;
    return "<tr>" +
      "<td class='" + (isWorst ? "bad-syl" : "ok-syl") + "'>" + s.label + "</td>" +
      "<td class='" + (isWorst ? "bad-syl" : "ok-syl") + "'>" + s.matchScore + "% (" + s.status + ")</td>" +
      "<td>" + s.userDurationMs + " ms vs " + s.refDurationMs + " ms</td>" +
      "<td>ΔF1 " + s.f1DiffHz + " Hz / ΔF2 " + s.f2DiffHz + " Hz</td>" +
      "<td>Δ" + s.dbDiff + " dB</td>" +
      "<td>" + s.tip + "</td>" +
      "</tr>";
  }).join("");
}
</script>
</body>
</html>`);
});

module.exports = router;
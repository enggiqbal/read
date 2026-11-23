// accent-dsp.js
// Audio decoding, voiced-nucleus detection, pitch (F0), formants (F1/F2/F3), spectrogram, and DTW alignment.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

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
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
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

  if (sampleRate === 16000) return rawMono;

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
      "-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", tempWav
    ]);
    const wavBytes = await fs.promises.readFile(tempWav);
    return decodeWavBuffer(wavBytes);
  } catch (_) {
    const raw = await fs.promises.readFile(filePath);
    return decodeWavBuffer(raw);
  } finally {
    await fs.promises.unlink(tempWav).catch(() => {});
  }
}

function trimSilence(samples, sampleRate = 16000, threshold = 0.02, padMs = 60) {
  if (!samples || samples.length === 0) return new Float32Array(1600);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-5) return samples.slice(0, Math.min(samples.length, sampleRate));

  const thresh = Math.max(threshold, peak * 0.09);
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

function estimatePitchFrame(frame, sampleRate) {
  let rms = 0;
  let zeroCrossings = 0;
  for (let i = 0; i < frame.length; i++) {
    rms += frame[i] * frame[i];
    if (i > 0 && ((frame[i - 1] >= 0 && frame[i] < 0) || (frame[i - 1] < 0 && frame[i] >= 0))) {
      zeroCrossings++;
    }
  }
  rms = Math.sqrt(rms / frame.length);
  const zcr = zeroCrossings / frame.length;
  // Unvoiced fricatives (/s/, /ʃ/, /θ/) have high ZCR and low periodicity
  if (rms < 0.018 || zcr > 0.38) return { f0: null, periodicity: 0, zcr, rms };

  const minLag = Math.floor(sampleRate / 420);
  const maxLag = Math.min(frame.length - 2, Math.floor(sampleRate / 75));
  if (maxLag <= minLag) return { f0: null, periodicity: 0, zcr, rms };

  let bestLag = -1;
  let bestCorr = 0;
  let energy0 = 0;
  for (let i = 0; i < frame.length; i++) energy0 += frame[i] * frame[i];
  if (energy0 < 1e-8) return { f0: null, periodicity: 0, zcr, rms };

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

  if (bestLag > 0 && bestCorr >= 0.48) {
    return { f0: sampleRate / bestLag, periodicity: bestCorr, zcr, rms };
  }
  return { f0: null, periodicity: bestCorr, zcr, rms };
}

function computeSpectrumAndFormants(frame, sampleRate = 16000, numBins = 96) {
  const N = frame.length;
  const mags = new Float32Array(numBins);

  // Pre-emphasis to sharpen F1/F2/F3 vocal tract resonances
  const pre = new Float32Array(N);
  pre[0] = frame[0];
  for (let i = 1; i < N; i++) {
    pre[i] = frame[i] - 0.95 * frame[i - 1];
  }

  for (let k = 0; k < numBins; k++) {
    const freq = (k / numBins) * (sampleRate / 2);
    const omega = (2 * Math.PI * freq) / sampleRate;
    let re = 0;
    let im = 0;
    const step = N > 512 ? 2 : 1;
    for (let n = 0; n < N; n += step) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / Math.max(1, N - 1));
      const x = pre[n] * win;
      re += x * Math.cos(omega * n);
      im -= x * Math.sin(omega * n);
    }
    mags[k] = Math.sqrt(re * re + im * im) / Math.max(1, N / step);
  }

  const env = new Float32Array(numBins);
  for (let k = 0; k < numBins; k++) {
    const lo = Math.max(0, k - 2);
    const hi = Math.min(numBins - 1, k + 2);
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
      if (env[k] >= env[k - 1] && env[k] >= env[k + 1] && env[k] > bestVal) {
        bestVal = env[k];
        bestBin = k;
      }
    }
    if (bestBin < 0) {
      for (let k = lo; k <= hi; k++) {
        if (env[k] > bestVal) {
          bestVal = env[k];
          bestBin = k;
        }
      }
    }
    return bestBin > 0 && bestVal > 1e-6 ? Math.round(binToHz(bestBin)) : fallbackHz;
  }

  const f1 = peakInBand(260, 880, 500);
  const f2 = Math.max(f1 + 320, peakInBand(820, 2550, 1500));
  const f3 = Math.max(f2 + 350, peakInBand(1750, 3500, 2550));

  const normRow = Array.from(mags).map(m => {
    const db = 20 * Math.log10(Math.max(m, 1e-6));
    return Math.max(0, Math.min(1, (db + 75) / 55));
  });

  // 13-band spectral envelope vector for DTW
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

function analyzeSignal(samples, sampleRate = 16000) {
  const frameLen = Math.round(0.025 * sampleRate); // 25 ms
  const hopLen = Math.round(0.010 * sampleRate);   // 10 ms hop for crisp phoneme boundaries
  const numFrames = Math.max(1, Math.floor((samples.length - frameLen) / hopLen) + 1);

  const pitchHz = [];
  const isVoicedFrame = [];
  const periodicity = [];
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

    const pInfo = estimatePitchFrame(frame, sampleRate);
    const voiced = Boolean(pInfo.f0);
    isVoicedFrame.push(voiced);
    periodicity.push(Number(pInfo.periodicity.toFixed(2)));
    pitchHz.push(voiced ? Math.round(pInfo.f0) : null);

    const spec = computeSpectrumAndFormants(frame, sampleRate, 96);
    // Only record formants on voiced frames so unvoiced noise/silence never corrupts F1/F2/F3
    f1Hz.push(voiced ? spec.f1 : null);
    f2Hz.push(voiced ? spec.f2 : null);
    f3Hz.push(voiced ? spec.f3 : null);
    spectrogram.push(spec.normRow);
    mfccFrames.push(spec.mfcc);
  }

  // Waveform envelope (200 points)
  const wavePoints = [];
  const targetWaveLen = 200;
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

  const voicedPitch = pitchHz.filter(v => typeof v === "number");
  const validF1 = f1Hz.filter(v => typeof v === "number");
  const validF2 = f2Hz.filter(v => typeof v === "number");
  const validF3 = f3Hz.filter(v => typeof v === "number");

  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

  return {
    sampleRate,
    hopMs: 10,
    numFrames,
    durationMs: Math.round((samples.length / sampleRate) * 1000),
    avgF0: avg(voicedPitch),
    minF0: voicedPitch.length ? Math.min(...voicedPitch) : 0,
    maxF0: voicedPitch.length ? Math.max(...voicedPitch) : 0,
    avgF1: avg(validF1) || 500,
    avgF2: avg(validF2) || 1500,
    avgF3: avg(validF3) || 2550,
    maxDb: Number(Math.max(...intensityDb).toFixed(1)),
    wavePoints,
    pitchHz,
    isVoicedFrame,
    periodicity,
    intensityDb,
    f1Hz,
    f2Hz,
    f3Hz,
    spectrogram,
    mfccFrames
  };
}

function euclidean(a, b) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / Math.max(1, len));
}

function computeDtwPath(refAnalysis, userAnalysis) {
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
  return { pathPairs, avgDtwDistance };
}

module.exports = {
  encodeWav16kMono,
  decodeWavBuffer,
  decodeUploadedAudioTo16kMono,
  trimSilence,
  normalizePeak,
  analyzeSignal,
  computeDtwPath
};
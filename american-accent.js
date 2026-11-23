// american-accent.js
// Express router & interactive Praat + Vowel Quadrilateral self-correction UI.

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const multer = require("multer");

const { getWordPhoneticPlan } = require("./accent-phonetics");
const {
  encodeWav16kMono,
  decodeWavBuffer,
  decodeUploadedAudioTo16kMono,
  trimSilence,
  normalizePeak,
  analyzeSignal,
  computeDtwPath
} = require("./accent-dsp");
const { runFullDiagnosis } = require("./accent-diagnostics");

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

function synthesizeFallbackReferenceWord(phoneticPlan, sampleRate = 16000) {
  const syls = phoneticPlan.syllables;
  const sylDurSec = 0.23;
  const totalSec = Math.max(0.35, syls.length * sylDurSec + 0.06);
  const totalSamples = Math.round(totalSec * sampleRate);
  const out = new Float32Array(totalSamples);

  syls.forEach((syl, sIdx) => {
    const startIdx = Math.floor(sIdx * sylDurSec * sampleRate);
    const endIdx = Math.min(totalSamples, Math.floor((sIdx + 1) * sylDurSec * sampleRate));
    const len = Math.max(1, endIdx - startIdx);
    const isStressed = syl.stress === 1;
    const vm = syl.vowelMeta || { f1: 500, f2: 1500 };
    const baseF0 = isStressed ? 165 : 135;
    const amp = isStressed ? 0.78 : 0.48;

    for (let i = 0; i < len; i++) {
      const progress = i / len;
      const t = i / sampleRate;
      const env = Math.sin(Math.PI * Math.min(1, progress));
      const f0 = baseF0 * (1 - 0.12 * progress);
      const f1 = vm.diphthong && vm.endF1 ? vm.f1 + (vm.endF1 - vm.f1) * progress : vm.f1;
      const f2 = vm.diphthong && vm.endF2 ? vm.f2 + (vm.endF2 - vm.f2) * progress : vm.f2;
      const f3 = phoneticPlan.hasRhotic ? 1850 : 2580;

      const phase = 2 * Math.PI * f0 * t;
      const pulse = Math.sin(phase) + 0.55 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase);
      const formants =
        0.52 * Math.sin(2 * Math.PI * f1 * t) +
        0.32 * Math.sin(2 * Math.PI * f2 * t) +
        0.16 * Math.sin(2 * Math.PI * f3 * t);

      out[startIdx + i] = (pulse * 0.45 + formants) * env * amp;
    }
  });

  return normalizePeak(trimSilence(out, sampleRate), 0.85);
}


const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const BANK_DIR = path.join(DATA_DIR, "accent-ref-bank");
fs.mkdirSync(BANK_DIR, { recursive: true });

async function synthesizeOfflineWordTo16kMono(cleanWord, voice = "Samantha") {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rawOutPath = path.join(os.tmpdir(), `offline-ref-${stamp}`);
  const cleanupPaths = [rawOutPath];

  try {
    if (process.platform === "darwin") {
      const aiffPath = `${rawOutPath}.aiff`;
      cleanupPaths.push(aiffPath);
      const macVoice = ["Samantha", "Alex", "Allison", "Ava"].includes(voice) ? voice : "Samantha";
      await execFileAsync("say", ["-v", macVoice, "-o", aiffPath, cleanWord]);
      const decoded = await decodeUploadedAudioTo16kMono(aiffPath);
      return {
        samples: normalizePeak(trimSilence(decoded, 16000), 0.85),
        source: `offline-macos-say (${macVoice})`
      };
    }

    if (process.platform === "win32") {
      const psWavPath = `${rawOutPath}.wav`;
      cleanupPaths.push(psWavPath);
      const safeWord = cleanWord.replace(/'/g, "''");
      const psScript = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.SetOutputToWaveFile('${psWavPath.replace(/'/g, "''")}'); $s.Speak('${safeWord}'); $s.Dispose();`;
      await execFileAsync("powershell", ["-NoProfile", "-Command", psScript]);
      const decoded = await decodeUploadedAudioTo16kMono(psWavPath);
      return {
        samples: normalizePeak(trimSilence(decoded, 16000), 0.85),
        source: "offline-windows-sapi"
      };
    }

    // Linux: prefer piper if available, otherwise espeak-ng
    const linuxWavPath = `${rawOutPath}.wav`;
    cleanupPaths.push(linuxWavPath);
    if (process.env.PIPER_MODEL) {
      await execFileAsync("sh", [
        "-c",
        `printf %s "$1" | piper --model "$2" --output_file "$3"`,
        "--",
        cleanWord,
        process.env.PIPER_MODEL,
        linuxWavPath
      ]);
      const decoded = await decodeUploadedAudioTo16kMono(linuxWavPath);
      return {
        samples: normalizePeak(trimSilence(decoded, 16000), 0.85),
        source: "offline-piper-tts"
      };
    }

    await execFileAsync("espeak-ng", ["-v", "en-us", "-w", linuxWavPath, cleanWord]);
    const decoded = await decodeUploadedAudioTo16kMono(linuxWavPath);
    return {
      samples: normalizePeak(trimSilence(decoded, 16000), 0.85),
      source: "offline-espeak-ng (en-us)"
    };
  } finally {
    await Promise.all(cleanupPaths.map(p => fs.promises.unlink(p).catch(() => {})));
  }
}

async function getAmericanReferenceSamples(word, voice = "Samantha", phoneticPlan) {
  const cleanWord = String(word || "").trim().toLowerCase();
  const safeSlug = cleanWord.replace(/[^a-z0-9_-]/g, "_");
  const hash = crypto
    .createHash("sha256")
    .update(`offline-en-US:${voice}:${cleanWord}`)
    .digest("hex")
    .slice(0, 16);

  const cachedWavPath = path.join(REF_DIR, `ref-${hash}.wav`);
  const publicUrl = `/american-accent/audio/ref/ref-${hash}.wav`;

  if (fs.existsSync(cachedWavPath)) {
    const buf = await fs.promises.readFile(cachedWavPath);
    return {
      samples: decodeWavBuffer(buf),
      audioUrl: publicUrl,
      source: `cached-offline-ref (${voice})`
    };
  }

  // 1. Check pre-recorded local bank files first (e.g., data/accent-ref-bank/pronunciation.wav)
  const bankCandidates = [".wav", ".mp3", ".m4a", ".ogg", ".webm"].map(ext =>
    path.join(BANK_DIR, `${safeSlug}${ext}`)
  );
  const existingBankFile = bankCandidates.find(p => fs.existsSync(p));
  if (existingBankFile) {
    const decoded = await decodeUploadedAudioTo16kMono(existingBankFile);
    const trimmed = normalizePeak(trimSilence(decoded, 16000), 0.85);
    await fs.promises.writeFile(cachedWavPath, encodeWav16kMono(trimmed));
    return {
      samples: trimmed,
      audioUrl: publicUrl,
      source: `local-audio-bank (${path.basename(existingBankFile)})`
    };
  }

  // 2. Synthesize offline using local OS TTS + ffmpeg pipeline (no API calls)
  const offlineRes = await synthesizeOfflineWordTo16kMono(cleanWord, voice);
  await fs.promises.writeFile(cachedWavPath, encodeWav16kMono(offlineRes.samples));
  return {
    samples: offlineRes.samples,
    audioUrl: publicUrl,
    source: offlineRes.source
  };
}


router.use("/audio/ref", express.static(REF_DIR));
router.use("/audio/user", express.static(USER_DIR));

router.post("/api/compare", upload.single("audio"), async (req, res) => {
  try {
    const word = String(req.body && req.body.word ? req.body.word : "").trim();
    const voice = String(req.body && req.body.voice ? req.body.voice : "alloy").trim();

    if (!word) return res.status(400).json({ error: "Please enter a target word." });
    if (!req.file) return res.status(400).json({ error: "Please record your pronunciation first." });

    const phoneticPlan = getWordPhoneticPlan(word);

    const rawUser = await decodeUploadedAudioTo16kMono(req.file.path);
    const cleanUser = normalizePeak(trimSilence(rawUser, 16000), 0.85);

    const userId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const userWavName = "user-" + userId + ".wav";
    await fs.promises.writeFile(path.join(USER_DIR, userWavName), encodeWav16kMono(cleanUser));

    const ref = await getAmericanReferenceSamples(word, voice, phoneticPlan);

    const referenceAnalysis = analyzeSignal(ref.samples, 16000);
    const userAnalysis = analyzeSignal(cleanUser, 16000);
    const dtwResult = computeDtwPath(referenceAnalysis, userAnalysis);
    const comparison = runFullDiagnosis(phoneticPlan, referenceAnalysis, userAnalysis, dtwResult);

    return res.json({
      success: true,
      word: word,
      ipa: phoneticPlan.ipa,
      referenceSource: ref.source,
      referenceAudioUrl: ref.audioUrl,
      userAudioUrl: "/american-accent/audio/user/" + userWavName,
      referenceMetrics: {
        durationMs: referenceAnalysis.durationMs,
        avgF0: referenceAnalysis.avgF0,
        minF0: referenceAnalysis.minF0,
        maxF0: referenceAnalysis.maxF0,
        avgF1: referenceAnalysis.avgF1,
        avgF2: referenceAnalysis.avgF2,
        avgF3: referenceAnalysis.avgF3,
        maxDb: referenceAnalysis.maxDb,
        wavePoints: referenceAnalysis.wavePoints
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
        wavePoints: userAnalysis.wavePoints
      },
      comparison: comparison
    });
  } catch (err) {
    console.error("Word accent comparison error:", err);
    return res.status(500).json({ error: "Failed to compare word pronunciation.", details: err.message });
  } finally {
    if (req.file && req.file.path) {
      await fs.promises.unlink(req.file.path).catch(function () {});
    }
  }
});

router.get(["/", ""], function (req, res) {
  res.type("html").send(
    "<!DOCTYPE html>" +
    "<html lang=\"en\">" +
    "<head>" +
    "<meta charset=\"UTF-8\" />" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />" +
    "<title>American Accent Diagnostic Lab</title>" +
    "<style>" +
    "  * { box-sizing: border-box; }" +
    "  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif; background: #0d131c; color: #e6edf5; }" +
    "  header { background: #151f2e; border-bottom: 1px solid #28384f; padding: 16px 24px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }" +
    "  header h1 { margin: 0; font-size: 19px; }" +
    "  header p { margin: 4px 0 0; color: #9fb0c7; font-size: 13px; }" +
    "  a.back-link { color: #8cc2ff; text-decoration: none; font-size: 13px; border: 1px solid #355075; padding: 7px 12px; border-radius: 6px; }" +
    "  main { max-width: 1280px; margin: 20px auto; padding: 0 18px 60px; }" +
    "  .card { background: #141d2b; border: 1px solid #26354b; border-radius: 12px; padding: 18px; margin-bottom: 18px; }" +
    "  .controls-row { display: grid; grid-template-columns: 1.4fr 0.8fr auto auto; gap: 12px; align-items: end; }" +
    "  @media (max-width: 820px) { .controls-row { grid-template-columns: 1fr; } }" +
    "  label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #9fb0c7; margin-bottom: 6px; }" +
    "  input[type=\"text\"], select { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #334663; background: #0c121b; color: #f0f5fb; font-size: 15px; }" +
    "  button { padding: 10px 15px; border-radius: 8px; border: 0; font-weight: 600; font-size: 13px; cursor: pointer; background: #2b7de9; color: #fff; }" +
    "  button.record { background: #d64545; }" +
    "  button.stop { background: #22a06b; }" +
    "  button.secondary { background: #223147; color: #dce7f5; border: 1px solid #334866; }" +
    "  button.secondary:hover { background: #2b3e59; }" +
    "  button:disabled { opacity: 0.45; cursor: not-allowed; }" +
    "  .samples { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }" +
    "  .chip { background: #1f2e45; color: #b9d2f2; border: 1px solid #32496b; padding: 4px 10px; border-radius: 999px; font-size: 12px; cursor: pointer; }" +
    "  .chip:hover { background: #2d4261; }" +
    "  .status { margin-top: 10px; font-size: 13px; color: #b7c8de; }" +
    "  .score-banner { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }" +
    "  @media (max-width: 780px) { .score-banner { grid-template-columns: repeat(2, 1fr); } }" +
    "  .kpi { background: #0e1520; border: 1px solid #243349; border-radius: 10px; padding: 13px; }" +
    "  .kpi span { font-size: 11px; text-transform: uppercase; color: #93a6bf; display: block; }" +
    "  .kpi strong { font-size: 22px; margin-top: 4px; display: block; color: #7cc0ff; }" +
    "  .focus-box { margin-top: 14px; background: #271b10; border: 1px solid #96601a; border-radius: 10px; padding: 13px 15px; color: #ffe0ad; font-size: 14px; line-height: 1.5; }" +
    "  .phoneme-strip { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; align-items: center; }" +
    "  .ph-pill { background: #121c2b; border: 1px solid #2f4361; border-radius: 8px; padding: 7px 11px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 13px; }" +
    "  .ph-pill:hover { border-color: #60a5fa; background: #19273c; }" +
    "  .ph-pill.active { border-color: #facc15; background: #282414; box-shadow: 0 0 0 1px #facc15; }" +
    "  .ph-pill.vowel { border-left: 3px solid #38bdf8; }" +
    "  .ph-pill.consonant { border-left: 3px solid #a78bfa; }" +
    "  .ph-badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 700; }" +
    "  .badge-good { background: rgba(34, 197, 94, 0.18); color: #6ee7b7; }" +
    "  .badge-mid { background: rgba(250, 204, 21, 0.18); color: #fde047; }" +
    "  .badge-bad { background: rgba(248, 113, 113, 0.22); color: #fca5a5; }" +
    "  .side-by-side { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }" +
    "  @media (max-width: 920px) { .side-by-side { grid-template-columns: 1fr; } }" +
    "  .pane-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }" +
    "  .pane-header h3 { margin: 0; font-size: 15px; }" +
    "  canvas.praat-canvas { width: 100%; height: 330px; background: #080c12; border: 1px solid #24334a; border-radius: 8px; display: block; }" +
    "  canvas.vowel-canvas { width: 100%; height: 340px; background: #0a1019; border: 1px solid #26364f; border-radius: 10px; display: block; }" +
    "  .legend { margin-top: 10px; font-size: 12px; color: #9cb0c9; display: flex; flex-wrap: wrap; gap: 14px; }" +
    "  .nums-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; font-size: 12px; }" +
    "  .num-cell { background: #0e1520; border: 1px solid #223047; border-radius: 7px; padding: 7px 9px; display: flex; justify-content: space-between; }" +
    "  .num-cell b { color: #dce8f8; }" +
    "  table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }" +
    "  th, td { text-align: left; padding: 10px; border-bottom: 1px solid #233249; vertical-align: top; }" +
    "  th { color: #9cb0c9; font-weight: 600; font-size: 12px; text-transform: uppercase; }" +
    "  tr.clickable-row { cursor: pointer; }" +
    "  tr.clickable-row:hover { background: #1b2638; }" +
    "  .bad-syl { color: #ff9d76; font-weight: 700; }" +
    "  .ok-syl { color: #6ee7a8; font-weight: 600; }" +
    "  audio { width: 100%; margin-top: 8px; height: 32px; }" +
    "</style>" +
    "</head>" +
    "<body>" +
    "<header>" +
    "  <div>" +
    "    <h1>American Accent Diagnostic Lab</h1>" +
    "    <p>Phoneme-Level Acoustic Diagnosis, Tongue Position F1/F2 Charts, Interactive Segment Playback &amp; Articulatory Coaching</p>" +
    "  </div>" +
    "  <a class=\"back-link\" href=\"/\">&larr; Back to Main Lab</a>" +
    "</header>" +
    "<main>" +
    "  <section class=\"card\">" +
    "    <div class=\"controls-row\">" +
    "      <div>" +
    "        <label for=\"wordInput\">Target English Word</label>" +
    "        <input id=\"wordInput\" type=\"text\" value=\"web\" placeholder=\"Type a single word (e.g., web, water, pronunciation)\" />" +
    "      </div>" +
    "      <div>" +
    "        <label for=\"voiceSelect\">Reference Voice</label>" +
    "        <select id=\"voiceSelect\">" +
    "          <option value=\"nova\" selected>Nova (General American)</option>" +
    "          <option value=\"alloy\">Alloy (General American)</option>" +
    "          <option value=\"onyx\">Onyx (General American)</option>" +
    "        </select>" +
    "      </div>" +
    "      <div>" +
    "        <button id=\"startBtn\" type=\"button\" class=\"record\">&#9679; Start Recording</button>" +
    "      </div>" +
    "      <div>" +
    "        <button id=\"stopBtn\" type=\"button\" class=\"stop\" disabled>&#9632; Stop &amp; Diagnose</button>" +
    "      </div>" +
    "    </div>" +
    "    <div id=\"sampleChips\" class=\"samples\">" +
    "      <span style=\"font-size:12px;color:#8fa3bd;\">Quick words:</span>" +
    "      <span class=\"chip\" data-word=\"web\">web</span>" +
    "      <span class=\"chip\" data-word=\"water\">water</span>" +
    "      <span class=\"chip\" data-word=\"tracks\">tracks</span>" +
    "      <span class=\"chip\" data-word=\"trucks\">trucks</span>" +
    "      <span class=\"chip\" data-word=\"three\">three</span>" +
    "      <span class=\"chip\" data-word=\"thirty\">thirty</span>" +
    "      <span class=\"chip\" data-word=\"emerge\">emerge</span>" +
    "      <span class=\"chip\" data-word=\"immerse\">immerse</span>" +
    "      <span class=\"chip\" data-word=\"variation\">variation</span>" +
    "      <span class=\"chip\" data-word=\"pronunciation\">pronunciation</span>" +
    "    </div>" +
    "    <div id=\"statusMsg\" class=\"status\">Enter a word, click <strong>Start Recording</strong>, say the word clearly, then click <strong>Stop &amp; Diagnose</strong>.</div>" +
    "  </section>" +
    "  <section id=\"resultsSection\" hidden>" +
    "    <div class=\"card\">" +
    "      <div class=\"score-banner\">" +
    "        <div class=\"kpi\"><span>Overall Accent Match</span><strong id=\"overallScore\">--%</strong></div>" +
    "        <div class=\"kpi\"><span>Target IPA &amp; Syllables</span><strong id=\"ipaAndSyl\">--</strong></div>" +
    "        <div class=\"kpi\"><span>Exact Sound to Correct</span><strong id=\"focusSoundTitle\">--</strong></div>" +
    "        <div class=\"kpi\"><span>DTW Spectral Distance</span><strong id=\"dtwDist\">--</strong></div>" +
    "      </div>" +
    "      <div id=\"focusAdvice\" class=\"focus-box\"></div>" +
    "      <div style=\"margin-top:14px;\">" +
    "        <span style=\"font-size:12px;color:#9fb0c7;\"><strong>Interactive Phoneme Map</strong> (Click any sound to highlight it on both spectrograms and hear Reference vs. Your segment):</span>" +
    "        <div id=\"phonemeStrip\" class=\"phoneme-strip\"></div>" +
    "        <div id=\"segmentPlayerBar\" style=\"margin-top:10px;display:none;gap:8px;align-items:center;flex-wrap:wrap;\">" +
    "          <span id=\"selectedPhLabel\" style=\"font-size:13px;color:#fde047;font-weight:600;\"></span>" +
    "          <button id=\"playRefSegBtn\" type=\"button\" class=\"secondary\">&#9654; Hear Reference Sound</button>" +
    "          <button id=\"playUserSegBtn\" type=\"button\" class=\"secondary\">&#9654; Hear Your Sound</button>" +
    "          <button id=\"clearSegBtn\" type=\"button\" class=\"secondary\">Clear Highlight</button>" +
    "        </div>" +
    "      </div>" +
    "    </div>" +
    "    <div class=\"card\">" +
    "      <h3 style=\"margin:0 0 4px;\">Tongue &amp; Jaw Position Charts (F1 / F2 Vowel Space)</h3>" +
    "      <p style=\"margin:0 0 14px;font-size:13px;color:#9fb0c7;\">Compares where each syllable's vowel should be articulated in General American (left) vs. where your tongue/jaw actually placed it (right). Curved arrows show diphthong glides.</p>" +
    "      <div class=\"side-by-side\">" +
    "        <div><div class=\"pane-header\"><h3>American Reference Tongue Target</h3></div><canvas id=\"refVowelCanvas\" class=\"vowel-canvas\" width=\"560\" height=\"340\"></canvas></div>" +
    "        <div><div class=\"pane-header\"><h3>Your Tongue &amp; Jaw Placement</h3></div><canvas id=\"userVowelCanvas\" class=\"vowel-canvas\" width=\"560\" height=\"340\"></canvas></div>" +
    "      </div>" +
    "    </div>" +
    "    <div class=\"card\">" +
    "      <div class=\"side-by-side\">" +
    "        <div>" +
    "          <div class=\"pane-header\"><h3>American Reference Acoustic Track</h3><button id=\"playRefFullBtn\" type=\"button\" class=\"secondary\">&#9654; Play Full Ref</button></div>" +
    "          <canvas id=\"refCanvas\" class=\"praat-canvas\" width=\"560\" height=\"330\"></canvas>" +
    "          <audio id=\"refAudio\" controls></audio>" +
    "          <div id=\"refNums\" class=\"nums-grid\"></div>" +
    "        </div>" +
    "        <div>" +
    "          <div class=\"pane-header\"><h3>Your Recording (DTW-Aligned)</h3><button id=\"playUserFullBtn\" type=\"button\" class=\"secondary\">&#9654; Play Full Yours</button></div>" +
    "          <canvas id=\"userCanvas\" class=\"praat-canvas\" width=\"560\" height=\"330\"></canvas>" +
    "          <audio id=\"userAudio\" controls></audio>" +
    "          <div id=\"userNums\" class=\"nums-grid\"></div>" +
    "        </div>" +
    "      </div>" +
    "      <div id=\"dynamicLegend\" class=\"legend\"></div>" +
    "    </div>" +
    "    <div class=\"card\">" +
    "      <h3 style=\"margin:0 0 6px;\">Phoneme-by-Phoneme Articulatory Diagnosis</h3>" +
    "      <p style=\"margin:0 0 8px;font-size:12px;color:#9fb0c7;\">Click any row to highlight that phoneme on the spectrograms and compare its isolated audio.</p>" +
    "      <table>" +
    "        <thead>" +
    "          <tr><th>Syllable</th><th>Sound</th><th>Category</th><th>Match</th><th>Vowel Formants (You vs Ref)</th><th>Duration</th><th>How to Move Tongue, Jaw &amp; Lips</th></tr>" +
    "        </thead>" +
    "        <tbody id=\"phonemeTableBody\"></tbody>" +
    "      </table>" +
    "    </div>" +
    "  </section>" +
    "</main>" +
    "<script>" +
    "var mediaRecorder = null;" +
    "var chunks = [];" +
    "var streamRef = null;" +
    "var lastResult = null;" +
    "var selectedPhonemeId = null;" +
    "var audioCtx = null;" +
    "var decodedRefBuf = null;" +
    "var decodedUserBuf = null;" +

    "function playEl(id) {" +
    "  var el = document.getElementById(id);" +
    "  if (el && el.src) { el.currentTime = 0; el.play().catch(function () {}); }" +
    "}" +

    "function decodeUrlToAudioBuffer(url) {" +
    "  var AC = window.AudioContext || window.webkitAudioContext;" +
    "  if (!audioCtx && AC) audioCtx = new AC();" +
    "  if (!audioCtx) return Promise.resolve(null);" +
    "  return fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (b) { return audioCtx.decodeAudioData(b); });" +
    "}" +

    "function playSlice(buffer, startMs, endMs) {" +
    "  if (!buffer) return;" +
    "  var AC = window.AudioContext || window.webkitAudioContext;" +
    "  if (!audioCtx && AC) audioCtx = new AC();" +
    "  if (!audioCtx) return;" +
    "  if (audioCtx.state === \"suspended\") audioCtx.resume();" +
    "  var padSec = 0.025;" +
    "  var startSec = Math.max(0, startMs / 1000 - padSec);" +
    "  var endSec = Math.min(buffer.duration, endMs / 1000 + padSec);" +
    "  var durSec = Math.max(0.06, endSec - startSec);" +
    "  var src = audioCtx.createBufferSource();" +
    "  src.buffer = buffer;" +
    "  src.connect(audioCtx.destination);" +
    "  src.start(0, startSec, durSec);" +
    "}" +

    "function playSelectedSegment(who) {" +
    "  if (!lastResult || !selectedPhonemeId) return;" +
    "  var list = lastResult.comparison.phonemeDiagnostics || [];" +
    "  var ph = list.find(function (p) { return p.id === selectedPhonemeId; });" +
    "  if (!ph) return;" +
    "  if (who === \"ref\") playSlice(decodedRefBuf, ph.refStartMs, ph.refEndMs);" +
    "  else playSlice(decodedUserBuf, ph.userStartMs, ph.userEndMs);" +
    "}" +

    "function selectPhoneme(phId) {" +
    "  selectedPhonemeId = phId;" +
    "  if (!lastResult) return;" +
    "  document.querySelectorAll(\".ph-pill\").forEach(function (el) {" +
    "    el.classList.toggle(\"active\", el.dataset.phId === phId);" +
    "  });" +
    "  var list = lastResult.comparison.phonemeDiagnostics || [];" +
    "  var ph = list.find(function (p) { return p.id === phId; });" +
    "  var bar = document.getElementById(\"segmentPlayerBar\");" +
    "  if (ph) {" +
    "    bar.style.display = \"flex\";" +
    "    document.getElementById(\"selectedPhLabel\").textContent = \"Selected: \" + ph.ipa + \" in '\" + ph.syllableText + \"' (\" + ph.type + \")\";" +
    "  }" +
    "  redrawPraatCanvases();" +
    "}" +

    "function clearPhonemeSelection() {" +
    "  selectedPhonemeId = null;" +
    "  document.querySelectorAll(\".ph-pill\").forEach(function (el) { el.classList.remove(\"active\"); });" +
    "  document.getElementById(\"segmentPlayerBar\").style.display = \"none\";" +
    "  redrawPraatCanvases();" +
    "}" +

    "async function startWordRecording() {" +
    "  var word = document.getElementById(\"wordInput\").value.trim();" +
    "  var status = document.getElementById(\"statusMsg\");" +
    "  if (!word) { status.textContent = \"Please type a word first.\"; return; }" +
    "  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {" +
    "    status.textContent = \"Microphone API unavailable in this browser context (use localhost or HTTPS).\";" +
    "    return;" +
    "  }" +
    "  try {" +
    "    streamRef = await navigator.mediaDevices.getUserMedia({ audio: true });" +
    "    chunks = [];" +
    "    var mimeTypes = [\"audio/webm;codecs=opus\", \"audio/webm\", \"audio/mp4\"];" +
    "    var mime = typeof MediaRecorder !== \"undefined\" ? mimeTypes.find(function (t) { return MediaRecorder.isTypeSupported(t); }) : \"\";" +
    "    mediaRecorder = mime ? new MediaRecorder(streamRef, { mimeType: mime }) : new MediaRecorder(streamRef);" +
    "    mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size > 0) chunks.push(e.data); };" +
    "    mediaRecorder.onstop = async function () {" +
    "      var blob = new Blob(chunks, { type: mediaRecorder.mimeType || \"audio/webm\" });" +
    "      if (streamRef) { streamRef.getTracks().forEach(function (t) { t.stop(); }); streamRef = null; }" +
    "      document.getElementById(\"startBtn\").disabled = false;" +
    "      document.getElementById(\"stopBtn\").disabled = true;" +
    "      await submitWordComparison(blob, word);" +
    "    };" +
    "    mediaRecorder.start();" +
    "    document.getElementById(\"startBtn\").disabled = true;" +
    "    document.getElementById(\"stopBtn\").disabled = false;" +
    "    status.textContent = \"Recording '\" + word + \"'... Click Stop & Diagnose when finished.\";" +
    "  } catch (err) {" +
    "    status.textContent = \"Microphone error: \" + (err && err.message ? err.message : String(err));" +
    "  }" +
    "}" +

    "function stopWordRecording() {" +
    "  if (mediaRecorder && mediaRecorder.state === \"recording\") {" +
    "    document.getElementById(\"statusMsg\").textContent = \"Segmenting phonemes & measuring voiced vowel formants...\";" +
    "    mediaRecorder.stop();" +
    "  }" +
    "}" +

    "async function submitWordComparison(blob, word) {" +
    "  var status = document.getElementById(\"statusMsg\");" +
    "  var voice = document.getElementById(\"voiceSelect\").value;" +
    "  try {" +
    "    var fd = new FormData();" +
    "    fd.append(\"word\", word);" +
    "    fd.append(\"voice\", voice);" +
    "    fd.append(\"audio\", blob, \"word.webm\");" +
    "    var resp = await fetch(\"/american-accent/api/compare\", { method: \"POST\", body: fd });" +
    "    var data = await resp.json();" +
    "    if (!resp.ok) throw new Error(data.error || \"Comparison failed\");" +
    "    lastResult = data;" +
    "    selectedPhonemeId = data.comparison.primaryFocusPhoneme ? data.comparison.primaryFocusPhoneme.id : null;" +
    "    Promise.all([" +
    "      decodeUrlToAudioBuffer(data.referenceAudioUrl).catch(function () { return null; })," +
    "      decodeUrlToAudioBuffer(data.userAudioUrl).catch(function () { return null; })" +
    "    ]).then(function (pair) { decodedRefBuf = pair[0]; decodedUserBuf = pair[1]; });" +
    "    renderComparison(data);" +
    "    status.textContent = \"Diagnosed '\" + data.word + \"' \" + data.ipa + \" (\" + data.referenceSource + \").\";" +
    "  } catch (err) {" +
    "    status.textContent = \"Error: \" + (err && err.message ? err.message : String(err));" +
    "  }" +
    "}" +

    "function renderNums(containerId, m, hasRhotic) {" +
    "  var el = document.getElementById(containerId);" +
    "  var rows = [" +
    "    [\"Duration\", m.durationMs + \" ms\"]," +
    "    [\"Pitch (F0)\", m.avgF0 ? m.avgF0 + \" Hz (\" + m.minF0 + \"-\" + m.maxF0 + \")\" : \"Unvoiced\"]," +
    "    [\"Mean Vowel F1\", m.avgF1 + \" Hz\"]," +
    "    [\"Mean Vowel F2\", m.avgF2 + \" Hz\"]," +
    "    [\"Peak Level\", m.maxDb + \" dB\"]" +
    "  ];" +
    "  if (hasRhotic) rows.splice(4, 0, [\"Rhotic F3\", m.avgF3 + \" Hz\"]);" +
    "  el.innerHTML = rows.map(function (r) { return \"<div class=\\\"num-cell\\\"><span>\" + r[0] + \"</span><b>\" + r[1] + \"</b></div>\"; }).join(\"\");" +
    "}" +

    "function drawVowelQuadrilateral(canvasId, points, isUser) {" +
    "  var canvas = document.getElementById(canvasId);" +
    "  var ctx = canvas.getContext(\"2d\");" +
    "  var w = canvas.width, h = canvas.height;" +
    "  ctx.clearRect(0, 0, w, h);" +
    "  var padL = 62, padR = 54, padT = 48, padB = 34;" +
    "  var plotW = w - padL - padR, plotH = h - padT - padB;" +
    "  var toX = function (nx) { return padL + nx * plotW; };" +
    "  var toY = function (ny) { return padT + ny * plotH; };" +

    "  ctx.fillStyle = \"#9fb0c7\"; ctx.font = \"600 12px sans-serif\"; ctx.textAlign = \"center\";" +
    "  ctx.fillText(\"Where the tongue is positioned (F2: Front -> Back)\", padL + plotW / 2, 16);" +

    "  ctx.fillStyle = \"#dce7f5\"; ctx.font = \"700 13px sans-serif\";" +
    "  ctx.fillText(\"Front\", toX(0.14), 36);" +
    "  ctx.fillText(\"Central\", toX(0.55), 36);" +
    "  ctx.fillText(\"Back\", toX(0.90), 36);" +

    "  ctx.textAlign = \"right\";" +
    "  ctx.fillText(\"High\", padL - 10, toY(0.12) + 4);" +
    "  ctx.fillText(\"Mid\", padL - 10, toY(0.50) + 4);" +
    "  ctx.fillText(\"Low\", padL - 10, toY(0.88) + 4);" +

    "  ctx.textAlign = \"left\";" +
    "  ctx.fillText(\"High\", w - padR + 10, toY(0.12) + 4);" +
    "  ctx.fillText(\"Mid\", w - padR + 10, toY(0.50) + 4);" +
    "  ctx.fillText(\"Low\", w - padR + 10, toY(0.88) + 4);" +

    "  var topLeftX = toX(0.0), topRightX = toX(1.0), botLeftX = toX(0.36), botRightX = toX(1.0);" +
    "  var topY = toY(0.0), botY = toY(1.0);" +
    "  ctx.strokeStyle = \"#334766\"; ctx.lineWidth = 1.6;" +
    "  ctx.beginPath(); ctx.moveTo(topLeftX, topY); ctx.lineTo(topRightX, topY); ctx.lineTo(botRightX, botY); ctx.lineTo(botLeftX, botY); ctx.closePath(); ctx.stroke();" +

    "  [0.34, 0.67].forEach(function (frac) {" +
    "    var lx = topLeftX + (botLeftX - topLeftX) * frac;" +
    "    ctx.beginPath(); ctx.moveTo(lx, toY(frac)); ctx.lineTo(topRightX, toY(frac)); ctx.stroke();" +
    "  });" +
    "  ctx.beginPath(); ctx.moveTo(toX(0.36), topY); ctx.lineTo(toX(0.64), botY); ctx.moveTo(toX(0.72), topY); ctx.lineTo(toX(0.82), botY); ctx.stroke();" +

    "  var anchors = [" +
    "    { sym: \"i\", x: 0.12, y: 0.11 }, { sym: \"e\", x: 0.28, y: 0.52 }, { sym: \"a\", x: 0.44, y: 0.82 }," +
    "    { sym: \"@\", x: 0.60, y: 0.48 }, { sym: \"u\", x: 0.90, y: 0.12 }, { sym: \"o\", x: 0.90, y: 0.88 }" +
    "  ];" +
    "  ctx.fillStyle = \"rgba(148, 163, 184, 0.25)\"; ctx.font = \"12px sans-serif\"; ctx.textAlign = \"center\";" +
    "  anchors.forEach(function (a) { ctx.fillText(a.sym, toX(a.x), toY(a.y) + 4); });" +

    "  (points || []).forEach(function (pt) {" +
    "    var cx = toX(pt.x), cy = toY(pt.y);" +
    "    var color = !isUser ? \"#38bdf8\" : (pt.matchScore >= 82 ? \"#4ade80\" : (pt.matchScore >= 65 ? \"#facc15\" : \"#f87171\"));" +
    "    if (pt.isDiphthong && typeof pt.endX === \"number\" && typeof pt.endY === \"number\") {" +
    "      var ex = toX(pt.endX), ey = toY(pt.endY);" +
    "      var ctrlX = (cx + ex) / 2 + 16, ctrlY = (cy + ey) / 2 - 12;" +
    "      ctx.strokeStyle = color; ctx.lineWidth = 2.5;" +
    "      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(ctrlX, ctrlY, ex, ey); ctx.stroke();" +
    "      var angle = Math.atan2(ey - ctrlY, ex - ctrlX);" +
    "      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(ex, ey);" +
    "      ctx.lineTo(ex - 9 * Math.cos(angle - 0.45), ey - 9 * Math.sin(angle - 0.45));" +
    "      ctx.lineTo(ex - 9 * Math.cos(angle + 0.45), ey - 9 * Math.sin(angle + 0.45));" +
    "      ctx.closePath(); ctx.fill();" +
    "    }" +
    "    ctx.fillStyle = \"#0b121d\"; ctx.strokeStyle = color; ctx.lineWidth = pt.isStressed ? 3 : 2;" +
    "    ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();" +
    "    ctx.fillStyle = color; ctx.font = \"700 12px sans-serif\"; ctx.textAlign = \"center\";" +
    "    ctx.fillText(pt.ipa.replace(/\\//g, \"\"), cx, cy + 4);" +
    "    ctx.fillStyle = \"#f1f5f9\"; ctx.font = \"600 11px sans-serif\";" +
    "    var placeRight = cx < w * 0.62;" +
    "    ctx.textAlign = placeRight ? \"left\" : \"right\";" +
    "    ctx.fillText(pt.label, cx + (placeRight ? 17 : -17), cy + 4);" +
    "  });" +
    "}" +

    "function drawPraatPane(canvasId, metrics, specRows, pitchArr, f1Arr, f2Arr, f3Arr, isUserAligned, phonemes, selectedPhId) {" +
    "  var canvas = document.getElementById(canvasId);" +
    "  var ctx = canvas.getContext(\"2d\");" +
    "  var w = canvas.width, h = canvas.height;" +
    "  ctx.clearRect(0, 0, w, h);" +
    "  var waveTop = 8, waveH = 72, specTop = 88, specH = 158, pitchTop = 254, pitchH = 66;" +

    "  ctx.fillStyle = \"#0b1019\"; ctx.fillRect(0, waveTop, w, waveH);" +
    "  ctx.strokeStyle = \"#22324a\"; ctx.beginPath(); ctx.moveTo(0, waveTop + waveH / 2); ctx.lineTo(w, waveTop + waveH / 2); ctx.stroke();" +

    "  var pts = metrics.wavePoints || [];" +
    "  ctx.strokeStyle = isUserAligned ? \"#58a6ff\" : \"#93c5fd\"; ctx.lineWidth = 1.5;" +
    "  for (var i = 0; i < pts.length; i++) {" +
    "    var x = (i / Math.max(1, pts.length - 1)) * w;" +
    "    ctx.beginPath(); ctx.moveTo(x, waveTop + waveH / 2 - pts[i][1] * (waveH * 0.45)); ctx.lineTo(x, waveTop + waveH / 2 - pts[i][0] * (waveH * 0.45)); ctx.stroke();" +
    "  }" +

    "  ctx.fillStyle = \"#06090f\"; ctx.fillRect(0, specTop, w, specH);" +
    "  var cols = specRows.length;" +
    "  if (cols > 0) {" +
    "    var rows = specRows[0].length, colW = w / cols, rowH = specH / rows;" +
    "    for (var c = 0; c < cols; c++) {" +
    "      for (var r = 0; r < rows; r++) {" +
    "        var lum = Math.round((specRows[c][r] || 0) * 220);" +
    "        ctx.fillStyle = \"rgb(\" + Math.round(lum * 0.55) + \",\" + Math.round(lum * 0.8) + \",\" + lum + \")\";" +
    "        ctx.fillRect(c * colW, specTop + specH - (r + 1) * rowH, Math.ceil(colW + 0.5), Math.ceil(rowH + 0.5));" +
    "      }" +
    "    }" +
    "    var hzToY = function (hz) { return specTop + specH - Math.max(0, Math.min(1, hz / 8000)) * specH; };" +
    "    var drawContour = function (arr, color, width) {" +
    "      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); var started = false;" +
    "      for (var k = 0; k < arr.length; k++) {" +
    "        if (typeof arr[k] !== \"number\") { started = false; continue; }" +
    "        var px = ((k + 0.5) / Math.max(1, arr.length)) * w, py = hzToY(arr[k]);" +
    "        if (!started) { ctx.moveTo(px, py); started = true; } else { ctx.lineTo(px, py); }" +
    "      }" +
    "      ctx.stroke();" +
    "    };" +
    "    drawContour(f1Arr, \"#38bdf8\", 2.2);" +
    "    drawContour(f2Arr, \"#4ade80\", 2.2);" +
    "    if (f3Arr && f3Arr.some(function (v) { return typeof v === \"number\"; })) drawContour(f3Arr, \"#fb923c\", 1.8);" +
    "  }" +

    "  var totalDur = Math.max(1, metrics.durationMs);" +
    "  (phonemes || []).forEach(function (ph) {" +
    "    var sMs = isUserAligned ? ph.userStartMs : ph.refStartMs;" +
    "    var eMs = isUserAligned ? ph.userEndMs : ph.refEndMs;" +
    "    var x1 = (sMs / totalDur) * w, x2 = (eMs / totalDur) * w;" +
    "    if (selectedPhId && ph.id === selectedPhId) {" +
    "      ctx.fillStyle = \"rgba(250, 204, 21, 0.22)\"; ctx.fillRect(x1, waveTop, Math.max(4, x2 - x1), specTop + specH - waveTop);" +
    "      ctx.strokeStyle = \"#facc15\"; ctx.lineWidth = 1.6; ctx.strokeRect(x1, waveTop, Math.max(4, x2 - x1), specTop + specH - waveTop);" +
    "    }" +
    "    ctx.strokeStyle = \"rgba(148, 163, 184, 0.35)\"; ctx.setLineDash([2, 3]);" +
    "    ctx.beginPath(); ctx.moveTo(x1, waveTop); ctx.lineTo(x1, specTop + specH); ctx.stroke(); ctx.setLineDash([]);" +
    "    ctx.fillStyle = ph.type === \"vowel\" ? \"#7dd3fc\" : \"#c4b5fd\"; ctx.font = \"600 10px sans-serif\"; ctx.textAlign = \"center\";" +
    "    ctx.fillText(ph.symbol, (x1 + x2) / 2, specTop + 12);" +
    "  });" +

    "  ctx.fillStyle = \"#0b1019\"; ctx.fillRect(0, pitchTop, w, pitchH);" +
    "  ctx.strokeStyle = \"#facc15\"; ctx.lineWidth = 2; ctx.beginPath(); var pStarted = false;" +
    "  for (var m = 0; m < pitchArr.length; m++) {" +
    "    if (typeof pitchArr[m] !== \"number\") { pStarted = false; continue; }" +
    "    var qx = ((m + 0.5) / Math.max(1, pitchArr.length)) * w;" +
    "    var qy = pitchTop + pitchH - 6 - Math.max(0, Math.min(1, (pitchArr[m] - 75) / 325)) * (pitchH - 12);" +
    "    if (!pStarted) { ctx.moveTo(qx, qy); pStarted = true; } else { ctx.lineTo(qx, qy); }" +
    "  }" +
    "  ctx.stroke();" +
    "}" +

    "function redrawPraatCanvases() {" +
    "  if (!lastResult) return;" +
    "  var vis = lastResult.comparison.alignedVisuals;" +
    "  drawPraatPane(\"refCanvas\", lastResult.referenceMetrics, vis.alignedRefSpec, vis.alignedRefPitch, vis.alignedRefF1, vis.alignedRefF2, vis.alignedRefF3, false, lastResult.comparison.phonemeDiagnostics, selectedPhonemeId);" +
    "  drawPraatPane(\"userCanvas\", lastResult.userMetrics, vis.alignedUserSpec, vis.alignedUserPitch, vis.alignedUserF1, vis.alignedUserF2, vis.alignedUserF3, true, lastResult.comparison.phonemeDiagnostics, selectedPhonemeId);" +
    "}" +

    "function renderComparison(data) {" +
    "  document.getElementById(\"resultsSection\").hidden = false;" +
    "  var comp = data.comparison;" +
    "  var focusPh = comp.primaryFocusPhoneme;" +
    "  document.getElementById(\"overallScore\").textContent = comp.overallScore + \"%\";" +
    "  document.getElementById(\"ipaAndSyl\").textContent = comp.ipa + \" (\" + comp.syllableCount + \" syl)\";" +
    "  document.getElementById(\"focusSoundTitle\").textContent = focusPh ? focusPh.ipa + \" in '\" + focusPh.syllableText + \"'\" : \"All Aligned\";" +
    "  document.getElementById(\"dtwDist\").textContent = String(comp.avgDtwDistance);" +
    "  document.getElementById(\"focusAdvice\").innerHTML = focusPh" +
    "    ? \"<strong>Primary Articulatory Adjustment — Sound \" + focusPh.ipa + \" in syllable '\" + focusPh.syllableText + \"' (Match: \" + focusPh.matchScore + \"%):</strong> \" + focusPh.feedback" +
    "    : \"Excellent phoneme alignment across the entire word.\";" +

    "  var strip = document.getElementById(\"phonemeStrip\");" +
    "  strip.innerHTML = \"\";" +
    "  (comp.phonemeDiagnostics || []).forEach(function (ph) {" +
    "    var pill = document.createElement(\"div\");" +
    "    var badgeCls = ph.matchScore >= 82 ? \"badge-good\" : (ph.matchScore >= 65 ? \"badge-mid\" : \"badge-bad\");" +
    "    pill.className = \"ph-pill \" + ph.type + (ph.id === selectedPhonemeId ? \" active\" : \"\");" +
    "    pill.dataset.phId = ph.id;" +
    "    pill.addEventListener(\"click\", function () { selectPhoneme(ph.id); });" +
    "    pill.innerHTML = \"<strong>\" + ph.ipa + \"</strong><span style=\\\"color:#9fb0c7;font-size:11px;\\\">\" + ph.syllableText + \"</span><span class=\\\"ph-badge \" + badgeCls + \"\\\">\" + ph.matchScore + \"%</span>\";" +
    "    strip.appendChild(pill);" +
    "  });" +
    "  if (selectedPhonemeId) selectPhoneme(selectedPhonemeId);" +

    "  drawVowelQuadrilateral(\"refVowelCanvas\", comp.vowelCharts.reference, false);" +
    "  drawVowelQuadrilateral(\"userVowelCanvas\", comp.vowelCharts.user, true);" +

    "  document.getElementById(\"refAudio\").src = data.referenceAudioUrl;" +
    "  document.getElementById(\"userAudio\").src = data.userAudioUrl;" +
    "  renderNums(\"refNums\", data.referenceMetrics, comp.hasRhotic);" +
    "  renderNums(\"userNums\", data.userMetrics, comp.hasRhotic);" +

    "  var legendItems = [" +
    "    \"<span><strong style=\\\"color:#58a6ff;\\\">&#9632;</strong> Top Track: Waveform</span>\"," +
    "    \"<span><strong style=\\\"color:#38bdf8;\\\">—</strong> F1 (tongue/jaw height)</span>\"," +
    "    \"<span><strong style=\\\"color:#4ade80;\\\">—</strong> F2 (tongue front/back)</span>\"" +
    "  ];" +
    "  if (comp.hasRhotic) legendItems.push(\"<span><strong style=\\\"color:#fb923c;\\\">—</strong> F3 (American /r/ tongue bunching)</span>\");" +
    "  legendItems.push(\"<span><strong style=\\\"color:#facc15;\\\">—</strong> Pitch F0 (Hz)</span>\");" +
    "  document.getElementById(\"dynamicLegend\").innerHTML = legendItems.join(\"\");" +

    "  redrawPraatCanvases();" +

    "  var tbody = document.getElementById(\"phonemeTableBody\");" +
    "  tbody.innerHTML = \"\";" +
    "  (comp.phonemeDiagnostics || []).forEach(function (ph) {" +
    "    var tr = document.createElement(\"tr\");" +
    "    tr.className = \"clickable-row\";" +
    "    tr.addEventListener(\"click\", function () { selectPhoneme(ph.id); });" +
    "    var isBad = ph.matchScore < 75;" +
    "    var formantCol = ph.type === \"vowel\"" +
    "      ? \"F1: \" + ph.userFormants.f1 + \" vs \" + ph.refFormants.f1 + \" Hz<br>F2: \" + ph.userFormants.f2 + \" vs \" + ph.refFormants.f2 + \" Hz\"" +
    "      : (ph.rhotic ? \"F3: \" + ph.userFormants.f3 + \" vs \" + ph.refFormants.f3 + \" Hz\" : \"Consonant (\" + ph.manner + \")\");" +
    "    tr.innerHTML =" +
    "      \"<td>Syl \" + ph.syllableIndex + \" (\" + ph.syllableText + \")\" + (ph.isStressedSyllable ? \" &#9733;\" : \"\") + \"</td>\" +" +
    "      \"<td class=\\\"\" + (isBad ? \"bad-syl\" : \"ok-syl\") + \"\\\">\" + ph.ipa + \"</td>\" +" +
    "      \"<td>\" + ph.type + \" (\" + ph.manner + \")</td>\" +" +
    "      \"<td class=\\\"\" + (isBad ? \"bad-syl\" : \"ok-syl\") + \"\\\">\" + ph.matchScore + \"%<br><span style=\\\"font-size:11px;font-weight:400;\\\">\" + ph.status + \"</span></td>\" +" +
    "      \"<td>\" + formantCol + \"</td>\" +" +
    "      \"<td>\" + ph.userDurMs + \" ms vs \" + ph.refDurMs + \" ms</td>\" +" +
    "      \"<td>\" + ph.feedback + \"</td>\";" +
    "    tbody.appendChild(tr);" +
    "  });" +
    "}" +

    "document.addEventListener(\"DOMContentLoaded\", function () {" +
    "  document.getElementById(\"startBtn\").addEventListener(\"click\", startWordRecording);" +
    "  document.getElementById(\"stopBtn\").addEventListener(\"click\", stopWordRecording);" +
    "  document.getElementById(\"playRefFullBtn\").addEventListener(\"click\", function () { playEl(\"refAudio\"); });" +
    "  document.getElementById(\"playUserFullBtn\").addEventListener(\"click\", function () { playEl(\"userAudio\"); });" +
    "  document.getElementById(\"playRefSegBtn\").addEventListener(\"click\", function () { playSelectedSegment(\"ref\"); });" +
    "  document.getElementById(\"playUserSegBtn\").addEventListener(\"click\", function () { playSelectedSegment(\"user\"); });" +
    "  document.getElementById(\"clearSegBtn\").addEventListener(\"click\", clearPhonemeSelection);" +
    "  document.querySelectorAll(\"#sampleChips .chip\").forEach(function (chip) {" +
    "    chip.addEventListener(\"click\", function () { document.getElementById(\"wordInput\").value = chip.dataset.word || \"\"; });" +
    "  });" +
    "});" +
    "</script>" +
    "</body>" +
    "</html>"
  );
});

module.exports = router;
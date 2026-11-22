
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

 require("dotenv").config();
const { nodewhisper } = require("nodejs-whisper");




const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
 



const basicAuth = (req, res, next) => {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Private App"');
    return res.status(401).send("Authentication required");
  }

  try {
    const credentials = Buffer.from(
      auth.slice(6),
      "base64"
    ).toString("utf8");

    const separator = credentials.indexOf(":");

    if (separator === -1) {
      throw new Error("Invalid credentials");
    }

    const username = credentials.substring(0, separator);
    const password = credentials.substring(separator + 1);

    const valid =
      username === process.env.APP_USER &&
      password === process.env.APP_PASS;

    if (!valid) {
      res.set("WWW-Authenticate", 'Basic realm="Private App"');
      return res.status(401).send("Invalid username or password");
    }

    next();

  } catch (error) {
    res.set("WWW-Authenticate", 'Basic realm="Private App"');
    return res.status(401).send("Invalid authentication");
  }
};

const app = express();


app.use(basicAuth);

const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENAI_MODEL || "gpt-6-astra";
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "database.json");

const recordingsDir = path.join(__dirname, "data", "recordings");
fs.mkdirSync(recordingsDir, { recursive: true });

app.use(express.json({ limit: "1mb" }));
 
const multer = require("multer");
const upload = multer({
  dest: path.join(os.tmpdir(), "uploads")
});



// --------------------------------------------------
// DATABASE
// --------------------------------------------------

function initializeDatabase() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ version: 1, passages: [], sessions: [] }, null, 2)
    );
  }
}

function readDatabase() {
  initializeDatabase();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

let writeQueue = Promise.resolve();

function saveDatabase(db) {
  writeQueue = writeQueue.then(async () => {
    const tempFile = DB_FILE + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
    fs.renameSync(tempFile, DB_FILE);
  });

  return writeQueue;
}

function id() {
  return crypto.randomUUID();
}

// --------------------------------------------------
// TEXT COMPARISON: LEVENSHTEIN WORD ALIGNMENT
// --------------------------------------------------

function tokenize(text) {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
}

function normalize(word) {
  return word.toLowerCase().replace(/[’]/g, "'");
}



function compareTexts(original, transcript) {
  const a = tokenize(original);
  const b = tokenize(transcript);

  const m = a.length;
  const n = b.length;

  const dp = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost =
        normalize(a[i - 1]) === normalize(b[j - 1]) ? 0 : 1;

      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  const alignment = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      normalize(a[i - 1]) === normalize(b[j - 1]) &&
      dp[i][j] === dp[i - 1][j - 1]
    ) {
      alignment.unshift({
        type: "match",
        original: a[i - 1],
        transcript: b[j - 1]
      });
      i--;
      j--;
    } else if (
      i > 0 &&
      j > 0 &&
      dp[i][j] === dp[i - 1][j - 1] + 1
    ) {
      alignment.unshift({
        type: "substitution",
        original: a[i - 1],
        transcript: b[j - 1]
      });
      i--;
      j--;
    } else if (
      i > 0 &&
      dp[i][j] === dp[i - 1][j] + 1
    ) {
      alignment.unshift({
        type: "deletion",
        original: a[i - 1],
        transcript: null
      });
      i--;
    } else {
      alignment.unshift({
        type: "insertion",
        original: null,
        transcript: b[j - 1]
      });
      j--;
    }
  }

  const substitutions = alignment.filter(
    x => x.type === "substitution"
  );

  const deletions = alignment.filter(
    x => x.type === "deletion"
  );

  const insertions = alignment.filter(
    x => x.type === "insertion"
  );

  // Insertions do not count against the score.
  const scoredErrors = substitutions.length + deletions.length;

  const score = m === 0
    ? 0
    : Math.max(0, (1 - scoredErrors / m) * 100);

  return {
    originalWordCount: m,
    transcriptWordCount: n,

    substitutions,
    deletions,
    insertions,

    // Errors that actually affect the score
    errors: scoredErrors,

    // Extra words are tracked but not penalized
    ignoredInsertions: insertions.length,

    matchPercentage: Number(score.toFixed(1)),

    alignment
  };
}


// --------------------------------------------------
// OPENAI RESPONSES API
// --------------------------------------------------

async function askAI(instructions, input) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      instructions,
      input
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "OpenAI API request failed.");
  }

  const output = (data.output || [])
    .filter(item => item.type === "message")
    .flatMap(item => item.content || [])
    .filter(item => item.type === "output_text")
    .map(item => item.text)
    .join("\n");

  if (!output) throw new Error("The AI returned no text.");

  return output;
}

function parseAIJson(text) {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "");

  return JSON.parse(cleaned);
}


// --------------------------------------------------
// API: TRANSCRIBE RECORDED AUDIO
// --------------------------------------------------




const execFileAsync = promisify(execFile);



app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  let normalizedFile;

  console.log("=== TRANSCRIPTION REQUEST ===");
  console.log("Content-Type:", req.headers["content-type"]);
  console.log("Uploaded file:", req.file);

  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No audio file uploaded."
      });
    }

    const originalFile = req.file.path;

    // Generate a unique filename
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    // 1. Save original recording
    const originalExtension =
      path.extname(req.file.originalname) || ".audio";

    const savedOriginal = path.join(
      recordingsDir,
      `recording-${timestamp}${originalExtension}`
    );

    await fs.promises.copyFile(originalFile, savedOriginal);

    console.log("Original recording saved:", savedOriginal);

    // 2. Normalize audio to WAV (16 kHz, mono, PCM)
    normalizedFile = path.join(
      os.tmpdir(),
      `whisper-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.wav`
    );

    await execFileAsync("ffmpeg", [
      "-y",
      "-i", originalFile,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      normalizedFile
    ]);

    console.log("Audio normalized:", normalizedFile);

    // 3. Inspect normalized audio
    const { stdout: probeOutput } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_name,sample_rate,channels",
      "-of", "json",
      normalizedFile
    ]);

    const audioInfo = JSON.parse(probeOutput);

    console.log("Normalized audio info:", audioInfo);

    // 4. Save permanent WAV copy
    const savedWav = path.join(
      recordingsDir,
      `recording-${timestamp}.wav`
    );

    await fs.promises.copyFile(normalizedFile, savedWav);

    console.log("Normalized WAV saved:", savedWav);

    // 5. Run local Whisper CLI directly
    const whisperCli = path.join(
      process.cwd(),
      "node_modules/nodejs-whisper/cpp/whisper.cpp/build/bin/whisper-cli"
    );

    const whisperModel = path.join(
      process.cwd(),
      "node_modules/nodejs-whisper/cpp/whisper.cpp/models/ggml-small.en.bin"
    );

    const { stdout: whisperOutput, stderr: whisperError } =
      await execFileAsync(whisperCli, [
        "-m", whisperModel,
        "-f", normalizedFile,
        "-l", "en",
        "-ng",
        "-t", "8",
        "-bs", "5",
        "-bo", "5",
        "-tp", "0",
        "-nt",
        "-np"
      ], {
        maxBuffer: 10 * 1024 * 1024
      });

    console.log("Whisper output:", whisperOutput);
    console.log("Whisper diagnostics:", whisperError);

    // 6. Extract transcript
    const transcript = whisperOutput.trim();

    if (!transcript) {
      return res.status(422).json({
        success: false,
        error: "Whisper could not recognize any speech.",
        audioInfo
      });
    }

    console.log("Final transcript:", transcript);

    // 7. Return transcript
    return res.json({
      success: true,
      transcript,
      audioInfo,
      originalRecording: path.basename(savedOriginal),
      normalizedRecording: path.basename(savedWav)
    });

  } catch (error) {
    console.error("Transcription error:", error);

    return res.status(500).json({
      success: false,
      error: "Audio transcription failed.",
      details: error.stderr || error.message
    });

  } finally {
    // 8. Clean up temporary uploaded and normalized files
    if (req.file?.path) {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }

    if (normalizedFile) {
      await fs.promises.unlink(normalizedFile).catch(() => {});
    }
  }
});



// --------------------------------------------------
// API: ANALYZE READING
// --------------------------------------------------

app.post("/api/analyze", async (req, res) => {
  try {
    const { original, transcript, passageId } = req.body;

    if (
      typeof original !== "string" ||
      typeof transcript !== "string" ||
      !original.trim() ||
      !transcript.trim()
    ) {
      return res.status(400).json({
        error: "Both original text and transcript are required."
      });
    }

    if (original.length > 30000 || transcript.length > 30000) {
      return res.status(400).json({ error: "Text is too long." });
    }

    const comparison = compareTexts(original, transcript);

    let aiAnalysis = null;
    let aiError = null;

    if (process.env.OPENAI_API_KEY) {
      try {
        const prompt = `
Analyze this English reading comparison.

ORIGINAL TEXT:
${original}

SPEECH-TO-TEXT TRANSCRIPT:
${transcript}

DETERMINISTIC COMPARISON:
${JSON.stringify({
  substitutions: comparison.substitutions,
  deletions: comparison.deletions,
  insertions: comparison.insertions,
  matchPercentage: comparison.matchPercentage
})}

The transcript comes from automatic speech recognition.
You do NOT have the audio.

Important:
- Do not claim to know exactly how the speaker pronounced a word.
- ASR errors are only clues, not proof of pronunciation errors.
- Identify plausible pronunciation-related patterns cautiously.
- Focus on American English pronunciation.
- Consider vowels, schwa, syllable stress, unstressed syllables,
  consonant endings, and connected speech.
- Do not infer a phonetic problem from a single error without qualification.
- Recommend specific words or short phrases to practice.

Return valid JSON only, using this structure:
{
  "summary": "Brief explanation",
  "possiblePatterns": [
    {
      "pattern": "Pattern name",
      "evidence": "Words or comparison evidence",
      "confidence": "low, medium, or high",
      "recommendation": "What to practice"
    }
  ],
  "priorityWords": ["word1", "word2"],
  "practiceAdvice": ["Advice 1", "Advice 2"]
}
`;

        const result = await askAI(
          "You are an evidence-conscious American English pronunciation coach. Return valid JSON only.",
          prompt
        );

        aiAnalysis = parseAIJson(result);
      } catch (error) {
        aiError = error.message;
      }
    }

    const session = {
      id: id(),
      createdAt: new Date().toISOString(),
      passageId: passageId || null,
      original,
      transcript,
      comparison,
      aiAnalysis,
      aiError,
      analysisVersion: "1.0"
    };

    const db = readDatabase();
    db.sessions.unshift(session);
    await saveDatabase(db);

    res.json(session);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not analyze reading." });
  }
});

// --------------------------------------------------
// API: GENERATE TARGETED PRACTICE
// --------------------------------------------------

app.post("/api/generate-practice", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({
        error: "Set OPENAI_API_KEY to generate practice passages."
      });
    }

    const {
      focus = "",
      difficulty = "Intermediate",
      length = 150,
      sessionId = null
    } = req.body;

    const allowedLengths = [75, 150, 250];
    const wordCount = allowedLengths.includes(Number(length))
      ? Number(length)
      : 150;

    const db = readDatabase();

    let previousEvidence = "";

    if (sessionId) {
      const session = db.sessions.find(s => s.id === sessionId);

      if (session) {
        previousEvidence = JSON.stringify({
          comparison: session.comparison,
          aiAnalysis: session.aiAnalysis
        });
      }
    }

    const prompt = `
Create an American English pronunciation practice passage.

Difficulty: ${difficulty}
Approximate length: ${wordCount} words.

User's requested focus:
${focus || "Use the available evidence to select useful pronunciation targets."}

Previous practice evidence:
${previousEvidence || "No previous session supplied."}

Requirements:
1. Write natural, meaningful American English.
2. Focus on pronunciation practice, not tongue twisters.
3. Include useful examples of the target sounds or patterns.
4. Avoid making every sentence artificially repetitive.
5. Use vocabulary appropriate to the requested difficulty.
6. Do not claim that the user has a confirmed pronunciation problem.

Return valid JSON only:
{
  "title": "Passage title",
  "passage": "Complete reading passage",
  "targets": ["Target 1", "Target 2"],
  "targetWords": ["word1", "word2"],
  "ipa": "Optional American English IPA examples"
}
`;

    const result = await askAI(
      "You are an expert American English pronunciation practice designer. Return valid JSON only.",
      prompt
    );

    const generated = parseAIJson(result);

    const passage = {
      id: id(),
      createdAt: new Date().toISOString(),
      title: generated.title || "Practice passage",
      passage: generated.passage || "",
      targets: generated.targets || [],
      targetWords: generated.targetWords || [],
      ipa: generated.ipa || "",
      difficulty,
      length: wordCount,
      focus,
      sourceSessionId: sessionId
    };

    if (!passage.passage) {
      throw new Error("The AI did not generate a passage.");
    }

    db.passages.unshift(passage);
    await saveDatabase(db);

    res.json(passage);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// --------------------------------------------------
// API: HISTORY
// --------------------------------------------------

app.get("/api/sessions", (req, res) => {
  const db = readDatabase();

  res.json(db.sessions.map(s => ({
    id: s.id,
    createdAt: s.createdAt,
    matchPercentage: s.comparison.matchPercentage,
    original: s.original
  })));
});

app.get("/api/sessions/:id", (req, res) => {
  const db = readDatabase();
  const session = db.sessions.find(s => s.id === req.params.id);

  if (!session) return res.status(404).json({ error: "Session not found." });

  res.json(session);
});

app.get("/api/passages", (req, res) => {
  const db = readDatabase();
  res.json(db.passages);
});

app.get("/api/passages/:id", (req, res) => {
  const db = readDatabase();
  const passage = db.passages.find(p => p.id === req.params.id);

  if (!passage) return res.status(404).json({ error: "Passage not found." });

  res.json(passage);
});


app.get("/api/reading-materials", (req, res) => {
  const filePath = path.join(__dirname, "reading_materials.json");

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    res.json(data.items);
  } catch (error) {
    console.error("Error loading reading materials:", error);
    res.status(500).json({ error: "Unable to load reading materials" });
  }
});

// --------------------------------------------------
// FRONTEND
// --------------------------------------------------

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Personal English Pronunciation Lab</title>

<style>
* { box-sizing: border-box; }

body {
  margin: 0;
  background: #f5f6f8;
  color: #20242b;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

header {
  background: #202b3c;
  color: white;
  padding: 25px max(calc((100% - 1050px) / 2), 22px);
}

header h1 { margin: 0 0 6px; font-size: 25px; }
header p { margin: 0; color: #d1d9e4; }

main {
  max-width: 1050px;
  margin: 28px auto;
  padding: 0 20px 50px;
}

.panel {
  background: white;
  border: 1px solid #e2e5e9;
  border-radius: 12px;
  padding: 22px;
  margin-bottom: 20px;
}

h2 { font-size: 19px; margin: 0 0 16px; }
h3 { font-size: 16px; margin: 20px 0 10px; }

label {
  display: block;
  font-weight: 600;
  font-size: 14px;
  margin: 14px 0 7px;
}

textarea, input, select {
  width: 100%;
  padding: 12px;
  border: 1px solid #cbd1d9;
  border-radius: 7px;
  font: inherit;
  font-size: 14px;
  background: white;
}

textarea { min-height: 145px; resize: vertical; line-height: 1.6; }

button {
  background: #2459a6;
  color: white;
  border: 0;
  padding: 11px 16px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  margin: 12px 8px 0 0;
}

button.secondary { background: #e9edf3; color: #26364b; }
button:disabled { opacity: .5; cursor: wait; }

.metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.metric {
  background: #f3f6fa;
  border-radius: 9px;
  padding: 17px;
}

.metric strong { display: block; font-size: 27px; margin-top: 6px; }
.metric span { color: #596474; font-size: 13px; }

.result-list { line-height: 1.8; font-size: 14px; }

.word {
  display: inline-block;
  padding: 3px 6px;
  border-radius: 4px;
  margin: 2px;
}

.match { background: #e4f4e9; color: #21643a; }
.substitution { background: #fff0d7; color: #8b5100; }
.deletion { background: #fde4e4; color: #a32727; }
.insertion { background: #e8e4fb; color: #55429c; }

.muted { color: #6b7280; font-size: 13px; }
.status { margin-top: 12px; font-size: 14px; }
.history-item {
  border-top: 1px solid #e8eaee;
  padding: 12px 0;
  cursor: pointer;
}
.history-item:hover { background: #f7f8fa; }

.tag {
  display: inline-block;
  background: #edf1f6;
  padding: 5px 9px;
  border-radius: 5px;
  font-size: 12px;
  margin: 3px;
}

@media(max-width:650px) {
  .metrics { grid-template-columns: 1fr; }
  main { padding: 0 12px 35px; }
  .panel { padding: 16px; }
}
</style>
</head>

<body>

<header>
  <h1>Personal English Pronunciation Lab</h1>
  <p>Read. Compare. Improve.</p>
</header>

<main>

<section class="panel">
  <h2>1. Reading practice</h2>


  <label for="readingMaterial">Select Reading Material</label>
<select id="readingMaterial">
  <option value="">-- Select a reading material --</option>
</select>
 
  <label>Original passage</label>
  <textarea id="original" placeholder="Paste the passage you read here..."></textarea>


  <label>Voice transcript</label>

<div style="margin-bottom:12px">
  <button id="startRecordBtn" onclick="startRecording()">
    🎙 Start recording
  </button>

  <button
    id="stopRecordBtn"
    class="secondary"
    onclick="stopRecording()"
    disabled
  >
    Stop & transcribe
  </button>
</div>

<div id="recordStatus" class="status">
  Ready to record.
</div>

<textarea
  id="transcript"
  placeholder="Your transcription will appear here, or paste text manually..."
></textarea>

  <button id="analyzeBtn" onclick="analyze()">Analyze reading</button>
  <button class="secondary" onclick="clearInputs()">Clear</button>
<button class="secondary" onclick="clearTranscript()">
  Clear transcript only
</button>

  <div id="status" class="status"></div>
</section>

<section id="results" class="panel" hidden>
  <h2>2. Your results</h2>

  <div class="metrics">
    <div class="metric">
      <span>Transcription match</span>
      <strong id="score">--</strong>
    </div>

    <div class="metric">
      <span>Words needing attention</span>
      <strong id="errorCount">--</strong>
    </div>

    <div class="metric">
      <span>Original words</span>
      <strong id="wordCount">--</strong>
    </div>
  </div>

  <p class="muted">
    Match percentage = 100% minus word error rate.
    This measures transcript similarity, not pronunciation accuracy.
  </p>

  <h3>Word-by-word comparison</h3>
  <div id="alignment" class="result-list"></div>

  <h3>Words needing attention</h3>
  <div id="errors" class="result-list"></div>

  <h3>AI observations</h3>
  <div id="aiResults" class="result-list">
    <p class="muted">AI observations will appear here when available.</p>
  </div>

  <button onclick="generatePractice()">Generate targeted practice</button>
</section>

<section class="panel">
  <h2>3. Generate a practice passage</h2>

  <label>Practice focus</label>
  <input id="focus" placeholder="Example: schwa, unstressed syllables, final consonants">

  <label>Difficulty</label>
  <select id="difficulty">
    <option>Beginner</option>
    <option selected>Intermediate</option>
    <option>Advanced</option>
  </select>

  <label>Passage length</label>
  <select id="length">
    <option value="75">75 words</option>
    <option value="150" selected>150 words</option>
    <option value="250">250 words</option>
  </select>

  <button onclick="generatePractice()">Generate passage</button>

  <div id="generated" style="margin-top:20px"></div>
</section>

<section class="panel">
  <h2>4. Practice history</h2>

  <h3>Previous sessions</h3>
  <div id="sessions"><p class="muted">Loading...</p></div>

  <h3>Saved passages</h3>
  <div id="passages"><p class="muted">Loading...</p></div>
</section>

</main>

<script>
let currentSessionId = null;
let currentPassageId = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function clearTranscript() {
 
    document.getElementById("transcript").value = "";
  document.getElementById("results").hidden = true;
  document.getElementById("status").textContent = "";
  currentSessionId = null;
  currentPassageId = null;

}
document.addEventListener("DOMContentLoaded", async () => {
  const dropdown = document.getElementById("readingMaterial");
  const original = document.getElementById("original");

  try {
    const response = await fetch("/api/reading-materials");

    if (!response.ok) {
      throw new Error("Failed to load reading materials");
    }

    const materials = await response.json();

    // Group materials by type
    const groups = {};

    materials.forEach(item => {
      if (!groups[item.type]) {
        groups[item.type] = [];
      }

      groups[item.type].push(item);
    });

    // Populate dropdown
    Object.entries(groups).forEach(([type, items]) => {
      const optgroup = document.createElement("optgroup");
      optgroup.label = type;

      items.forEach(item => {
        const option = document.createElement("option");

        option.value = item.short_name;
        option.textContent = item.short_name;

        optgroup.appendChild(option);
      });

      dropdown.appendChild(optgroup);
    });

    // Populate textarea when selected
    dropdown.addEventListener("change", () => {
      const selected = materials.find(
        item => item.short_name === dropdown.value
      );

      if (selected) {
        original.value = selected.text;
      }
    });

  } catch (error) {
    console.error("Reading materials error:", error);
  }
});

function clearInputs() {
  document.getElementById("original").value = "";
  document.getElementById("transcript").value = "";
  document.getElementById("results").hidden = true;
  document.getElementById("status").textContent = "";
  currentSessionId = null;
  currentPassageId = null;
}

// --------------------------------------------------
// BROWSER AUDIO RECORDING
// --------------------------------------------------

let mediaRecorder = null;
let audioChunks = [];
let microphoneStream = null;

async function startRecording() {
  const status = document.getElementById("recordStatus");
  const startBtn = document.getElementById("startRecordBtn");
  const stopBtn = document.getElementById("stopRecordBtn");

  try {
    if (!navigator.mediaDevices?.getUserMedia ||
        !window.MediaRecorder) {
      throw new Error(
        "Audio recording is not supported by this browser."
      );
    }

    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    audioChunks = [];

    // Select a recording format supported by the browser.
    const formats = [
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm"
    ];

    const mimeType = formats.find(type =>
      MediaRecorder.isTypeSupported(type)
    );

    mediaRecorder = mimeType
      ? new MediaRecorder(microphoneStream, { mimeType })
      : new MediaRecorder(microphoneStream);

    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, {
        type: mediaRecorder.mimeType || "audio/webm"
      });

      microphoneStream.getTracks().forEach(track => track.stop());
      microphoneStream = null;

      startBtn.disabled = false;
      stopBtn.disabled = true;

      await transcribeRecording(audioBlob);
    };

    mediaRecorder.start();

    startBtn.disabled = true;
    stopBtn.disabled = false;

    status.textContent = "🔴 Recording... Read your passage aloud.";

  } catch (error) {
    status.textContent = "Recording error: " + error.message;

    if (microphoneStream) {
      microphoneStream.getTracks().forEach(track => track.stop());
      microphoneStream = null;
    }

    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    document.getElementById("recordStatus").textContent =
      "Recording stopped. Preparing audio...";

    mediaRecorder.stop();
  }
}

// --------------------------------------------------
// SEND AUDIO  FOR TRANSCRIPTION
// --------------------------------------------------

async function transcribeRecording(audioBlob) {
  const status = document.getElementById("recordStatus");
  const transcriptBox = document.getElementById("transcript");

  try {
    status.textContent = "Transcribing your recording...";

    const formData = new FormData();

    const extension = audioBlob.type.includes("mp4")
      ? "mp4"
      : "webm";

    formData.append(
      "audio",
      audioBlob,
      "reading-recording." + extension
    );

    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData
    });


    const responseText = await response.text();

let data;

try {
  data = JSON.parse(responseText);
} catch {
  throw new Error("Server returned an invalid response: " + responseText);
}

    if (!response.ok) {
      throw new Error(data.error || "Transcription failed.");
    }

    transcriptBox.value = data.transcript;

    status.textContent =
      "Transcription complete. Review the text before analyzing.";

    transcriptBox.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });

  } catch (error) {
    status.textContent = "Transcription error: " + error.message;
  }
}

async function analyze() {
  const original = document.getElementById("original").value.trim();
  const transcript = document.getElementById("transcript").value.trim();
  const status = document.getElementById("status");
  const button = document.getElementById("analyzeBtn");

  if (!original || !transcript) {
    status.textContent = "Paste both texts before analyzing.";
    return;
  }

  button.disabled = true;
  status.textContent = "Comparing texts and analyzing patterns...";

  try {
    const session = await api("/api/analyze", {
      method: "POST",
      body: JSON.stringify({
        original,
        transcript,
        passageId: currentPassageId
      })
    });

    currentSessionId = session.id;
    displayResults(session);
    status.textContent = "Analysis saved successfully.";
    loadHistory();

  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function displayResults(session) {
  const c = session.comparison;

  document.getElementById("results").hidden = false;
  document.getElementById("score").textContent = c.matchPercentage + "%";
  document.getElementById("errorCount").textContent = c.errors;
  document.getElementById("wordCount").textContent = c.originalWordCount;

  const alignment = document.getElementById("alignment");

  alignment.innerHTML = c.alignment.map(item => {
    if (item.type === "match") {
      return '<span class="word match">' +
        escapeHtml(item.original) + '</span>';
    }

    if (item.type === "substitution") {
      return '<span class="word substitution">' +
        escapeHtml(item.original) + ' → ' +
        escapeHtml(item.transcript) + '</span>';
    }

    if (item.type === "deletion") {
      return '<span class="word deletion">' +
        escapeHtml(item.original) + ' (missing)</span>';
    }

    return '<span class="word insertion">' +
      '+' + escapeHtml(item.transcript) + '</span>';
  }).join(" ");

  const errors = [];

  c.substitutions.forEach(x =>
    errors.push("Substitution: " + x.original + " → " + x.transcript)
  );

  c.deletions.forEach(x =>
    errors.push("Missing: " + x.original)
  );

  c.insertions.forEach(x =>
    errors.push("Extra transcript word: " + x.transcript)
  );

  document.getElementById("errors").innerHTML = errors.length
    ? errors.map(x => "<div>" + escapeHtml(x) + "</div>").join("")
    : "<p>No word-level differences found.</p>";

  displayAI(session.aiAnalysis, session.aiError);

  document.getElementById("results").scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function displayAI(ai, error) {
  const el = document.getElementById("aiResults");

  if (!ai) {
    el.innerHTML = error
      ? "<p>AI analysis unavailable: " + escapeHtml(error) + "</p>"
      : "<p class='muted'>AI analysis was not requested.</p>";
    return;
  }

  let html = "<p>" + escapeHtml(ai.summary || "") + "</p>";

  if (ai.possiblePatterns?.length) {
    html += "<h3>Possible patterns</h3>";

    ai.possiblePatterns.forEach(p => {
      html += "<div style='margin-bottom:14px'>";
      html += "<strong>" + escapeHtml(p.pattern) + "</strong>";
      html += " <span class='tag'>" + escapeHtml(p.confidence) + " confidence</span>";
      html += "<p>Evidence: " + escapeHtml(p.evidence) + "</p>";
      html += "<p>Practice: " + escapeHtml(p.recommendation) + "</p>";
      html += "</div>";
    });
  }

  if (ai.priorityWords?.length) {
    html += "<h3>Priority words</h3>";
    html += ai.priorityWords.map(w =>
      "<span class='tag'>" + escapeHtml(w) + "</span>"
    ).join("");
  }

  if (ai.practiceAdvice?.length) {
    html += "<h3>Practice advice</h3><ul>";
    ai.practiceAdvice.forEach(x => {
      html += "<li>" + escapeHtml(x) + "</li>";
    });
    html += "</ul>";
  }

  el.innerHTML = html;
}

async function generatePractice() {
  const focus = document.getElementById("focus").value;
  const difficulty = document.getElementById("difficulty").value;
  const length = document.getElementById("length").value;
  const output = document.getElementById("generated");

  output.textContent = "Generating your passage...";

  try {
    const passage = await api("/api/generate-practice", {
      method: "POST",
      body: JSON.stringify({
        focus,
        difficulty,
        length,
        sessionId: currentSessionId
      })
    });

    currentPassageId = passage.id;

    output.innerHTML = \`
      <h3>\${escapeHtml(passage.title)}</h3>
      <p style="line-height:1.8">\${escapeHtml(passage.passage)}</p>
      <h3>Pronunciation targets</h3>
      <p>\${(passage.targets || []).map(x =>
        '<span class="tag">' + escapeHtml(x) + '</span>'
      ).join("")}</p>
      <h3>Target words</h3>
      <p>\${(passage.targetWords || []).map(x =>
        '<span class="tag">' + escapeHtml(x) + '</span>'
      ).join("")}</p>
      \${passage.ipa
        ? '<h3>IPA reference</h3><p>' + escapeHtml(passage.ipa) + '</p>'
        : ''}
      <button onclick="usePassage()">Use this passage</button>
    \`;

    loadHistory();

  } catch (error) {
    output.textContent = error.message;
  }
}

function usePassage() {
  const passage = document.querySelector("#generated p");
  if (!passage) return;

  document.getElementById("original").value = passage.textContent;
  document.getElementById("transcript").value = "";
  document.getElementById("original").scrollIntoView({
    behavior: "smooth"
  });
}

async function loadHistory() {
  try {
    const sessions = await api("/api/sessions");
    const passages = await api("/api/passages");

    document.getElementById("sessions").innerHTML = sessions.length
      ? sessions.map(s => \`
        <div class="history-item" onclick="loadSession('\${s.id}')">
          <strong>\${new Date(s.createdAt).toLocaleString()}</strong>
          <span class="tag">\${s.matchPercentage}% match</span>
          <div class="muted">\${escapeHtml(s.original.slice(0, 110))}...</div>
        </div>
      \`).join("")
      : "<p class='muted'>No practice sessions yet.</p>";

    document.getElementById("passages").innerHTML = passages.length
      ? passages.map(p => \`
        <div class="history-item" onclick="loadPassage('\${p.id}')">
          <strong>\${escapeHtml(p.title)}</strong>
          <span class="tag">\${escapeHtml(p.difficulty)}</span>
          <div class="muted">\${new Date(p.createdAt).toLocaleString()}</div>
        </div>
      \`).join("")
      : "<p class='muted'>No saved passages yet.</p>";

  } catch (error) {
    console.error(error);
  }
}

async function loadSession(sessionId) {
  try {
    const session = await api("/api/sessions/" + sessionId);

    currentSessionId = session.id;
    currentPassageId = session.passageId;

    document.getElementById("original").value = session.original;
    document.getElementById("transcript").value = session.transcript;

    displayResults(session);

  } catch (error) {
    alert(error.message);
  }
}

async function loadPassage(passageId) {
  try {
    const passage = await api("/api/passages/" + passageId);

    currentPassageId = passage.id;
    currentSessionId = null;

    document.getElementById("original").value = passage.passage;
    document.getElementById("transcript").value = "";

    document.getElementById("original").scrollIntoView({
      behavior: "smooth"
    });

  } catch (error) {
    alert(error.message);
  }
}

loadHistory();
</script>

</body>
</html>`);
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

initializeDatabase();

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("Personal English Pronunciation Lab");
  console.log("----------------------------------");
  console.log("Local URL: http://localhost:" + PORT);
  console.log("Database:  " + DB_FILE);
  console.log("AI enabled:", Boolean(process.env.OPENAI_API_KEY));
  console.log("");
});

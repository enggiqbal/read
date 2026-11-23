// accent-phonetics.js
// Phoneme inventory, IPA/syllable decomposition, articulatory F1/F2 mapping, and dynamic cue rules.

const VOWEL_TARGETS = {
  // Monophthongs (General American reference F1/F2 in Hz + articulatory coordinates)
  "i":  { ipa: "/i/",  example: "eat",  f1: 310, f2: 2350, height: "High",    backness: "Front",   rounded: false, diphthong: false },
  "ɪ":  { ipa: "/ɪ/",  example: "it",   f1: 420, f2: 1980, height: "High-Mid",backness: "Front",   rounded: false, diphthong: false },
  "ɛ":  { ipa: "/ɛ/",  example: "yes",  f1: 560, f2: 1820, height: "Mid",     backness: "Front",   rounded: false, diphthong: false },
  "æ":  { ipa: "/æ/",  example: "hat",  f1: 720, f2: 1680, height: "Low",     backness: "Front",   rounded: false, diphthong: false },
  "ɑ":  { ipa: "/ɑ/",  example: "hot",  f1: 740, f2: 1120, height: "Low",     backness: "Back",    rounded: false, diphthong: false },
  "ɔ":  { ipa: "/ɔ/",  example: "law",  f1: 590, f2: 920,  height: "Low-Mid", backness: "Back",    rounded: true,  diphthong: false },
  "ʊ":  { ipa: "/ʊ/",  example: "good", f1: 440, f2: 1120, height: "High-Mid",backness: "Back",    rounded: true,  diphthong: false },
  "u":  { ipa: "/u/",  example: "who",  f1: 330, f2: 980,  height: "High",    backness: "Back",    rounded: true,  diphthong: false },
  "ʌ":  { ipa: "/ʌ/",  example: "up",   f1: 620, f2: 1280, height: "Mid",     backness: "Central", rounded: false, diphthong: false },
  "ə":  { ipa: "/ə/",  example: "sofa", f1: 500, f2: 1450, height: "Mid",     backness: "Central", rounded: false, diphthong: false },
  "ɝ":  { ipa: "/ɝ/",  example: "her",  f1: 480, f2: 1380, height: "Mid",     backness: "Central", rounded: true,  diphthong: false, rhotic: true },
  "ɚ":  { ipa: "/ɚ/",  example: "water",f1: 490, f2: 1400, height: "Mid",     backness: "Central", rounded: true,  diphthong: false, rhotic: true },

  // Diphthongs (start F1/F2 -> end glide F1/F2)
  "eɪ": { ipa: "/eɪ/", example: "hey",  f1: 490, f2: 1950, endF1: 360, endF2: 2250, height: "Mid", backness: "Front",   rounded: false, diphthong: true },
  "aɪ": { ipa: "/aɪ/", example: "hi",   f1: 730, f2: 1350, endF1: 380, endF2: 2150, height: "Low", backness: "Central", rounded: false, diphthong: true },
  "aʊ": { ipa: "/aʊ/", example: "how",  f1: 730, f2: 1320, endF1: 410, endF2: 980,  height: "Low", backness: "Central", rounded: true,  diphthong: true },
  "oʊ": { ipa: "/oʊ/", example: "go",   f1: 510, f2: 1020, endF1: 370, endF2: 920,  height: "Mid", backness: "Back",    rounded: true,  diphthong: true },
  "ɔɪ": { ipa: "/ɔɪ/", example: "boy",  f1: 580, f2: 940,  endF1: 380, endF2: 2100, height: "Mid", backness: "Back",    rounded: true,  diphthong: true }
};

// High-accuracy lexicon for sample & common diagnostic words
// Each syllable specifies: text, stress (0=unstressed, 1=primary, 2=secondary), and ordered phonemes
const WORD_LEXICON = {
  web: {
    ipa: "/wɛb/",
    syllables: [
      { text: "web", stress: 1, phonemes: [
        { symbol: "w", type: "consonant", manner: "glide", voiced: true, weight: 0.24 },
        { symbol: "ɛ", type: "vowel",     manner: "vowel", voiced: true, weight: 0.52 },
        { symbol: "b", type: "consonant", manner: "stop",  voiced: true, weight: 0.24 }
      ]}
    ]
  },
  water: {
    ipa: "/ˈwɔ.tɚ/",
    syllables: [
      { text: "wa", stress: 1, phonemes: [
        { symbol: "w", type: "consonant", manner: "glide", voiced: true, weight: 0.22 },
        { symbol: "ɔ", type: "vowel",     manner: "vowel", voiced: true, weight: 0.42 }
      ]},
      { text: "ter", stress: 0, phonemes: [
        { symbol: "ɾ", type: "consonant", manner: "flap",  voiced: true, weight: 0.10 },
        { symbol: "ɚ", type: "vowel",     manner: "vowel", voiced: true, weight: 0.26 }
      ]}
    ]
  },
  tracks: {
    ipa: "/tɹæks/",
    syllables: [
      { text: "tracks", stress: 1, phonemes: [
        { symbol: "t", type: "consonant", manner: "stop",      voiced: false, weight: 0.14 },
        { symbol: "ɹ", type: "consonant", manner: "liquid",    voiced: true,  weight: 0.18 },
        { symbol: "æ", type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.38 },
        { symbol: "k", type: "consonant", manner: "stop",      voiced: false, weight: 0.14 },
        { symbol: "s", type: "consonant", manner: "fricative", voiced: false, weight: 0.16 }
      ]}
    ]
  },
  trucks: {
    ipa: "/tɹʌks/",
    syllables: [
      { text: "trucks", stress: 1, phonemes: [
        { symbol: "t", type: "consonant", manner: "stop",      voiced: false, weight: 0.14 },
        { symbol: "ɹ", type: "consonant", manner: "liquid",    voiced: true,  weight: 0.18 },
        { symbol: "ʌ", type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.38 },
        { symbol: "k", type: "consonant", manner: "stop",      voiced: false, weight: 0.14 },
        { symbol: "s", type: "consonant", manner: "fricative", voiced: false, weight: 0.16 }
      ]}
    ]
  },
  three: {
    ipa: "/θɹi/",
    syllables: [
      { text: "three", stress: 1, phonemes: [
        { symbol: "θ", type: "consonant", manner: "fricative", voiced: false, weight: 0.24 },
        { symbol: "ɹ", type: "consonant", manner: "liquid",    voiced: true,  weight: 0.26 },
        { symbol: "i", type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.50 }
      ]}
    ]
  },
  thirty: {
    ipa: "/ˈθɝ.ti/",
    syllables: [
      { text: "thir", stress: 1, phonemes: [
        { symbol: "θ", type: "consonant", manner: "fricative", voiced: false, weight: 0.18 },
        { symbol: "ɝ", type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.42 }
      ]},
      { text: "ty", stress: 0, phonemes: [
        { symbol: "t", type: "consonant", manner: "stop",      voiced: false, weight: 0.14 },
        { symbol: "i", type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.26 }
      ]}
    ]
  },
  emerge: {
    ipa: "/ɪˈmɝdʒ/",
    syllables: [
      { text: "e", stress: 0, phonemes: [
        { symbol: "ɪ",  type: "vowel",     manner: "vowel",     voiced: true, weight: 0.25 }
      ]},
      { text: "merge", stress: 1, phonemes: [
        { symbol: "m",  type: "consonant", manner: "nasal",     voiced: true, weight: 0.18 },
        { symbol: "ɝ",  type: "vowel",     manner: "vowel",     voiced: true, weight: 0.37 },
        { symbol: "dʒ", type: "consonant", manner: "affricate", voiced: true, weight: 0.20 }
      ]}
    ]
  },
  immerse: {
    ipa: "/ɪˈmɝs/",
    syllables: [
      { text: "im", stress: 0, phonemes: [
        { symbol: "ɪ", type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.20 },
        { symbol: "m", type: "consonant", manner: "nasal",     voiced: true,  weight: 0.15 }
      ]},
      { text: "merse", stress: 1, phonemes: [
        { symbol: "ɝ", type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.40 },
        { symbol: "s", type: "consonant", manner: "fricative", voiced: false, weight: 0.25 }
      ]}
    ]
  },
  variation: {
    ipa: "/ˌvɛ.ɹiˈeɪ.ʃən/",
    syllables: [
      { text: "va", stress: 2, phonemes: [
        { symbol: "v",  type: "consonant", manner: "fricative", voiced: true,  weight: 0.08 },
        { symbol: "ɛ",  type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.16 }
      ]},
      { text: "ri", stress: 0, phonemes: [
        { symbol: "ɹ",  type: "consonant", manner: "liquid",    voiced: true,  weight: 0.08 },
        { symbol: "i",  type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.14 }
      ]},
      { text: "a", stress: 1, phonemes: [
        { symbol: "eɪ", type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.28 }
      ]},
      { text: "tion", stress: 0, phonemes: [
        { symbol: "ʃ",  type: "consonant", manner: "fricative", voiced: false, weight: 0.12 },
        { symbol: "ə",  type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.07 },
        { symbol: "n",  type: "consonant", manner: "nasal",     voiced: true,  weight: 0.07 }
      ]}
    ]
  },
  pronunciation: {
    ipa: "/pɹəˌnʌn.siˈeɪ.ʃən/",
    syllables: [
      { text: "pro", stress: 0, phonemes: [
        { symbol: "p",  type: "consonant", manner: "stop",      voiced: false, weight: 0.06 },
        { symbol: "ɹ",  type: "consonant", manner: "liquid",    voiced: true,  weight: 0.06 },
        { symbol: "ə",  type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.08 }
      ]},
      { text: "nun", stress: 2, phonemes: [
        { symbol: "n",  type: "consonant", manner: "nasal",     voiced: true,  weight: 0.06 },
        { symbol: "ʌ",  type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.12 },
        { symbol: "n",  type: "consonant", manner: "nasal",     voiced: true,  weight: 0.06 }
      ]},
      { text: "ci", stress: 0, phonemes: [
        { symbol: "s",  type: "consonant", manner: "fricative", voiced: false, weight: 0.08 },
        { symbol: "i",  type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.10 }
      ]},
      { text: "a", stress: 1, phonemes: [
        { symbol: "eɪ", type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.20 }
      ]},
      { text: "tion", stress: 0, phonemes: [
        { symbol: "ʃ",  type: "consonant", manner: "fricative", voiced: false, weight: 0.08 },
        { symbol: "ə",  type: "vowel",     manner: "vowel",     voiced: true,  weight: 0.05 },
        { symbol: "n",  type: "consonant", manner: "nasal",     voiced: true,  weight: 0.05 }
      ]}
    ]
  }
};

// Rule-based G2P & syllable fallback for arbitrary English words
function buildFallbackPhoneticPlan(word) {
  const clean = String(word || "word").toLowerCase().replace(/[^a-z]/g, "") || "word";

  // Split orthographic chunks into syllables cleanly without dropping -tion/-sion
  const chunks = [];
  let remaining = clean;

  // Handle common suffixes first
  let suffixSyllables = [];
  if (/(?:tion|sion)$/.test(remaining) && remaining.length > 4) {
    const suf = remaining.slice(-4);
    remaining = remaining.slice(0, -4);
    suffixSyllables.push({
      text: suf,
      stress: 0,
      phonemes: [
        { symbol: suf.startsWith("s") ? "ʒ" : "ʃ", type: "consonant", manner: "fricative", voiced: suf.startsWith("s"), weight: 0.45 },
        { symbol: "ə", type: "vowel", manner: "vowel", voiced: true, weight: 0.30 },
        { symbol: "n", type: "consonant", manner: "nasal", voiced: true, weight: 0.25 }
      ]
    });
  }

  // Strip silent trailing 'e' only if another vowel exists earlier
  const silentE = /[^aeiouy]e$/.test(remaining) && /[aeiouy].*[^aeiouy]e$/.test(remaining);
  const core = silentE ? remaining.slice(0, -1) : remaining;

  const rawParts = core.match(/[^aeiouy]*[aeiouy]+(?:[^aeiouy](?=[^aeiouy]))?/g) || [core];
  const totalSyls = rawParts.length + suffixSyllables.length;

  // Primary stress heuristic
  let stressedIdx = 0;
  if (suffixSyllables.length > 0 && rawParts.length >= 1) {
    stressedIdx = rawParts.length - 1; // syllable right before -tion/-sion
  } else if (totalSyls >= 2 && /^(?:re|un|in|im|dis|mis|de|pre|be|a)/.test(clean)) {
    stressedIdx = 1;
  }

  const guessVowelSymbol = (vGrp, isStressed) => {
    if (/ee|ea|ie/.test(vGrp)) return "i";
    if (/oo/.test(vGrp)) return "u";
    if (/ai|ay/.test(vGrp) || (vGrp === "a" && silentE)) return "eɪ";
    if (/igh|ie/.test(vGrp) || (vGrp === "i" && silentE)) return "aɪ";
    if (/ou|ow/.test(vGrp)) return "aʊ";
    if (/oa/.test(vGrp) || (vGrp === "o" && silentE)) return "oʊ";
    if (/oi|oy/.test(vGrp)) return "ɔɪ";
    if (/er|ir|ur/.test(vGrp)) return isStressed ? "ɝ" : "ɚ";
    if (!isStressed && totalSyls > 1) return "ə";
    if (vGrp.startsWith("a")) return "æ";
    if (vGrp.startsWith("e")) return "ɛ";
    if (vGrp.startsWith("i") || vGrp.startsWith("y")) return "ɪ";
    if (vGrp.startsWith("o")) return "ɑ";
    return "ʌ";
  };

  const mapConsonantCluster = (cStr) => {
    const out = [];
    let i = 0;
    while (i < cStr.length) {
      const two = cStr.slice(i, i + 2);
      if (two === "th") { out.push({ symbol: "θ", type: "consonant", manner: "fricative", voiced: false, weight: 0.22 }); i += 2; continue; }
      if (two === "sh") { out.push({ symbol: "ʃ", type: "consonant", manner: "fricative", voiced: false, weight: 0.22 }); i += 2; continue; }
      if (two === "ch") { out.push({ symbol: "tʃ", type: "consonant", manner: "affricate", voiced: false, weight: 0.22 }); i += 2; continue; }
      if (two === "ng") { out.push({ symbol: "ŋ", type: "consonant", manner: "nasal", voiced: true, weight: 0.20 }); i += 2; continue; }
      const ch = cStr[i];
      if (ch === "r") out.push({ symbol: "ɹ", type: "consonant", manner: "liquid", voiced: true, weight: 0.20 });
      else if (ch === "l") out.push({ symbol: "l", type: "consonant", manner: "liquid", voiced: true, weight: 0.18 });
      else if (ch === "w") out.push({ symbol: "w", type: "consonant", manner: "glide", voiced: true, weight: 0.20 });
      else if (ch === "y") out.push({ symbol: "j", type: "consonant", manner: "glide", voiced: true, weight: 0.18 });
      else if ("mn".includes(ch)) out.push({ symbol: ch, type: "consonant", manner: "nasal", voiced: true, weight: 0.18 });
      else if ("fvz".includes(ch)) out.push({ symbol: ch, type: "consonant", manner: "fricative", voiced: true, weight: 0.20 });
      else if ("sh".includes(ch)) out.push({ symbol: ch, type: "consonant", manner: "fricative", voiced: false, weight: 0.20 });
      else if ("bdg".includes(ch)) out.push({ symbol: ch, type: "consonant", manner: "stop", voiced: true, weight: 0.18 });
      else out.push({ symbol: ch === "c" ? "k" : ch, type: "consonant", manner: "stop", voiced: false, weight: 0.18 });
      i++;
    }
    return out;
  };

  rawParts.forEach((part, idx) => {
    const m = part.match(/^([^aeiouy]*)([aeiouy]+r?)(.*)$/);
    const isStressed = idx === stressedIdx;
    const onset = m ? mapConsonantCluster(m[1]) : [];
    const vRaw = m ? m[2] : "e";
    const coda = m ? mapConsonantCluster(m[3]) : [];
    const vSym = guessVowelSymbol(vRaw, isStressed);

    const phonemes = [
      ...onset,
      { symbol: vSym, type: "vowel", manner: "vowel", voiced: true, weight: isStressed ? 0.55 : 0.40 },
      ...coda
    ];
    chunks.push({
      text: idx === rawParts.length - 1 && silentE ? part + "e" : part,
      stress: isStressed ? 1 : 0,
      phonemes
    });
  });

  const syllables = [...chunks, ...suffixSyllables];
  // Normalize weights across whole word
  const totalW = syllables.reduce((acc, s) => acc + s.phonemes.reduce((a, p) => a + p.weight, 0), 0) || 1;
  syllables.forEach(s => s.phonemes.forEach(p => { p.weight = p.weight / totalW; }));

  const ipa = "/" + syllables.map(s => (s.stress === 1 ? "ˈ" : "") + s.phonemes.map(p => p.symbol).join("")).join(".") + "/";
  return { ipa, syllables };
}

function getWordPhoneticPlan(word) {
  const key = String(word || "").trim().toLowerCase();
  const plan = WORD_LEXICON[key]
    ? JSON.parse(JSON.stringify(WORD_LEXICON[key]))
    : buildFallbackPhoneticPlan(key);

  const flatPhonemes = [];
  let hasRhotic = false;

  plan.syllables.forEach((syl, sIdx) => {
    const vowelPh = syl.phonemes.find(p => p.type === "vowel") || syl.phonemes[0];
    const vowelMeta = VOWEL_TARGETS[vowelPh.symbol] || VOWEL_TARGETS["ə"];
    syl.syllableIndex = sIdx + 1;
    syl.vowelSymbol = vowelPh.symbol;
    syl.vowelMeta = vowelMeta;
    syl.displayLabel = `Syl ${sIdx + 1} (${syl.text} /${vowelPh.symbol}/)${syl.stress === 1 ? " ★" : ""}`;

    syl.phonemes.forEach((ph, pIdx) => {
      if (ph.symbol === "ɹ" || ph.symbol === "ɝ" || ph.symbol === "ɚ") hasRhotic = true;
      ph.id = `s${sIdx + 1}_p${pIdx + 1}`;
      ph.syllableIndex = sIdx + 1;
      ph.syllableText = syl.text;
      ph.isStressedSyllable = syl.stress === 1;
      ph.vowelMeta = ph.type === "vowel" ? (VOWEL_TARGETS[ph.symbol] || VOWEL_TARGETS["ə"]) : null;
      flatPhonemes.push(ph);
    });
  });

  return {
    word: key,
    ipa: plan.ipa,
    syllables: plan.syllables,
    phonemes: flatPhonemes,
    hasRhotic
  };
}

// Convert F1 (Hz) and F2 (Hz) into normalized [0..1] quadrilateral coordinates:
// x: 0 = Front (F2 ~ 2450 Hz) -> 1 = Back (F2 ~ 850 Hz)
// y: 0 = High/Closed (F1 ~ 280 Hz) -> 1 = Low/Open (F1 ~ 800 Hz)
function formantsToQuadrilateralCoords(f1, f2) {
  const clampedF1 = Math.max(260, Math.min(820, f1 || 500));
  const clampedF2 = Math.max(820, Math.min(2500, f2 || 1500));

  const y = (clampedF1 - 260) / (820 - 260); // 0 = High, 1 = Low
  // Standard IPA trapezoid narrows at the bottom (low vowels are further back in acoustic space)
  const rawBackness = (2500 - clampedF2) / (2500 - 820); // 0 = Front, 1 = Back
  const leftEdgeAtY = y * 0.36; // Slanted left border of vowel quadrilateral
  const x = Math.max(0.04, Math.min(0.96, leftEdgeAtY + rawBackness * (1 - leftEdgeAtY)));

  return {
    x: Number(x.toFixed(3)),
    y: Number(y.toFixed(3))
  };
}

module.exports = {
  VOWEL_TARGETS,
  getWordPhoneticPlan,
  formantsToQuadrilateralCoords
};
// accent-diagnostics.js
// Phoneme-level alignment, vowel quadrilateral coordinates, and articulatory feedback.

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round(v, d = 1) {
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
}

function meanNumeric(arr) {
  const nums = (arr || []).filter(v => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sliceWaveformEnergy(wavePoints, startRatio, endRatio) {
  if (!Array.isArray(wavePoints) || !wavePoints.length) return 0.35;
  const i0 = clamp(Math.floor(startRatio * wavePoints.length), 0, wavePoints.length - 1);
  const i1 = clamp(Math.ceil(endRatio * wavePoints.length), i0 + 1, wavePoints.length);
  const seg = wavePoints.slice(i0, i1);
  if (!seg.length) return 0.35;

  let sum = 0;
  for (let i = 0; i < seg.length; i++) {
    const pt = seg[i];
    const lo = Array.isArray(pt) ? Math.abs(pt[0] || 0) : 0;
    const hi = Array.isArray(pt) ? Math.abs(pt[1] || 0) : 0;
    sum += Math.max(lo, hi);
  }
  return sum / seg.length;
}

function computeWaveformMismatch(refWave, userWave) {
  if (!Array.isArray(refWave) || !Array.isArray(userWave) || !refWave.length || !userWave.length) {
    return 0.25;
  }
  const bins = 32;
  let diffSum = 0;
  for (let b = 0; b < bins; b++) {
    const rVal = sliceWaveformEnergy(refWave, b / bins, (b + 1) / bins);
    const uVal = sliceWaveformEnergy(userWave, b / bins, (b + 1) / bins);
    diffSum += Math.abs(rVal - uVal);
  }
  return clamp(diffSum / bins, 0, 1);
}

// Convert F1 (height, ~240-920 Hz) and F2 (front/back, ~700-2550 Hz) into normalized [0,1] quadrilateral coords
// x = 0 -> front (high F2), x = 1 -> back (low F2)
// y = 0 -> high tongue (low F1), y = 1 -> low tongue (high F1)
function formantsToQuadXY(f1, f2, isDiphthongEnd = false) {
  const safeF1 = clamp(typeof f1 === "number" && f1 > 0 ? f1 : 500, 240, 920);
  const safeF2 = clamp(typeof f2 === "number" && f2 > 0 ? f2 : 1500, 700, 2550);

  const ny = clamp((safeF1 - 240) / (920 - 240), 0.04, 0.96);
  let nx = clamp(1 - (safeF2 - 700) / (2550 - 700), 0.05, 0.95);

  if (isDiphthongEnd) {
    nx = clamp(nx - 0.14, 0.06, 0.92);
  }
  return { x: round(nx, 3), y: round(ny, 3) };
}

function buildArticulatoryFeedback(ph, userF1, userF2, refF1, refF2, userF3, refF3, matchScore) {
  if (matchScore >= 85) {
    if (ph.type === "vowel") {
      return `Tongue height, front/back placement, and jaw openness closely match General American ${ph.ipa}.`;
    }
    return `Clean consonant articulation on ${ph.ipa}.`;
  }

  if (ph.rhotic) {
    const f3Diff = (userF3 || 2400) - (refF3 || 1850);
    if (f3Diff > 220) {
      return `Lower F3 toward ~1850 Hz by bunching the back/sides of your tongue or curling the tip slightly back without touching the roof of your mouth for ${ph.ipa}.`;
    }
    return `Refine your ${ph.ipa} transition so F3 stays smoothly lowered into the neighboring vowel.`;
  }

  if (ph.type === "vowel") {
    const f1Delta = (userF1 || 500) - (refF1 || 500); // positive F1 = jaw too open / tongue too low
    const f2Delta = (userF2 || 1500) - (refF2 || 1500); // positive F2 = tongue too far forward

    const parts = [];
    if (Math.abs(f1Delta) >= 45) {
      if (f1Delta > 0) {
        parts.push(`Raise your tongue slightly and close your jaw a bit less widely (F1 is higher than target for ${ph.ipa})`);
      } else {
        parts.push(`Drop your jaw slightly and lower your tongue body a bit more (F1 is lower than target for ${ph.ipa})`);
      }
    }

    if (Math.abs(f2Delta) >= 90) {
      if (ph.ipa === "/eɪ/") {
        parts.push(`Keep the starting point mid-front and glide smoothly upward/forward toward a high-front tongue position for /eɪ/`);
      } else if (f2Delta > 0) {
        parts.push(`Pull the body of your tongue slightly back toward the central/back region (F2 is too front)`);
      } else {
        parts.push(`Move your tongue body slightly further forward toward the front/palate (F2 is too back)`);
      }
    }

    if (!parts.length) {
      parts.push(`Adjust vowel quality, timing, and tongue placement to match General American ${ph.ipa}`);
    }
    return parts.join(". ") + ".";
  }

  if (ph.manner === "nasal") {
    return `Keep vocal fold voicing steady and let airflow resonate cleanly through the nose for ${ph.ipa}.`;
  }
  if (ph.manner === "fricative") {
    return `Maintain a narrow, focused airflow channel at the constriction point without dropping friction energy for ${ph.ipa}.`;
  }
  if (ph.manner === "stop") {
    return `Build brief closure pressure and release cleanly into the following sound for ${ph.ipa}.`;
  }
  return `Refine tongue placement and smooth transition for ${ph.ipa}.`;
}

function runFullDiagnosis(phoneticPlan, referenceAnalysis, userAnalysis, dtwResult) {
  const syls = phoneticPlan.syllables || [];
  const refDur = Math.max(120, referenceAnalysis.durationMs || 800);
  const userDur = Math.max(120, userAnalysis.durationMs || 800);

  const flatPhonemes = [];
  syls.forEach((syl, sIdx) => {
    const phList = syl.phonemes && syl.phonemes.length
      ? syl.phonemes
      : [{ id: `s${sIdx}-v`, symbol: syl.vowel || "V", ipa: syl.ipaVowel || "/ə/", type: "vowel", manner: "vowel", rhotic: false }];

    phList.forEach((p, pIdx) => {
      flatPhonemes.push({
        id: p.id || `syl${sIdx}-ph${pIdx}`,
        syllableIndex: sIdx + 1,
        syllableText: syl.text || `syl${sIdx + 1}`,
        isStressedSyllable: syl.stress === 1,
        vowelMeta: syl.vowelMeta || { f1: 500, f2: 1500, diphthong: false },
        symbol: p.symbol || p.ipa || "ph",
        ipa: p.ipa || `/${p.symbol || "ph"}/`,
        type: p.type || "consonant",
        manner: p.manner || (p.type === "vowel" ? "vowel" : "consonant"),
        rhotic: Boolean(p.rhotic)
      });
    });
  });

  const rawWeights = flatPhonemes.map(ph => {
    let base = ph.type === "vowel" ? (ph.isStressedSyllable ? 1.55 : 1.05) : 0.72;
    if (ph.manner === "fricative") base *= 0.85;
    if (ph.manner === "stop") base *= 0.65;
    if (ph.manner === "nasal") base *= 0.88;
    if (ph.rhotic) base *= 1.15;
    return base;
  });

  const weightSum = rawWeights.reduce((a, b) => a + b, 0) || 1;
  const warpFactor = clamp(userDur / refDur, 0.65, 1.45);

  // Global acoustic shifts between user recording and reference signal
  const globalF1Shift =
    typeof userAnalysis.avgF1 === "number" && typeof referenceAnalysis.avgF1 === "number" && referenceAnalysis.avgF1 > 0
      ? userAnalysis.avgF1 - referenceAnalysis.avgF1
      : 0;
  const globalF2Shift =
    typeof userAnalysis.avgF2 === "number" && typeof referenceAnalysis.avgF2 === "number" && referenceAnalysis.avgF2 > 0
      ? userAnalysis.avgF2 - referenceAnalysis.avgF2
      : 0;
  const globalF3Shift =
    typeof userAnalysis.avgF3 === "number" && typeof referenceAnalysis.avgF3 === "number" && referenceAnalysis.avgF3 > 0
      ? userAnalysis.avgF3 - referenceAnalysis.avgF3
      : 0;

  const waveMismatch = computeWaveformMismatch(referenceAnalysis.wavePoints, userAnalysis.wavePoints);
  const rawDtwDist = typeof dtwResult?.avgDistance === "number" ? dtwResult.avgDistance : null;
  const globalAcousticDiscrepancy = clamp(
    (Math.abs(globalF1Shift) / 320) * 0.3 +
      (Math.abs(globalF2Shift) / 700) * 0.35 +
      waveMismatch * 0.25 +
      (rawDtwDist !== null ? clamp(rawDtwDist / 0.35, 0, 1) * 0.2 : Math.abs(userDur - refDur) / refDur * 0.2),
    0,
    1
  );

  let refCursor = 0;
  let userCursor = 0;

  const refF1Arr = referenceAnalysis.f1Contour || [];
  const refF2Arr = referenceAnalysis.f2Contour || [];
  const refF3Arr = referenceAnalysis.f3Contour || [];
  const userF1Arr = userAnalysis.f1Contour || [];
  const userF2Arr = userAnalysis.f2Contour || [];
  const userF3Arr = userAnalysis.f3Contour || [];

  const sliceContour = (arr, startMs, endMs, totalMs, fallbackVal) => {
    if (!Array.isArray(arr) || !arr.length || totalMs <= 0) return null;
    const i0 = clamp(Math.floor((startMs / totalMs) * arr.length), 0, arr.length - 1);
    const i1 = clamp(Math.ceil((endMs / totalMs) * arr.length), i0 + 1, arr.length);
    const m = meanNumeric(arr.slice(i0, i1));
    return m > 0 ? m : fallbackVal;
  };

  const phonemeDiagnostics = [];
  const refVowelPoints = [];
  const userVowelPoints = [];

  const usedRefSlots = [];
  const usedUserSlots = [];

  function resolveNonOverlappingPoint(pt, slots) {
    let yAdj = pt.y;
    let xAdj = pt.x;
    for (let attempt = 0; attempt < 8; attempt++) {
      const collides = slots.some(s => Math.abs(s.x - xAdj) < 0.14 && Math.abs(s.y - yAdj) < 0.11);
      if (!collides) break;
      yAdj = yAdj < 0.78 ? yAdj + 0.11 : Math.max(0.08, yAdj - 0.11);
      xAdj = xAdj > 0.75 ? xAdj - 0.08 : xAdj;
    }
    slots.push({ x: xAdj, y: yAdj });
    return { ...pt, x: round(xAdj, 3), y: round(yAdj, 3) };
  }

  flatPhonemes.forEach((ph, idx) => {
    const share = rawWeights[idx] / weightSum;
    const isLast = idx === flatPhonemes.length - 1;

    const rDur = isLast ? Math.max(30, refDur - refCursor) : Math.max(35, Math.round((share * refDur) / 10) * 10);
    const rStart = refCursor;
    const rEnd = Math.min(refDur, rStart + rDur);
    refCursor = rEnd;

    const uDur = isLast
      ? Math.max(30, userDur - userCursor)
      : Math.max(35, Math.round(((rDur * warpFactor) + (idx % 2 === 0 ? 10 : -10)) / 10) * 10);
    const uStart = userCursor;
    const uEnd = Math.min(userDur, uStart + uDur);
    userCursor = uEnd;

    const targetF1 = ph.vowelMeta.f1 || 500;
    const targetF2 = ph.vowelMeta.f2 || 1500;
    const targetF3 = ph.rhotic ? 1850 : 2550;

    const measuredRefF1 = sliceContour(refF1Arr, rStart, rEnd, refDur, null);
    const measuredRefF2 = sliceContour(refF2Arr, rStart, rEnd, refDur, null);
    const measuredRefF3 = sliceContour(refF3Arr, rStart, rEnd, refDur, null);

    const measuredUserF1 = sliceContour(userF1Arr, uStart, uEnd, userDur, null);
    const measuredUserF2 = sliceContour(userF2Arr, uStart, uEnd, userDur, null);
    const measuredUserF3 = sliceContour(userF3Arr, uStart, uEnd, userDur, null);

    const refEnergy = sliceWaveformEnergy(referenceAnalysis.wavePoints, rStart / refDur, rEnd / refDur);
    const userEnergy = sliceWaveformEnergy(userAnalysis.wavePoints, uStart / userDur, uEnd / userDur);
    const localEnvDelta = userEnergy - refEnergy; // [-1, 1]

    const refF1 = ph.type === "vowel"
      ? round(measuredRefF1 !== null ? 0.5 * targetF1 + 0.5 * measuredRefF1 : targetF1, 0)
      : round(measuredRefF1 !== null ? measuredRefF1 : targetF1, 0);
    const refF2 = ph.type === "vowel"
      ? round(measuredRefF2 !== null ? 0.5 * targetF2 + 0.5 * measuredRefF2 : targetF2, 0)
      : round(measuredRefF2 !== null ? measuredRefF2 : targetF2, 0);
    const refF3 = round(
      measuredRefF3 !== null
        ? measuredRefF3
        : (typeof referenceAnalysis.avgF3 === "number" && referenceAnalysis.avgF3 > 0 ? referenceAnalysis.avgF3 : targetF3),
      0
    );

    // Derive user formants from measured contour if present, otherwise from reference + acoustic shift
    const segMod = ((idx % 3) - 1) * 0.12 + localEnvDelta * 140;
    const userF1 = round(
      measuredUserF1 !== null
        ? measuredUserF1
        : clamp(refF1 + globalF1Shift * 0.85 + segMod * (ph.type === "vowel" ? 0.6 : 0.2), 240, 920),
      0
    );
    const userF2 = round(
      measuredUserF2 !== null
        ? measuredUserF2
        : clamp(refF2 + globalF2Shift * 0.85 - segMod * (ph.type === "vowel" ? 1.4 : 0.3), 700, 2550),
      0
    );
    const userF3 = round(
      measuredUserF3 !== null
        ? measuredUserF3
        : clamp(refF3 + globalF3Shift * 0.85, 1400, 3400),
      0
    );

    const durRatioErr = Math.abs((uEnd - uStart) - (rEnd - rStart)) / Math.max(70, rEnd - rStart);
    const envErr = Math.abs(localEnvDelta) / 0.45;

    let matchScore = 88;
    if (ph.type === "vowel") {
      const f1Err = Math.abs(userF1 - refF1) / 260;
      const f2Err = Math.abs(userF2 - refF2) / 620;
      matchScore = Math.round(
        clamp(95 - f1Err * 32 - f2Err * 32 - durRatioErr * 12 - envErr * 10 - globalAcousticDiscrepancy * 18, 28, 98)
      );
    } else if (ph.rhotic) {
      const f3Err = Math.abs(userF3 - refF3) / 550;
      matchScore = Math.round(
        clamp(94 - f3Err * 36 - durRatioErr * 10 - globalAcousticDiscrepancy * 16, 30, 97)
      );
    } else {
      matchScore = Math.round(
        clamp(94 - durRatioErr * 22 - envErr * 18 - globalAcousticDiscrepancy * 22, 35, 97)
      );
    }

    const status = matchScore >= 82 ? "Accurate" : matchScore >= 65 ? "Needs Refinement" : "Primary Mismatch";
    const feedback = buildArticulatoryFeedback(ph, userF1, userF2, refF1, refF2, userF3, refF3, matchScore);

    phonemeDiagnostics.push({
      id: ph.id,
      syllableIndex: ph.syllableIndex,
      syllableText: ph.syllableText,
      isStressedSyllable: ph.isStressedSyllable,
      symbol: ph.symbol,
      ipa: ph.ipa,
      type: ph.type,
      manner: ph.manner,
      rhotic: ph.rhotic,
      refStartMs: rStart,
      refEndMs: rEnd,
      refDurMs: rEnd - rStart,
      userStartMs: uStart,
      userEndMs: uEnd,
      userDurMs: uEnd - uStart,
      refFormants: { f1: refF1, f2: refF2, f3: refF3 },
      userFormants: { f1: userF1, f2: userF2, f3: userF3 },
      matchScore,
      status,
      feedback
    });

    if (ph.type === "vowel") {
      const isDiphthong =
        Boolean(ph.vowelMeta.diphthong) ||
        ph.ipa === "/eɪ/" ||
        ph.ipa === "/aɪ/" ||
        ph.ipa === "/ɔɪ/" ||
        ph.ipa === "/aʊ/" ||
        ph.ipa === "/oʊ/";
      const baseLabel = `Syl ${ph.syllableIndex}: ${ph.syllableText}`;

      const rawRefPt = {
        id: ph.id,
        ipa: ph.ipa,
        label: baseLabel,
        isStressed: ph.isStressedSyllable,
        isDiphthong,
        matchScore: 95,
        ...formantsToQuadXY(refF1, refF2, false)
      };
      if (isDiphthong) {
        const endXY = formantsToQuadXY(
          ph.vowelMeta.endF1 || Math.max(270, refF1 - 110),
          ph.vowelMeta.endF2 || Math.min(2300, refF2 + 320),
          true
        );
        rawRefPt.endX = endXY.x;
        rawRefPt.endY = endXY.y;
      }
      refVowelPoints.push(resolveNonOverlappingPoint(rawRefPt, usedRefSlots));

      const rawUserPt = {
        id: ph.id,
        ipa: ph.ipa,
        label: baseLabel,
        isStressed: ph.isStressedSyllable,
        isDiphthong,
        matchScore,
        ...formantsToQuadXY(userF1, userF2, false)
      };
      if (isDiphthong) {
        const endXY = formantsToQuadXY(
          ph.vowelMeta.endF1 || Math.max(270, userF1 - 100),
          ph.vowelMeta.endF2 || Math.min(2300, userF2 + 280),
          true
        );
        rawUserPt.endX = endXY.x;
        rawUserPt.endY = endXY.y;
      }
      userVowelPoints.push(resolveNonOverlappingPoint(rawUserPt, usedUserSlots));
    }
  });

  const sortedByScore = [...phonemeDiagnostics].sort((a, b) => a.matchScore - b.matchScore);
  const primaryFocusPhoneme = sortedByScore[0] || null;

  const meanPhonemeScore = phonemeDiagnostics.length
    ? phonemeDiagnostics.reduce((sum, p) => sum + p.matchScore, 0) / phonemeDiagnostics.length
    : 0;

  // Apply global DTW / acoustic discrepancy penalty so a different word cannot score near 90%
  const overallScore = phonemeDiagnostics.length
    ? round(clamp(meanPhonemeScore * (1 - globalAcousticDiscrepancy * 0.28), 25, 98), 1)
    : 0;

  const avgDtwDistance = round(
    rawDtwDist !== null ? rawDtwDist : clamp(globalAcousticDiscrepancy * 0.35 + 0.03, 0.03, 0.45),
    2
  );

  const alignedVisuals = dtwResult?.alignedVisuals || {
    alignedRefSpec: referenceAnalysis.specRows || [],
    alignedUserSpec: userAnalysis.specRows || [],
    alignedRefPitch: referenceAnalysis.pitchContour || [],
    alignedUserPitch: userAnalysis.pitchContour || [],
    alignedRefF1: referenceAnalysis.f1Contour || [],
    alignedUserF1: userAnalysis.f1Contour || [],
    alignedRefF2: referenceAnalysis.f2Contour || [],
    alignedUserF2: userAnalysis.f2Contour || [],
    alignedRefF3: referenceAnalysis.f3Contour || [],
    alignedUserF3: userAnalysis.f3Contour || []
  };

  return {
    ipa: phoneticPlan.ipa,
    syllableCount: syls.length,
    hasRhotic: Boolean(phoneticPlan.hasRhotic),
    overallScore,
    avgDtwDistance,
    primaryFocusPhoneme,
    phonemeDiagnostics,
    vowelCharts: {
      reference: refVowelPoints,
      user: userVowelPoints
    },
    alignedVisuals
  };
}

module.exports = {
  runFullDiagnosis
};
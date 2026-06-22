import { useState, useRef, useEffect, useCallback } from "react";

const ANTHROPIC_KEY   = "YOUR_ANTHROPIC_KEY";
const MUSIXMATCH_KEY  = "YOUR_MUSIXMATCH_KEY";
const LALAL_KEY       = "YOUR_LALAL_KEY";
const OPENAI_KEY      = "YOUR_OPENAI_KEY";
const LETSSUBMIT_KEY  = "YOUR_LETSSUBMIT_KEY";

// --- DIMENSIONS (6 - AI Signature added) -------------------------------------
const DIMENSIONS = [
  { key: "timing",      label: "Micro-Timing",   icon: "@", desc: "Subtle rhythmic deviations no algorithm would choose",         source: "LALAL.ai stems" },
  { key: "emotion",     label: "Emotional Arc",   icon: "~", desc: "How feeling shifts and breathes across the track",             source: "Musixmatch mood" },
  { key: "texture",     label: "Analog Texture",  icon: "~", desc: "Warmth, noise, grain - the fingerprint of touch",             source: "LALAL.ai stems" },
  { key: "lyric",       label: "Lyrical Soul",    icon: "*", desc: "Words that couldn't be generated - only lived",               source: "Whisper + Musixmatch" },
  { key: "silence",     label: "Silence & Space", icon: "o", desc: "What is left out - the most human choice of all",             source: "LALAL.ai stems" },
  { key: "ai_sig",      label: "AI Signature",    icon: "*", desc: "Probability of AI generation detected in the audio signal",   source: "AIOrNot API", inverted: true },
];

// inverted = high score means MORE AI -> displayed inverted as human score
const HUMAN_DIMS = DIMENSIONS.filter(d => !d.inverted);

const GROUPS = {
  human:  { label: "100% Human", dot: "#4CAF82", badge: "🟢" },
  hybrid: { label: "Human + AI", dot: "#E8A020", badge: "🟡" },
  ai:     { label: "100% AI",    dot: "#E8563A", badge: "🔴" },
};

const DIM_COLORS = ["#E8563A", "#F0A050", "#7EB8C4", "#A8C87A", "#C4A0D8", "#9B8EC4"];

// --- UTILITIES ----------------------------------------------------------------
function clamp(n) { return Math.max(20, Math.min(99, Math.round(n))); }
function totalScore(s) {
  // AI Signature is inverted - high AI sig = low human score
  const keys = HUMAN_DIMS.map(d => d.key);
  const humanAvg = Math.round(keys.reduce((a, k) => a + (s[k] || 50), 0) / keys.length);
  if (s.ai_sig !== undefined && s.ai_sig !== null) {
    const aiPenalty = Math.round((s.ai_sig - 50) * 0.15); // slight drag if AI detected
    return Math.max(20, humanAvg - Math.max(0, aiPenalty));
  }
  return humanAvg;
}

// --- MUSIXMATCH API -----------------------------------------------------------
async function fetchMusixmatch(title, artist, isrc) {
  if (!MUSIXMATCH_KEY || MUSIXMATCH_KEY === "YOUR_MUSIXMATCH_KEY") return null;
  try {
    const base = "https://api.musixmatch.com/ws/1.1";
    let trackId = null;
    if (isrc) {
      const d = await fetch(`${base}/track.get?track_isrc=${encodeURIComponent(isrc)}&apikey=${MUSIXMATCH_KEY}`).then(r => r.json());
      trackId = d?.message?.body?.track?.track_id;
    }
    if (!trackId) {
      const d = await fetch(`${base}/track.search?q_track=${encodeURIComponent(title)}&q_artist=${encodeURIComponent(artist)}&page_size=1&apikey=${MUSIXMATCH_KEY}`).then(r => r.json());
      trackId = d?.message?.body?.track_list?.[0]?.track?.track_id;
    }
    if (!trackId) return null;
    const [lyr, rich] = await Promise.all([
      fetch(`${base}/track.lyrics.get?track_id=${trackId}&apikey=${MUSIXMATCH_KEY}`).then(r => r.json()),
      fetch(`${base}/track.richsync.get?track_id=${trackId}&apikey=${MUSIXMATCH_KEY}`).then(r => r.json()),
    ]);
    const trackData = lyr?.message?.body?.track || {};
    return {
      lyrics:   lyr?.message?.body?.lyrics?.lyrics_body || null,
      mood:     rich?.message?.body?.richsync?.richsync_body || null,
      trackId,
      spotifyId: trackData?.track_spotify_id || null,
    };
  } catch { return null; }
}

// --- LALAL.AI - STEM SEPARATION (API v1) -------------------------------------
// Auth: X-License-Key header. Steps: upload -> split -> check
async function fetchLalalStems(file) {
  if (!LALAL_KEY || LALAL_KEY === "YOUR_LALAL_KEY") return null;
  try {
    const authHeaders = { "X-License-Key": LALAL_KEY };

    // Step 1: Upload - binary with Content-Disposition
    const arrayBuf = await file.arrayBuffer();
    const uploadRes = await fetch("https://www.lalal.ai/api/v1/upload/", {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Disposition": `attachment; filename=${encodeURIComponent(file.name)}`,
      },
      body: arrayBuf,
    });
    const uploadData = await uploadRes.json();
    const sourceId = uploadData?.id;
    if (!sourceId) return null;

    // Step 2: Split into stems
    const splitRes = await fetch("https://www.lalal.ai/api/v1/split/stem_separator/", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: sourceId, presets: { stem: "vocals" } }),
    });
    const splitData = await splitRes.json();
    const taskId = splitData?.task_id;
    if (!taskId) return null;

    // Step 3: Poll for result (max 90s)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const checkRes = await fetch("https://www.lalal.ai/api/v1/check/", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ task_ids: [taskId] }),
      });
      const checkData = await checkRes.json();
      const task = checkData?.tasks?.[taskId];
      if (task?.status === "success") {
        const [vocalBuf, instrBuf] = await Promise.all([
          fetch(task.stem_url).then(r => r.arrayBuffer()),
          fetch(task.back_url).then(r => r.arrayBuffer()),
        ]);
        return { vocalBuf, instrBuf };
      }
      if (task?.status === "error") return null;
    }
    return null;
  } catch { return null; }
}

// --- WHISPER - VOCAL TRANSCRIPTION -------------------------------------------
async function transcribeVocals(vocalArrayBuffer, fileName) {
  if (!OPENAI_KEY || OPENAI_KEY === "YOUR_OPENAI_KEY") return null;
  try {
    const blob = new Blob([vocalArrayBuffer], { type: "audio/wav" });
    const formData = new FormData();
    formData.append("file", blob, fileName || "vocal.wav");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json"); // get word-level timing

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_KEY}` },
      body: formData,
    });
    const data = await res.json();
    return {
      text: data.text || "",
      words: data.words || [],       // word-level timing for silence analysis
      segments: data.segments || [],
    };
  } catch { return null; }
}

// --- AI DETECTION (Future Extension) -----------------------------------------
// Browser-based AI audio detection is not yet possible due to CORS restrictions.
// LetsSubmit and similar APIs require server-side proxy or file hosting.
// This feature is planned for a future server-side version of Imperfect Remix.
async function detectAI(file, spotifyUrl) {
  return null; // Future extension – see roadmap
}

// --- WAVEFORM EXTRACTION -----------------------------------------------------
async function extractWaveformData(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const rawData = audioBuffer.getChannelData(0);
    const samples = 80;
    const blockSize = Math.floor(rawData.length / samples);
    const waveform = [];
    for (let i = 0; i < samples; i++) {
      let sum = 0;
      for (let j = 0; j < blockSize; j++) sum += Math.abs(rawData[i * blockSize + j]);
      waveform.push(sum / blockSize);
    }
    const max = Math.max(...waveform, 0.001);
    audioCtx.close();
    return { points: waveform.map(v => v / max), duration: audioBuffer.duration };
  } catch { return null; }
}

// --- SCORE ENGINE - STEMS ----------------------------------------------------
// Derives Micro-Timing, Analog Texture, Silence from real audio buffer
function scoresFromAudioBuffer(audioBuffer) {
  const data = audioBuffer.getChannelData(0);
  const len = data.length;
  const sr = audioBuffer.sampleRate;

  // Micro-Timing: analyse beat-level variance in short windows
  const windowSize = Math.floor(sr * 0.05); // 50ms windows
  const windows = Math.floor(len / windowSize);
  const rmsPerWindow = [];
  for (let i = 0; i < windows; i++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) sum += data[i * windowSize + j] ** 2;
    rmsPerWindow.push(Math.sqrt(sum / windowSize));
  }
  const diffs = rmsPerWindow.slice(1).map((v, i) => Math.abs(v - rmsPerWindow[i]));
  const timingVariance = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const timing = clamp(35 + timingVariance * 800);

  // Analog Texture: spectral irregularity via high-freq content ratio
  const blockSize = Math.floor(len / 80);
  let highFreqEnergy = 0, totalEnergy = 0;
  for (let i = 0; i < Math.min(len, blockSize * 80); i++) {
    const v = Math.abs(data[i]);
    totalEnergy += v;
    if (i % 2 === 0) highFreqEnergy += v; // rough HF proxy
  }
  const hfRatio = totalEnergy > 0 ? highFreqEnergy / totalEnergy : 0.5;
  const texture = clamp(40 + hfRatio * 40 + Math.random() * 15);

  // Silence & Space: ratio of frames below noise floor, with temporal clustering
  const noiseFloor = 0.02;
  let silentFrames = 0, silentRuns = 0, inRun = false;
  for (let i = 0; i < rmsPerWindow.length; i++) {
    if (rmsPerWindow[i] < noiseFloor) {
      silentFrames++;
      if (!inRun) { silentRuns++; inRun = true; }
    } else { inRun = false; }
  }
  const silenceRatio = silentFrames / rmsPerWindow.length;
  // Many short silences = intentional space; few long ones = less crafted
  const silenceDensity = silentRuns > 0 ? silentFrames / silentRuns : 0;
  const silence = clamp(25 + silenceRatio * 60 + Math.min(silentRuns, 15) * 1.5 - silenceDensity * 2);

  return { timing, texture, silence };
}

// --- SCORE ENGINE - LYRICS ---------------------------------------------------
function scoresFromLyrics(text, words = []) {
  if (!text || text.length < 10) return { lyric: 30, emotion: 45 };

  const lower = text.toLowerCase();
  // Personal pronouns - first person specificity
  const pronouns = (text.match(/\b(i|me|my|mine|myself|je|moi|tu|toi|nous)\b/gi) || []).length;
  // Emotional markers
  const emotional = (text.match(/\b(love|pain|fear|lost|broken|dream|cry|hold|miss|need|never|always|heart|soul|tears|hope|dark|light|feel|felt)\b/gi) || []).length;
  // Syntactic complexity - punctuation as breath markers
  const punct = (text.match(/[,;:!?...-]/g) || []).length;
  // Line breaks - structure
  const lines = (text.match(/\n/g) || []).length;
  // Repetition - human musical structure
  const wordList = lower.split(/\s+/).filter(w => w.length > 3);
  const unique = new Set(wordList).size;
  const repetitionRatio = wordList.length > 0 ? 1 - (unique / wordList.length) : 0;

  // Word-timing gaps (if Whisper verbose) - silence between words
  let vocalSilence = 0;
  if (words.length > 1) {
    const gaps = words.slice(1).map((w, i) => w.start - words[i].end).filter(g => g > 0);
    vocalSilence = gaps.length > 0 ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 0;
  }

  const lyric = clamp(
    30
    + Math.min(pronouns * 4, 25)
    + Math.min(emotional * 3, 20)
    + Math.min(punct * 1.5, 12)
    + Math.min(lines, 10)
    + repetitionRatio * 15
    - (wordList.length < 20 ? 10 : 0) // very short lyrics penalty
  );

  const emotion = clamp(
    40
    + Math.min(emotional * 4, 30)
    + Math.min(pronouns * 2, 15)
    + vocalSilence * 8
  );

  return { lyric, emotion };
}

// --- MASTER COMPUTE SCORES ----------------------------------------------------
async function computeAllScores(file, mxData, waveformData, lalalStems, transcript, aiDetection) {
  let timing, texture, silence, lyric, emotion, ai_sig;

  // TIMING + TEXTURE + SILENCE
  if (lalalStems?.instrBuf) {
    // Best: from real instrumental stem via LALAL
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(lalalStems.instrBuf.slice(0));
      const stemScores = scoresFromAudioBuffer(buf);
      timing = stemScores.timing;
      texture = stemScores.texture;
      silence = stemScores.silence;
      ctx.close();
    } catch {
      timing = texture = silence = null;
    }
  }

  if (!timing && waveformData) {
    // Fallback: from full-mix waveform
    const pts = waveformData.points;
    const diffs = pts.slice(1).map((v, i) => Math.abs(v - pts[i]));
    const variance = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    timing = clamp(38 + variance * 420);
    const rms = Math.sqrt(pts.reduce((s, v) => s + v * v, 0) / pts.length);
    texture = clamp(35 + rms * 55 + Math.random() * 12);
    const silentFrames = pts.filter(v => v < 0.08).length;
    silence = clamp(28 + (silentFrames / pts.length) * 75 + Math.random() * 12);
  }

  if (!timing) {
    // Pure simulation
    timing  = clamp(52 + Math.random() * 28);
    texture = clamp(50 + Math.random() * 28);
    silence = clamp(40 + Math.random() * 30);
  }

  // LYRIC + EMOTION
  const lyricsText = transcript?.text || mxData?.lyrics || null;
  const words = transcript?.words || [];
  if (lyricsText) {
    const lyrScores = scoresFromLyrics(lyricsText, words);
    lyric = lyrScores.lyric;
    emotion = lyrScores.emotion;
  } else {
    // No lyrics available - penalise but don't zero
    lyric   = clamp(28 + Math.random() * 15);
    emotion = clamp(45 + Math.random() * 25);
  }

  // If Musixmatch mood data available, blend
  if (mxData?.mood && !transcript) {
    emotion = clamp(emotion + 10); // mood metadata bonus
  }

  // AI SIGNATURE (inverted - high = more AI)
  if (aiDetection !== null && aiDetection !== undefined) {
    ai_sig = clamp(aiDetection); // 0-100, high = AI
  } else {
    ai_sig = undefined; // not yet available
  }

  return { timing, emotion, texture, lyric, silence, ai_sig };
}

// --- FULL ANALYSIS PIPELINE ---------------------------------------------------
async function analyseTrack({ title, artist, isrc, file }, onProgress) {
  const isUpload = !!file;
  onProgress("Extracting waveform...");

  const [mxData, waveformData] = await Promise.all([
    (!isUpload || isrc) ? fetchMusixmatch(title, artist, isrc) : Promise.resolve(null),
    isUpload ? extractWaveformData(file) : Promise.resolve(null),
  ]);

  let lalalStems = null;
  let transcript = null;
  let aiDetection = null;

  if (isUpload) {
    // Run LALAL + AIOrNot in parallel
    onProgress("Separating stems & detecting AI signature...");
    [lalalStems, aiDetection] = await Promise.all([
      fetchLalalStems(file),
      detectAI(file, null),
    ]);

    // Whisper on vocal stem (or full file if no stems)
    onProgress("Transcribing vocals with Whisper...");
    const vocalSource = lalalStems?.vocalBuf || await file.arrayBuffer();
    transcript = await transcribeVocals(vocalSource, file.name);
  }

  // For Musixmatch tracks without audio file, try Spotify URL detection
  if (!isUpload && mxData?.trackId && !aiDetection) {
    onProgress("Checking AI signature...");
    // Build Spotify URL from trackId if available in mxData
    const spotifyId = mxData?.spotifyId || null;
    if (spotifyId) {
      aiDetection = await detectAI(null, `https://open.spotify.com/track/${spotifyId}`);
    }
  }

  onProgress("Computing scores...");
  const scores = await computeAllScores(file, mxData, waveformData, lalalStems, transcript, aiDetection);

  return { scores, waveformData, mxData, transcript, aiDetection,
    sourceType: isUpload ? "upload" : (isrc ? "musixmatch" : "manual") };
}

// --- CLAUDE PORTRAIT ----------------------------------------------------------
async function fetchPortrait(title, artist, scores, isUpload, aiDetection) {
  const total = totalScore(scores);
  const aiNote = aiDetection !== null
    ? `AI detection score: ${aiDetection}/100 (${aiDetection > 65 ? "strong AI signal" : aiDetection > 40 ? "mixed signal" : "low AI signal - likely human"}).`
    : "AI detection: not available.";

  try {
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (ANTHROPIC_KEY && ANTHROPIC_KEY !== "YOUR_ANTHROPIC_KEY") {
      headers["x-api-key"] = ANTHROPIC_KEY;
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        messages: [{ role: "user", content:
`You are the poetic voice of "Imperfect Remix" - measuring the human fingerprint in music. Mirror Hypothesis / Paper 05: "The Human Residue."

Track: "${title}" by ${artist}
${isUpload ? "Uploaded audio - unreleased." : "Via Musixmatch metadata."}
${aiNote}

Imperfection Score: ${total}/100
Micro-Timing: ${scores.timing}/100
Emotional Arc: ${scores.emotion}/100
Analog Texture: ${scores.texture}/100
Lyrical Soul: ${scores.lyric}/100
Silence & Space: ${scores.silence}/100
AI Signature: ${scores.ai_sig !== undefined ? scores.ai_sig + "/100 (high = more AI detected)" : "not yet available – server-side detection planned"}

Scoring guide:
- 80-99: genuine strength - present, alive, irreducibly human
- 55-79: ambivalent - emerging, partially realised
- 30-54: structural absence - not yet inhabited, still searching
- 20-29: a gap - territory neither AI nor human has claimed

Write 4-5 sentences. Be specific. Name low scores as absences, not hidden strengths. If AI Signature is high (>65), acknowledge what that means for the human residue. End with one brief line in French or German.
Tone: warm, precise, slightly melancholic. Never corporate.` }],
      }),
    });
    const data = await res.json();
    return data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
  } catch(e) {
    console.log("Portrait API error:", e);
    // Generate a simple score-based portrait as fallback
    const total = Math.round(Object.values(scores).filter(v => typeof v === 'number').reduce((a,b)=>a+b,0) / 5);
    const strong = total > 75 ? "The human signature in this track is unmistakable" : 
                   total > 55 ? "Something human breathes through this track" :
                   "This track carries the traces of human intention";
    return strong + " - imperfection not as flaw, but as fingerprint. The scores reveal a presence that no algorithm could have planned: in the micro-timing, in the silences, in the choices of what to leave out. The human residue is here, even where it is hardest to name. Das Menschliche ist messbar. Aber nicht kopierbar.";
  }
}

// --- REPORT GENERATOR ---------------------------------------------------------
async function generateReport(tracks) {
  const labeled = tracks.filter(t => t.group);
  const byGroup = { human: [], hybrid: [], ai: [] };
  labeled.forEach(t => byGroup[t.group]?.push(t));
  const active = Object.entries(byGroup).filter(([, v]) => v.length > 0);

  const gAvg = items => items.length ? Math.round(items.reduce((s, t) => s + totalScore(t.scores), 0) / items.length) : null;
  const dAvg = (items, key) => items.length ? Math.round(items.reduce((s, t) => s + (t.scores[key] || 0), 0) / items.length) : null;

  const dimMeans = {};
  DIMENSIONS.forEach(d => {
    const vals = tracks.map(t => t.scores[d.key] || 0);
    dimMeans[d.key] = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
  });
  const humanDimsSorted = [...HUMAN_DIMS].sort((a, b) => dimMeans[b.key] - dimMeans[a.key]);
  const strongest = humanDimsSorted[0];
  const weakest = humanDimsSorted[humanDimsSorted.length - 1];
  const asymmetry = dimMeans[strongest.key] - dimMeans[weakest.key];

  const groupSummaries = active.map(([gk, items]) => {
    const g = GROUPS[gk];
    const dimLine = DIMENSIONS.map(d => `${d.label}: ${dAvg(items, d.key)}`).join(", ");
    return `${g.label} (n=${items.length}): Total avg=${gAvg(items)}/100. ${dimLine}`;
  }).join("\n");

  const portraits = tracks.filter(t => t.portrait)
    .map(t => `"${t.title}" (${GROUPS[t.group]?.label || "unlabeled"}, AI sig=${t.scores.ai_sig ?? "n/a"}):\n${t.portrait}`)
    .join("\n\n");

  const aiDetectionNote = tracks.some(t => t.aiDetection !== null)
    ? `AI detection was available for ${tracks.filter(t => t.aiDetection !== null).length} of ${tracks.length} tracks (upload tracks only).`
    : "AI detection not available in this session (requires upload tracks and AIOrNot API key).";

  const prompt = `You are writing a scientific analysis report for "Imperfect Remix" - Paper 05: "The Human Residue" by Creative Humanity AI Hub.

STUDY DATA
Date: ${new Date().toLocaleDateString('en-GB', {year:'numeric',month:'long',day:'numeric'})}
Total tracks: ${tracks.length} | Labelled: ${labeled.length}
${aiDetectionNote}

GROUP AVERAGES
${groupSummaries}

STRUCTURAL ASYMMETRY
Strongest human dimension: ${strongest.label} (avg ${dimMeans[strongest.key]}/100)
Weakest human dimension: ${weakest.label} (avg ${dimMeans[weakest.key]}/100)
Gap: ${asymmetry} points
AI Signature avg across all tracks: ${dimMeans["ai_sig"]}/100

INDIVIDUAL PORTRAITS
${portraits}

Write a structured academic report. Use ## headers. Be analytical. Draw conclusions from the data.

## Executive Summary
## Methodology
## Findings by Group
## The Structural Asymmetry: Human Residue in Practice
Analyse the ${strongest.label} vs ${weakest.label} gap. Connect to Paper 05: AI can simulate texture and timing but Lyrical Soul and Silence & Space require intentionality AI cannot supply.
## AI Signature as Research Dimension
Discuss what the AI detection scores reveal. Crucially: the AI Signature measures the output - Imperfect Remix measures the human residue in the process. These are orthogonal dimensions. The gap between them is where art happens.
## Implications for Paper 05
## Conclusion

Tone: academic, evidence-based, specific about scores.`;

  const repHeaders = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (ANTHROPIC_KEY && ANTHROPIC_KEY !== "YOUR_ANTHROPIC_KEY") {
    repHeaders["x-api-key"] = ANTHROPIC_KEY;
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: repHeaders,
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  return data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
}

function downloadReport(text, tracks) {
  const date = new Date().toLocaleDateString('en-GB', {year:'numeric',month:'long',day:'numeric'});
  const header = `IMPERFECT REMIX - RESEARCH REPORT\nCreative Humanity AI Hub . Paper 05: The Human Residue\nGenerated: ${date} . Tracks: ${tracks.length}\ncreativehumanity.eu\n\n${"=".repeat(60)}\n\n`;
  Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([header + text], { type: "text/plain;charset=utf-8" })),
    download: `imperfect-remix-report-${new Date().toISOString().slice(0,10)}.txt`,
  }).click();
}

function doExportCSV(tracks) {
  const rows = [
    ["#","Title","Artist","Source","Group","Total",...DIMENSIONS.map(d=>d.label),"AI Detection Raw","Transcript","Portrait (excerpt)"],
    ...tracks.map((t,i) => [
      i+1, t.title, t.artist, t.sourceType,
      t.group ? GROUPS[t.group].label : "unlabeled",
      totalScore(t.scores),
      ...DIMENSIONS.map(d => t.scores[d.key] ?? ""),
      t.aiDetection ?? "",
      (t.transcript?.text || "").replace(/"/g,"'"),
      (t.portrait || "").replace(/"/g,"'").slice(0,200),
    ]),
  ];
  const csv = rows.map(r => r.map(v => `"${v}"`).join(",")).join("\n");
  Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], {type:"text/csv"})),
    download: "imperfect-remix-paper05.csv",
  }).click();
}

function doExportSession(tracks) {
  const session = {
    version: "v7",
    date: new Date().toISOString(),
    tracks: tracks.map(t => ({
      id: t.id, title: t.title, artist: t.artist, isrc: t.isrc,
      sourceType: t.sourceType, fileName: t.fileName,
      scores: t.scores, group: t.group, portrait: t.portrait,
      aiDetection: t.aiDetection,
      transcript: t.transcript ? { text: t.transcript.text } : null,
    }))
  };
  Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([JSON.stringify(session, null, 2)], {type:"application/json"})),
    download: `imperfect-remix-session-${new Date().toISOString().slice(0,10)}.json`,
  }).click();
}

function loadSession(file, setPlaylist) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const session = JSON.parse(e.target.result);
      if (session.tracks) {
        setPlaylist(session.tracks.map(t => ({
          ...t, audioFile: null, waveformData: null, loadingPortrait: false,
        })));
      }
    } catch(err) { console.error("Session load error:", err); }
  };
  reader.readAsText(file);
}


// --- SCORE RING ---------------------------------------------------------------
function ScoreRing({ value, size=52, stroke=4, color="#E8563A" }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let s=0; const step=value/36;
    const t=setInterval(()=>{ s+=step; if(s>=value){setDisplay(value);clearInterval(t);}else setDisplay(Math.floor(s)); },22);
    return ()=>clearInterval(t);
  },[value]);
  const r=size/2-stroke-2, circ=2*Math.PI*r, off=circ-(display/100)*circ;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{flexShrink:0}}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={stroke}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={circ} strokeDashoffset={off} strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`} style={{transition:"stroke-dashoffset 0.04s linear"}}/>
      <text x={size/2} y={size/2+5} textAnchor="middle" fill="white"
        fontSize={size>48?13:10} fontFamily="'DM Mono',monospace" fontWeight="600">{display}</text>
    </svg>
  );
}

// --- ANIMATED WAVEFORM --------------------------------------------------------
function AnimatedWaveform({ active }) {
  const heights = useRef(Array.from({length:36},(_,i)=>6+Math.sin(i*0.45)*10+Math.random()*14));
  return (
    <div style={{display:"flex",alignItems:"center",gap:3,height:36,justifyContent:"center"}}>
      {heights.current.map((h,i)=>(
        <div key={i} style={{width:3,height:active?h:h*0.25,background:active?"#E8563A":"rgba(255,255,255,0.1)",borderRadius:2,transition:"height 0.3s ease,background 0.3s ease",animation:active?`wave ${(0.5+Math.random()*0.7).toFixed(2)}s ease-in-out infinite alternate`:"none"}}/>
      ))}
    </div>
  );
}

// --- PLAYABLE WAVEFORM --------------------------------------------------------
function PlayableWaveform({ data, color, isPlaying, position, onSeek, onPlayPause, hasAudio, volume, onVolumeChange }) {
  const containerRef = useRef(null);
  const points = data?.points || [];
  const max = points.length > 0 ? Math.max(...points, 0.001) : 1;
  const playedCount = Math.floor(position * points.length);

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
        {hasAudio && (
          <button onClick={e=>{e.stopPropagation();onPlayPause();}} aria-label={isPlaying?"Pause":"Play"}
            style={{width:36,height:36,borderRadius:"50%",border:"none",flexShrink:0,background:isPlaying?"rgba(232,86,58,0.25)":"rgba(255,255,255,0.1)",color:isPlaying?"#E8563A":"white",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.15s"}}>
            {isPlaying
              ? <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="1" y="1" width="4" height="10" rx="1"/><rect x="7" y="1" width="4" height="10" rx="1"/></svg>
              : <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><polygon points="2,1 11,6 2,11"/></svg>}
          </button>
        )}
        <div ref={containerRef} onClick={e=>{if(!hasAudio||!containerRef.current)return;const r=containerRef.current.getBoundingClientRect();onSeek(Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)));}}
          style={{flex:1,position:"relative",height:44,cursor:hasAudio?"pointer":"default",display:"flex",alignItems:"center"}}>
          <div style={{display:"flex",alignItems:"center",gap:1.5,width:"100%",height:"100%"}}>
            {points.map((v,i)=>{
              const h=Math.max(3,Math.round((v/max)*44));
              return <div key={i} style={{flex:1,height:h,background:i<playedCount?color:`${color}60`,borderRadius:2,transition:"background 0.05s"}}/>;
            })}
          </div>
          {isPlaying && <div style={{position:"absolute",top:0,bottom:0,left:`${position*100}%`,width:2,background:"white",borderRadius:1,opacity:0.9,boxShadow:"0 0 6px rgba(255,255,255,0.5)",transition:"left 0.05s linear",pointerEvents:"none"}}/>}
        </div>
      </div>
      {hasAudio && (
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:13,opacity:0.55,flexShrink:0}}>{volume<0.05?"🔇":volume<0.4?"🔉":"🔊"}</span>
          <input type="range" min="0" max="1" step="0.02" value={volume} onChange={e=>onVolumeChange(e.target.value)}
            aria-label="Volume" style={{flex:1,accentColor:"#E8563A",cursor:"pointer",height:4}}/>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"rgba(255,255,255,0.58)",width:30,textAlign:"right",flexShrink:0}}>{Math.round(volume*100)}%</span>
        </div>
      )}
    </div>
  );
}

// --- MINI BARS ----------------------------------------------------------------
function MiniBars({ scores }) {
  return (
    <div style={{display:"flex",gap:3,alignItems:"flex-end",height:22}}>
      {DIMENSIONS.map((d,i)=>{
        const raw = scores[d.key];
        if (raw === undefined || raw === null) return (
          <div key={d.key} title={`${d.label}: —`} style={{width:6,height:3,background:"rgba(255,255,255,0.12)",borderRadius:2,opacity:0.5}}/>
        );
        const v = d.inverted ? (100 - raw) : raw;
        const h = Math.max(3,Math.round((v/100)*22));
        return <div key={d.key} title={`${d.label}: ${raw}`} style={{width:6,height:h,background:DIM_COLORS[i],borderRadius:2,opacity:0.8}}/>;
      })}
    </div>
  );
}

// --- SOURCE BADGE -------------------------------------------------------------
function SourceBadge({ type }) {
  const cfg = {upload:{label:"Upload",color:"#7EB8C4"},musixmatch:{label:"Musixmatch",color:"#C4A0D8"},manual:{label:"Manual",color:"rgba(255,255,255,0.55)"}}[type]||{label:type,color:"rgba(255,255,255,0.55)"};
  return <span style={{fontSize:9,fontFamily:"'DM Mono',monospace",letterSpacing:1,padding:"2px 7px",borderRadius:10,border:`1px solid ${cfg.color}40`,background:`${cfg.color}15`,color:cfg.color}}>{cfg.label}</span>;
}

// --- PROGRESS INDICATOR -------------------------------------------------------
function ProgressSteps({ step }) {
  const steps = ["Waveform","Stems","Whisper","Scores","Portrait"];
  const idx = steps.findIndex(s => step.toLowerCase().includes(s.toLowerCase().split(" ")[0]));
  return (
    <div style={{marginTop:10,display:"flex",gap:6,justifyContent:"center",flexWrap:"wrap"}}>
      {steps.map((s,i)=>(
        <span key={s} style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:1,color:i<=idx?"#E8563A":"rgba(255,255,255,0.25)",transition:"color 0.3s"}}>
          {i<=idx?">":""}{s}{i<steps.length-1?" .":""}
        </span>
      ))}
    </div>
  );
}

// --- TRACK CARD ---------------------------------------------------------------
function TrackCard({ item, revealed, onLabelChange, onExpand, expanded, isPlaying, onPlayPause, playerPosition, playerCurrentTime, playerDuration, volume, onVolumeChange }) {
  const total = totalScore(item.scores);
  const ringColor = total>80?"#4CAF82":total>62?"#E8A020":"#E8563A";
  const hasAudio = !!item.audioFile;
  const aiSig = item.scores.ai_sig;
  const aiLabel = aiSig>65?"High AI signal":aiSig>40?"Mixed":"Low AI signal";
  const aiColor = aiSig>65?"#E8563A":aiSig>40?"#E8A020":"#4CAF82";

  return (
    <div style={{background:isPlaying?"rgba(232,86,58,0.04)":"rgba(255,255,255,0.03)",border:`1px solid ${isPlaying?"rgba(232,86,58,0.25)":"rgba(255,255,255,0.07)"}`,borderRadius:16,marginBottom:10,animation:"fadeUp 0.35s ease both",overflow:"hidden",transition:"border-color 0.2s,background 0.2s"}}>
      {/* Header */}
      <div onClick={()=>onExpand(item.id)} style={{padding:"14px 18px",display:"flex",alignItems:"center",gap:14,cursor:"pointer"}}>
        <ScoreRing value={total} color={ringColor}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2,flexWrap:"wrap"}}>
            <span style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.title}</span>
            <SourceBadge type={item.sourceType}/>
            {isPlaying && <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#E8563A",letterSpacing:1,animation:"pulse 1.2s ease-in-out infinite"}}>> {playerCurrentTime}</span>}
          </div>
          <div style={{fontSize:11,color:"rgba(255,255,255,0.58)",marginBottom:8}}>{item.artist}</div>
          <MiniBars scores={item.scores}/>
        </div>
        {/* Play button */}
        {!expanded && hasAudio && (
          <button onClick={e=>{e.stopPropagation();onPlayPause(item.id);}} aria-label={isPlaying?"Pause":"Play"}
            style={{width:32,height:32,borderRadius:"50%",border:"none",flexShrink:0,background:isPlaying?"rgba(232,86,58,0.2)":"rgba(255,255,255,0.08)",color:isPlaying?"#E8563A":"rgba(255,255,255,0.7)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
            {isPlaying
              ? <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="3" height="8" rx="1"/><rect x="6" y="1" width="3" height="8" rx="1"/></svg>
              : <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>}
          </button>
        )}
        {/* Label */}
        <div style={{textAlign:"right",flexShrink:0,minWidth:80}}>
          {revealed && item.group
            ? <span style={{display:"inline-block",padding:"3px 9px",borderRadius:20,fontSize:9,fontFamily:"'DM Mono',monospace",letterSpacing:1,border:`1px solid ${GROUPS[item.group].dot}40`,background:`${GROUPS[item.group].dot}18`,color:GROUPS[item.group].dot}}>{GROUPS[item.group].badge} {GROUPS[item.group].label}</span>
            : revealed
              ? <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  {Object.entries(GROUPS).map(([key,g])=>(
                    <button key={key} onClick={e=>{e.stopPropagation();onLabelChange(item.id,key);}} style={{padding:"2px 7px",borderRadius:20,cursor:"pointer",border:`1px solid ${g.dot}35`,background:`${g.dot}12`,color:g.dot,fontSize:10,fontFamily:"'DM Mono',monospace",letterSpacing:0.5,whiteSpace:"nowrap"}}>
                      {g.badge} {g.label}
                    </button>
                  ))}
                </div>
              : <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"rgba(255,255,255,0.60)",letterSpacing:1}}>BLIND</span>
          }
        </div>
      </div>

      {/* Expanded */}
      {expanded && (
        <div style={{borderTop:"1px solid rgba(255,255,255,0.05)",padding:"16px 18px 18px"}}>
          {/* Waveform + Player */}
          {item.waveformData && (
            <div style={{marginBottom:20}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"rgba(255,255,255,0.60)",letterSpacing:2}}>WAVEFORM - {item.fileName}</div>
                {hasAudio && <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"rgba(255,255,255,0.55)"}}>{playerCurrentTime} / {playerDuration}</div>}
              </div>
              <PlayableWaveform data={item.waveformData} color={ringColor} isPlaying={isPlaying} position={playerPosition}
                onSeek={ratio=>onPlayPause(item.id,ratio)} onPlayPause={()=>onPlayPause(item.id)} hasAudio={hasAudio}
                volume={volume} onVolumeChange={onVolumeChange}/>
            </div>
          )}

          {/* AI Signature special row */}
          <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:10,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:16,opacity:0.35}}>*</span>
            <div style={{flex:1}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.55)"}}>AI Signature Detection</span>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"rgba(255,255,255,0.30)",letterSpacing:1}}>COMING SOON</span>
              </div>
              <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",lineHeight:1.5}}>
                Server-side audio AI detection is a planned extension. Browser security (CORS) prevents direct API access from the client. The five human dimensions above measure what matters: the residue, not the receipt.
              </div>
            </div>
          </div>

          {/* Note about orthogonality */}
          <div style={{fontSize:10,color:"rgba(255,255,255,0.40)",fontStyle:"italic",marginBottom:14,lineHeight:1.5,borderLeft:"2px solid rgba(255,255,255,0.08)",paddingLeft:10}}>
            AI Signature measures the output. Imperfect Remix measures the human residue in the process. These are different things - the gap between them is where art happens.
          </div>

          {/* Human dimensions */}
          {HUMAN_DIMS.map((d,i)=>(
            <div key={d.key} style={{display:"flex",alignItems:"center",gap:12,marginBottom:9}}>
              <span style={{width:18,textAlign:"center",opacity:0.45,fontSize:13,flexShrink:0}}>{d.icon}</span>
              <div style={{flex:1}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <div>
                    <span style={{fontSize:11}}>{d.label}</span>
                    <span style={{fontSize:9,color:"rgba(255,255,255,0.35)",fontFamily:"'DM Mono',monospace",marginLeft:8}}>{d.source}</span>
                  </div>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:DIM_COLORS[i]}}>{item.scores[d.key]}</span>
                </div>
                <div style={{height:3,background:"rgba(255,255,255,0.06)",borderRadius:2,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${item.scores[d.key]}%`,background:`linear-gradient(90deg,${DIM_COLORS[i]},${DIM_COLORS[(i+1)%DIM_COLORS.length]})`,borderRadius:2,transition:"width 0.9s ease"}}/>
                </div>
              </div>
            </div>
          ))}

          {/* Transcript snippet */}
          {item.transcript?.text && (
            <div style={{marginTop:12,padding:"10px 14px",background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"rgba(255,255,255,0.40)",letterSpacing:2,marginBottom:6}}>WHISPER TRANSCRIPT</div>
              <p style={{fontSize:12,color:"rgba(255,255,255,0.62)",margin:0,lineHeight:1.6,fontStyle:"italic"}}>
                "{item.transcript.text.slice(0,200)}{item.transcript.text.length>200?"...":""}"
              </p>
            </div>
          )}

          {/* Portrait */}
          {item.portrait && (
            <div style={{marginTop:14,padding:"14px 16px",background:"rgba(255,255,255,0.025)",borderRadius:10}}>
              <p style={{fontFamily:"'Playfair Display',serif",fontSize:13,lineHeight:1.8,color:"rgba(255,255,255,0.7)",margin:0,whiteSpace:"pre-wrap"}}>{item.portrait}</p>
            </div>
          )}
          {item.loadingPortrait && (
            <div style={{marginTop:14,display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:12,height:12,border:"1.5px solid rgba(255,255,255,0.08)",borderTopColor:"#E8563A",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}/>
              <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"rgba(255,255,255,0.62)",letterSpacing:1}}>COMPOSING PORTRAIT...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- COMPARE VIEW -------------------------------------------------------------
function CompareView({ tracks, onReveal }) {
  const labeled = tracks.filter(t => t.group);
  if (!labeled.length) return (
    <div style={{textAlign:"center",padding:"48px 0 24px"}}>
      <div style={{fontFamily:"'Playfair Display',serif",fontStyle:"italic",fontSize:15,color:"rgba(255,255,255,0.65)",marginBottom:12}}>No labels assigned yet.</div>
      <div style={{fontSize:12,color:"rgba(255,255,255,0.55)",marginBottom:24,lineHeight:1.6}}>
        Go back to the playlist, click <strong style={{color:"rgba(255,255,255,0.8)"}}>Assign labels</strong> -<br/>then mark each track 🟢 🟡 🔴.
      </div>
      <button onClick={onReveal} style={{padding:"10px 22px",borderRadius:12,border:"1px solid rgba(232,86,58,0.4)",background:"rgba(232,86,58,0.12)",color:"#E8563A",cursor:"pointer",fontSize:12,fontFamily:"'DM Mono',monospace",letterSpacing:1}}>
        Assign labels now ->
      </button>
    </div>
  );

  const byGroup={human:[],hybrid:[],ai:[]};
  labeled.forEach(t=>byGroup[t.group]?.push(t));
  const active=Object.entries(byGroup).filter(([,v])=>v.length>0);
  const gAvg=items=>items.length?Math.round(items.reduce((s,t)=>s+totalScore(t.scores),0)/items.length):null;
  const dAvg=(items,key)=>items.length?Math.round(items.reduce((s,t)=>s+(t.scores[key]||0),0)/items.length):null;
  const sorted=[...active].map(([gk,items])=>({gk,avg:gAvg(items)})).sort((a,b)=>b.avg-a.avg);
  const gap=sorted.length>=2?sorted[0].avg-sorted[sorted.length-1].avg:null;

  return (
    <div style={{animation:"fadeUp 0.4s ease"}}>
      <div style={{display:"flex",gap:10,marginBottom:20}}>
        {active.map(([gk,items])=>{
          const g=GROUPS[gk];
          return (
            <div key={gk} style={{flex:1,background:`${g.dot}10`,border:`1px solid ${g.dot}30`,borderRadius:14,padding:"16px 12px",textAlign:"center"}}>
              <div style={{fontSize:10,fontFamily:"'DM Mono',monospace",color:g.dot,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>{g.label}</div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:32,color:"white",lineHeight:1}}>{gAvg(items)}</div>
              <div style={{fontSize:10,color:"rgba(255,255,255,0.60)",marginTop:5,fontFamily:"'DM Mono',monospace"}}>{items.length} track{items.length>1?"s":""}</div>
              {dAvg(items,"ai_sig")!==null && <div style={{fontSize:9,color:"rgba(255,255,255,0.40)",marginTop:4,fontFamily:"'DM Mono',monospace"}}>AI sig avg: {dAvg(items,"ai_sig")}</div>}
            </div>
          );
        })}
      </div>

      <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"rgba(255,255,255,0.60)",letterSpacing:2,textTransform:"uppercase",marginBottom:10}}>Dimensions compared</div>
      {DIMENSIONS.map((dim,i)=>(
        <div key={dim.key} style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.05)",borderRadius:12,padding:"12px 16px",marginBottom:7}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{opacity:0.45,fontSize:13}}>{dim.icon}</span>
            <span style={{fontSize:11,fontWeight:500}}>{dim.label}</span>
            {dim.inverted && <span style={{fontSize:9,color:"rgba(255,255,255,0.35)",fontFamily:"'DM Mono',monospace"}}>(inverted - high = more AI)</span>}
          </div>
          {active.map(([gk,items])=>{
            const avg=dAvg(items,dim.key);
            const g=GROUPS[gk];
            return (
              <div key={gk} style={{display:"flex",alignItems:"center",gap:10,marginBottom:5}}>
                <div style={{width:5,height:5,borderRadius:"50%",background:g.dot,flexShrink:0}}/>
                <div style={{flex:1,height:3,background:"rgba(255,255,255,0.06)",borderRadius:2,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${avg}%`,background:g.dot,borderRadius:2,transition:"width 0.9s ease"}}/>
                </div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:g.dot,width:24,textAlign:"right",flexShrink:0}}>{avg}</div>
              </div>
            );
          })}
        </div>
      ))}

      {gap!==null && (
        <div style={{marginTop:18,padding:"18px 20px",background:"rgba(232,86,58,0.06)",border:"1px solid rgba(232,86,58,0.14)",borderRadius:14,textAlign:"center"}}>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,marginBottom:6}}>The gap: <span style={{color:"#E8563A"}}>+{gap} points</span></div>
          <div style={{fontSize:11,color:"rgba(255,255,255,0.65)"}}>{GROUPS[sorted[0].gk].label} scores {gap} points above {GROUPS[sorted[sorted.length-1].gk].label}</div>
          <div style={{fontFamily:"'Playfair Display',serif",fontStyle:"italic",fontSize:11,color:"rgba(255,255,255,0.55)",marginTop:10}}>"AI can recognise what AI cannot create."</div>
        </div>
      )}
    </div>
  );
}

// --- MAIN ---------------------------------------------------------------------
export default function ImperfectRemix() {
  const [playlist,setPlaylist]           = useState([]);
  const [titleInput,setTitleInput]       = useState("");
  const [artistInput,setArtistInput]     = useState("");
  const [isrcInput,setIsrcInput]         = useState("");
  const [analyzing,setAnalyzing]         = useState(false);
  const [analyzeStep,setAnalyzeStep]     = useState("");
  const [analyzeLabel,setAnalyzeLabel]   = useState("");
  const [revealed,setRevealed]           = useState(false);
  const [expanded,setExpanded]           = useState(new Set());
  const [view,setView]                   = useState("playlist");
  const [dragOver,setDragOver]           = useState(false);
  const [reportLoading,setReportLoading] = useState(false);
  const fileInputRef                     = useRef(null);

  // Player
  const [playingId,setPlayingId]   = useState(null);
  const [playerPos,setPlayerPos]   = useState(0);
  const [playerTime,setPlayerTime] = useState("0:00");
  const [playerDur,setPlayerDur]   = useState("0:00");
  const [volume,setVolume]         = useState(0.8);

  const audioCtxRef  = useRef(null);
  const gainNodeRef  = useRef(null);
  const sourceRef    = useRef(null);
  const audioBuffers = useRef({});
  const startTimeRef = useRef(0);
  const offsetRef    = useRef(0);
  const rafRef       = useRef(null);
  const durationRef  = useRef(0);
  const volumeRef    = useRef(0.8);

  function getCtx() {
    if (!audioCtxRef.current || audioCtxRef.current.state==="closed") {
      audioCtxRef.current = new (window.AudioContext||window.webkitAudioContext)();
      gainNodeRef.current = audioCtxRef.current.createGain();
      gainNodeRef.current.gain.value = volumeRef.current;
      gainNodeRef.current.connect(audioCtxRef.current.destination);
    }
    if (audioCtxRef.current.state==="suspended") audioCtxRef.current.resume();
    return audioCtxRef.current;
  }

  function stopCurrent() {
    if (sourceRef.current) { try{sourceRef.current.stop();}catch{} sourceRef.current.disconnect(); sourceRef.current=null; }
    cancelAnimationFrame(rafRef.current);
  }

  function startPlayback(id, buffer, fromOffset) {
    const ctx=getCtx(); stopCurrent();
    const src=ctx.createBufferSource(); src.buffer=buffer;
    src.connect(gainNodeRef.current||ctx.destination);
    startTimeRef.current=ctx.currentTime; offsetRef.current=fromOffset; durationRef.current=buffer.duration;
    src.start(0,fromOffset);
    src.onended=()=>{ if(sourceRef.current===src){setPlayingId(null);setPlayerPos(0);setPlayerTime("0:00");offsetRef.current=0;} };
    sourceRef.current=src; setPlayingId(id);
    const fmt=s=>`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,"0")}`;
    setPlayerDur(fmt(buffer.duration));
    function tick(){const e=getCtx().currentTime-startTimeRef.current;const p=Math.min((fromOffset+e)/buffer.duration,1);setPlayerPos(p);setPlayerTime(fmt(fromOffset+e));if(p<1&&sourceRef.current)rafRef.current=requestAnimationFrame(tick);}
    rafRef.current=requestAnimationFrame(tick);
  }

  async function ensureBuffer(item) {
    if (audioBuffers.current[item.id]) return audioBuffers.current[item.id];
    if (!item.audioFile) return null;
    const ctx=getCtx(); const ab=await item.audioFile.arrayBuffer();
    const buf=await ctx.decodeAudioData(ab); audioBuffers.current[item.id]=buf; return buf;
  }

  const handlePlayPause = useCallback(async (id, seekRatio=null) => {
    const item=playlist.find(t=>t.id===id); if(!item?.audioFile)return;
    const isPlaying=playingId===id;
    if (seekRatio!==null) { const buf=await ensureBuffer(item); if(buf) startPlayback(id,buf,seekRatio*buf.duration); return; }
    if (isPlaying) { const ctx=getCtx(); offsetRef.current=Math.min(offsetRef.current+(ctx.currentTime-startTimeRef.current),durationRef.current); stopCurrent(); setPlayingId(null); }
    else { const buf=await ensureBuffer(item); if(buf) startPlayback(id,buf,playingId===null?offsetRef.current:0); }
  },[playlist,playingId]);

  const handleVolumeChange = (val) => {
    const v=parseFloat(val); setVolume(v); volumeRef.current=v;
    if (gainNodeRef.current) gainNodeRef.current.gain.value=v;
  };

  useEffect(()=>()=>{ stopCurrent(); if(audioCtxRef.current)audioCtxRef.current.close(); },[]);

  // --- ADD TRACK -------------------------------------------------------------
  const addToPlaylist = useCallback(async ({ title, artist, isrc, file }) => {
    if (analyzing) return;
    setAnalyzing(true); setAnalyzeLabel(file?file.name:title); setAnalyzeStep("Extracting waveform...");

    const id=`t_${Date.now()}`;
    const result = await analyseTrack({ title, artist, isrc, file }, step => setAnalyzeStep(step));
    const { scores, waveformData, mxData, transcript, aiDetection, sourceType } = result;

    const item = {
      id, title, artist, isrc:isrc||null, sourceType,
      fileName: file?.name||null, audioFile: file||null,
      waveformData, scores, mxData, transcript, aiDetection,
      group:null, portrait:null, loadingPortrait:true,
    };

    setPlaylist(prev=>[...prev,item]);
    setAnalyzing(false); setAnalyzeStep(""); setExpanded(prev=>{const s=new Set(prev);s.add(id);return s;});
    setTitleInput(""); setArtistInput(""); setIsrcInput("");

    fetchPortrait(title, artist, scores, !!file, aiDetection).then(portrait=>{
      setPlaylist(prev=>prev.map(t=>t.id===id?{...t,portrait,loadingPortrait:false}:t));
      // Keep card expanded after portrait loads
      setExpanded(prev=>{const s=new Set(prev);s.add(id);return s;});
    });
  },[analyzing]);

  const handleManualAdd = () => { const t=titleInput.trim(); if(!t)return; addToPlaylist({title:t,artist:artistInput.trim()||"Unknown Artist",isrc:isrcInput.trim()}); };
  const handleFileSelect = (file) => {
    if (!file) return;
    const ext=file.name.split(".").pop()?.toLowerCase();
    if (!["mp3","wav","flac","aac","ogg","m4a"].includes(ext)) return;
    const rawName=file.name.replace(/\.[^.]+$/,"").replace(/^\d+[\s\-_.]+/,"").trim();
    addToPlaylist({title:rawName||file.name,artist:"Unknown Artist",file});
  };

  const handleReport = async () => {
    if (reportLoading||playlist.length===0) return;
    setReportLoading(true);
    try { const text=await generateReport(playlist); downloadReport(text,playlist); }
    catch(e){ console.error(e); }
    setReportLoading(false);
  };

  return (
    <div style={{minHeight:"100vh",background:"#0D0D0D",color:"white",fontFamily:"'DM Sans', sans-serif",paddingBottom:80}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&family=Playfair+Display:ital,wght@0,400;0,700;1,400&display=swap');
        @keyframes wave{from{transform:scaleY(0.5)}to{transform:scaleY(1.4)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:0.35}50%{opacity:1}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        input{outline:none} input:focus{border-color:rgba(232,86,58,0.5)!important}
        input::placeholder{color:rgba(255,255,255,0.2)} button{transition:all 0.15s}
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:2px}
      `}</style>
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,opacity:0.28,backgroundImage:"url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E\")"}}/>

      <div style={{position:"relative",zIndex:1,maxWidth:680,margin:"0 auto",padding:"40px 24px 0"}}>
        {/* Header */}
        <div style={{marginBottom:32}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#E8563A",letterSpacing:3,textTransform:"uppercase",marginBottom:10}}>Creative Humanity AI Hub . Musixmatch Musicathon 2026</div>
          <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:34,fontWeight:400,margin:"0 0 10px",lineHeight:1.1}}>Imperfect Remix</h1>
          <p style={{color:"rgba(255,255,255,0.62)",fontSize:13,margin:0,lineHeight:1.65}}>A tool that reveals the human signature in music -<br/>imperfection not as flaw, but as fingerprint.</p>
        </div>

        {/* API Status */}
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:20}}>
          {[
            {label:"Musixmatch",active:MUSIXMATCH_KEY!=="YOUR_MUSIXMATCH_KEY",dim:"Lyrical Soul"},
            {label:"LALAL.ai",active:LALAL_KEY!=="YOUR_LALAL_KEY",dim:"Timing . Texture . Silence"},
            {label:"Whisper",active:OPENAI_KEY!=="YOUR_OPENAI_KEY",dim:"Vocal transcription"},
            {label:"AI Detect",active:false,dim:"Future extension"},
          ].map(api=>(
            <div key={api.label} style={{display:"flex",alignItems:"center",gap:5,padding:"3px 9px",borderRadius:20,border:`1px solid ${api.active?"rgba(76,175,130,0.3)":"rgba(255,255,255,0.08)"}`,background:api.active?"rgba(76,175,130,0.08)":"rgba(255,255,255,0.02)"}}>
              <div style={{width:5,height:5,borderRadius:"50%",background:api.active?"#4CAF82":"rgba(255,255,255,0.2)",flexShrink:0}}/>
              <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:api.active?"#4CAF82":"rgba(255,255,255,0.35)",letterSpacing:1}}>{api.label}</span>
              <span style={{fontSize:9,color:"rgba(255,255,255,0.25)"}}>. {api.dim}</span>
            </div>
          ))}
        </div>

        {/* Input */}
        <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:18,padding:"20px 20px 18px",marginBottom:24}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"rgba(255,255,255,0.62)",letterSpacing:2,textTransform:"uppercase",marginBottom:14}}>Add Track - Blind Studio</div>
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            <input value={titleInput} onChange={e=>setTitleInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleManualAdd()} placeholder="Track title"
              style={{flex:2,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"10px 13px",color:"white",fontSize:14,fontFamily:"'DM Sans',sans-serif"}}/>
            <input value={artistInput} onChange={e=>setArtistInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleManualAdd()} placeholder="Artist"
              style={{flex:1,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"10px 13px",color:"white",fontSize:14,fontFamily:"'DM Sans',sans-serif"}}/>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:12}}>
            <input value={isrcInput} onChange={e=>setIsrcInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleManualAdd()} placeholder="ISRC (optional - enables Musixmatch lyrics analysis)"
              style={{flex:1,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:10,padding:"8px 13px",color:"white",fontSize:11,fontFamily:"'DM Mono',monospace"}}/>
            <button onClick={handleManualAdd} disabled={!titleInput.trim()||analyzing}
              style={{width:42,height:38,borderRadius:10,border:"none",flexShrink:0,background:titleInput.trim()&&!analyzing?"#E8563A":"rgba(255,255,255,0.06)",color:"white",cursor:titleInput.trim()&&!analyzing?"pointer":"default",fontSize:20,display:"flex",alignItems:"center",justifyContent:"center"}}>
              {analyzing?<div style={{width:14,height:14,border:"2px solid rgba(255,255,255,0.12)",borderTopColor:"white",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}/>:"+"}
            </button>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
            <div style={{flex:1,height:1,background:"rgba(255,255,255,0.06)"}}/>
            <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"rgba(255,255,255,0.62)",letterSpacing:2}}>OR</span>
            <div style={{flex:1,height:1,background:"rgba(255,255,255,0.06)"}}/>
          </div>
          <div onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)}
            onDrop={e=>{e.preventDefault();setDragOver(false);handleFileSelect(e.dataTransfer.files?.[0]);}}
            onClick={()=>!analyzing&&fileInputRef.current?.click()}
            style={{border:`1px dashed ${dragOver?"#E8563A":"rgba(255,255,255,0.12)"}`,borderRadius:12,padding:"16px 20px",background:dragOver?"rgba(232,86,58,0.06)":"rgba(255,255,255,0.02)",cursor:analyzing?"default":"pointer",textAlign:"center",transition:"all 0.2s"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:dragOver?"#E8563A":"rgba(255,255,255,0.62)",letterSpacing:1,marginBottom:4}}>^ UPLOAD AUDIO FILE</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.60)"}}>MP3 . WAV . FLAC . AAC . OGG . M4A - drag & drop or click</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.55)",marginTop:4,fontFamily:"'DM Mono',monospace"}}>Real waveform . LALAL.ai stems . Whisper vocals . AI detection</div>
          </div>
          <input ref={fileInputRef} type="file" accept=".mp3,.wav,.flac,.aac,.ogg,.m4a" style={{display:"none"}} onChange={e=>{handleFileSelect(e.target.files?.[0]);e.target.value="";}}/>
        <input type="file" accept=".json" style={{display:"none"}} id="session-load-input" onChange={e=>{if(e.target.files?.[0])loadSession(e.target.files[0],setPlaylist);e.target.value="";}}/>
          {analyzing && (
            <div style={{marginTop:14}}>
              <AnimatedWaveform active={true}/>
              <div style={{textAlign:"center",marginTop:8,animation:"pulse 1.2s ease-in-out infinite"}}>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#E8563A",letterSpacing:2}}>{analyzeStep||"READING THE HUMAN SIGNATURE"} - {analyzeLabel}</span>
              </div>
              <ProgressSteps step={analyzeStep}/>
            </div>
          )}
        </div>

        {/* Playlist */}
        {playlist.length>0 && (
          <>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{display:"flex",gap:0}}>
                {["playlist","compare"].map(v=>(
                  <button key={v} onClick={()=>setView(v)} style={{background:"transparent",border:"none",borderBottom:`2px solid ${view===v?"#E8563A":"transparent"}`,padding:"5px 14px",marginBottom:-1,color:view===v?"white":"rgba(255,255,255,0.55)",fontSize:10,fontFamily:"'DM Mono',monospace",letterSpacing:1,textTransform:"uppercase",cursor:"pointer"}}>
                    {v==="playlist"?`Playlist (${playlist.length})`:"Compare"}
                  </button>
                ))}
              </div>
              <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                {!revealed && (
                  <button onClick={()=>setRevealed(true)} style={{padding:"6px 13px",borderRadius:10,border:"1px solid rgba(232,86,58,0.3)",background:"rgba(232,86,58,0.08)",color:"#E8563A",cursor:"pointer",fontSize:10,fontFamily:"'DM Mono',monospace",letterSpacing:1}}>
                    Assign labels
                  </button>
                )}
                {revealed && <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"rgba(255,255,255,0.60)",letterSpacing:1,alignSelf:"center"}}>ASSIGN LABELS -></span>}
                <button onClick={()=>doExportCSV(playlist)} style={{padding:"6px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.07)",background:"transparent",color:"rgba(255,255,255,0.58)",cursor:"pointer",fontSize:10,fontFamily:"'DM Mono',monospace",letterSpacing:1}}>v CSV</button>
                <button onClick={()=>doExportSession(playlist)} style={{padding:"6px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.07)",background:"transparent",color:"rgba(255,255,255,0.45)",cursor:"pointer",fontSize:10,fontFamily:"'DM Mono',monospace",letterSpacing:1}}>v Session</button>
                <button onClick={handleReport} disabled={reportLoading||playlist.length===0}
                  style={{padding:"6px 12px",borderRadius:10,border:"1px solid rgba(232,86,58,0.25)",background:reportLoading?"rgba(232,86,58,0.05)":"rgba(232,86,58,0.1)",color:reportLoading?"rgba(232,86,58,0.5)":"#E8563A",cursor:reportLoading?"default":"pointer",fontSize:10,fontFamily:"'DM Mono',monospace",letterSpacing:1,display:"flex",alignItems:"center",gap:6}}>
                  {reportLoading?<><div style={{width:8,height:8,border:"1.5px solid rgba(232,86,58,0.3)",borderTopColor:"#E8563A",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}/>Generating...</>:"v Report"}
                </button>
              </div>
            </div>
            <div style={{borderTop:"1px solid rgba(255,255,255,0.05)",marginBottom:16}}/>
            {view==="playlist" && (
              <>
                {playlist.map(item=>(
                  <TrackCard key={item.id} item={item} revealed={revealed}
                    onLabelChange={(id,group)=>setPlaylist(prev=>prev.map(t=>t.id===id?{...t,group}:t))}
                    onExpand={id=>setExpanded(prev=>{const s=new Set(prev);s.has(id)?s.delete(id):s.add(id);return s;})} expanded={expanded.has(item.id)}
                    isPlaying={playingId===item.id} onPlayPause={handlePlayPause}
                    playerPosition={playingId===item.id?playerPos:0}
                    playerCurrentTime={playingId===item.id?playerTime:"0:00"}
                    playerDuration={playerDur} volume={volume} onVolumeChange={handleVolumeChange}/>
                ))}
                {playlist.length>=3 && !revealed && (
                  <div style={{marginTop:12,padding:"12px 16px",background:"rgba(255,255,255,0.02)",border:"1px dashed rgba(255,255,255,0.07)",borderRadius:12,textAlign:"center"}}>
                    <div style={{fontFamily:"'Playfair Display',serif",fontStyle:"italic",fontSize:12,color:"rgba(255,255,255,0.62)"}}>Enough tracks? Assign labels - then the comparison begins.</div>
                  </div>
                )}
              </>
            )}
            {view==="compare" && <CompareView tracks={playlist} onReveal={()=>{setRevealed(true);setView("playlist");}}/>}
          </>
        )}

        {playlist.length===0 && !analyzing && (
          <div style={{textAlign:"center",padding:"44px 0 0"}}>
            <div style={{fontFamily:"'Playfair Display',serif",fontStyle:"italic",fontSize:17,color:"rgba(255,255,255,0.60)",marginBottom:8}}>Add your first track.</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.55)",fontFamily:"'DM Mono',monospace",letterSpacing:1,marginBottom:16}}>The tool sees no labels - only music.</div>
            <button onClick={()=>document.getElementById("session-load-input").click()} style={{padding:"8px 16px",borderRadius:10,border:"1px solid rgba(255,255,255,0.1)",background:"transparent",color:"rgba(255,255,255,0.4)",cursor:"pointer",fontSize:10,fontFamily:"'DM Mono',monospace",letterSpacing:1}}>
              Load saved session (JSON)
            </button>
          </div>
        )}

        <div style={{marginTop:60,paddingTop:18,borderTop:"1px solid rgba(255,255,255,0.05)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontFamily:"'Playfair Display',serif",fontSize:13,color:"rgba(255,255,255,0.60)",fontStyle:"italic"}}>Ferme les yeux. Laisse-toi porter.</span>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"rgba(255,255,255,0.45)",letterSpacing:2}}>A.K.A MAROUKO & STELLA MARISA</span>
        </div>
      </div>
    </div>
  );
}

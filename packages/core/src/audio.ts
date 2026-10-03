/**
 * Music analysis for beat-driven animation: onsets, tempo (BPM), beats and downbeats.
 *
 *   onset envelope   band-weighted spectral flux of log-magnitude spectra (FFT 1024, hop 512);
 *                    low frequencies (kick, bass) weigh most, so beats land on the pulse people feel
 *   tempo            autocorrelation of the envelope in 60–200 BPM, with a gentle preference for ~120
 *   beats            dynamic-programming beat tracking (Ellis 2007), consistent tempo with onset alignment
 *   downbeats        the bar phase (assumed 4/4) where beats carry the most energy
 *   hits             sudden loud moments (a thunder clap, a crash): 50 ms loudness rising 8 dB over
 *                    the half second before, so effects can line up with the big moment of a sound
 *
 * Pure and deterministic. The result is saved with the project (Asset.analysis), so preview and
 * export always use the same beats, and the person can correct them.
 */
import type { AudioAnalysis, SoundHit } from "./model.ts";
import { FLICKS_PER_SECOND } from "./time.ts";

export const ANALYSIS_VERSION = 2;
const N = 1024;
const HOP = 512;

/** In-place radix-2 FFT on (re, im) arrays of length N. */
const fft = (re: Float64Array, im: Float64Array): void => {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const ai = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k + len / 2] = re[i + k]! - ar;
        im[i + k + len / 2] = im[i + k]! - ai;
        re[i + k]! += ar;
        im[i + k]! += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
};

/** Onset strength envelope (one value per hop), normalised to 0..1. */
export const onsetEnvelope = (mono: Float32Array, sampleRate: number): { env: Float64Array; rate: number } => {
  const frames = Math.max(0, Math.floor((mono.length - N) / HOP) + 1);
  const env = new Float64Array(frames);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  let prev = new Float64Array(N / 2);
  const hz = sampleRate / N;
  const lowBin = Math.max(2, Math.round(200 / hz));
  const midBin = Math.max(lowBin + 1, Math.round(2000 / hz));
  const lowBins = lowBin - 1;
  const midBins = midBin - lowBin;
  const highBins = N / 2 - midBin;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = (mono[o + i] ?? 0) * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(N / 2);
    // Mean positive flux per band (so wide noisy bands don't swamp the low end), then weighted.
    const sums = [0, 0, 0];
    for (let k = 1; k < N / 2; k++) {
      mag[k] = Math.log1p(1000 * Math.hypot(re[k]!, im[k]!));
      const d = mag[k]! - prev[k]!;
      if (d > 0) sums[k < lowBin ? 0 : k < midBin ? 1 : 2]! += d;
    }
    env[f] = (sums[0]! / lowBins) * 1.0 + (sums[1]! / midBins) * 0.5 + (sums[2]! / highBins) * 0.2;
    prev = mag;
  }
  // Remove the slowly varying level and keep the peaks.
  const w = Math.max(1, Math.round((sampleRate / HOP) * 0.25));
  // Light smoothing tolerates onsets that fall between analysis frames.
  const smooth = new Float64Array(frames);
  for (let f = 0; f < frames; f++) smooth[f] = 0.25 * (env[f - 1] ?? env[f]!) + 0.5 * env[f]! + 0.25 * (env[f + 1] ?? env[f]!);
  env.set(smooth);
  const out = new Float64Array(frames);
  let max = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, f - w); k <= Math.min(frames - 1, f + w); k++) {
      s += env[k]!;
      c++;
    }
    out[f] = Math.max(0, env[f]! - s / c);
    max = Math.max(max, out[f]!);
  }
  if (max > 0) for (let f = 0; f < frames; f++) out[f]! /= max;
  return { env: out, rate: sampleRate / HOP };
};

/** Estimate tempo in BPM from the onset envelope. */
export const estimateTempo = (env: Float64Array, rate: number): number => {
  const minLag = Math.floor((rate * 60) / 200);
  const maxLag = Math.ceil((rate * 60) / 60);
  const ac = new Float64Array(2 * maxLag + 4);
  for (let lag = 1; lag < ac.length && lag < env.length; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i]! * env[i - lag]!;
    ac[lag] = s / (env.length - lag);
  }
  // Fractional lags: read the autocorrelation with linear interpolation.
  const acAt = (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    return (ac[i] ?? 0) * (1 - f) + (ac[i + 1] ?? 0) * f;
  };
  let best = minLag;
  let bestScore = -Infinity;
  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag && lag < env.length; lag++) {
    const bpm = (60 * rate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    // A real beat period also repeats at twice the lag; half-tempo candidates don't get that support.
    scores[lag] = (acAt(lag) + 0.5 * acAt(2 * lag)) * prior;
    if (scores[lag]! > bestScore) {
      bestScore = scores[lag]!;
      best = lag;
    }
  }
  // Parabolic interpolation around the peak for sub-frame precision.
  const a = scores[best - 1] ?? 0;
  const b = scores[best]!;
  const c = scores[best + 1] ?? 0;
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return (60 * rate) / (best + Math.max(-0.5, Math.min(0.5, shift)));
};

/** Dynamic-programming beat tracker; returns beat positions in envelope frames. */
export const trackBeats = (env: Float64Array, rate: number, bpm: number, tightness = 100): number[] => {
  const period = (60 * rate) / bpm;
  const n = env.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    const lo = Math.max(0, Math.round(t - 2 * period));
    const hi = Math.min(t - 1, Math.round(t - period / 2));
    for (let p = lo; p <= hi; p++) {
      const penalty = -tightness * Math.log((t - p) / period) ** 2;
      const v = score[p]! + penalty;
      if (v > best || arg < 0) {
        best = v;
        arg = p;
      }
    }
    score[t] = env[t]! + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // Start from the best-scoring frame in the last beat period and backtrack.
  let t = n - 1;
  let bestEnd = -Infinity;
  for (let k = Math.max(0, Math.round(n - period)); k < n; k++)
    if (score[k]! > bestEnd) {
      bestEnd = score[k]!;
      t = k;
    }
  const beats: number[] = [];
  while (t >= 0) {
    beats.push(t);
    t = back[t]!;
  }
  return beats.reverse();
};

/**
 * The loud moments of a sound, in time order (at most `max`, the loudest kept): each where a 50 ms
 * window is 8 dB louder than anything in the half second before it, and no more than 30 dB below
 * the loudest part of the file. Starts at least 0.6 s apart.
 */
export const soundHits = (mono: Float32Array, sampleRate: number, max = 24): SoundHit[] => {
  const win = Math.max(1, Math.round(sampleRate * 0.05));
  const db: number[] = [];
  for (let i = 0; i + win <= mono.length; i += win) {
    let e = 0;
    for (let j = 0; j < win; j++) e += mono[i + j]! ** 2;
    db.push(10 * Math.log10(e / win + 1e-12));
  }
  if (!db.length) return [];
  const loudest = Math.max(...db);
  const floor = Math.max(-45, loudest - 30);
  const back = 10, ahead = 30;
  const f = (w: number): number => Math.round(((w * win) / sampleRate) * FLICKS_PER_SECOND);
  const out: SoundHit[] = [];
  let last = -Infinity;
  // Before the file starts counts as silence, so a sound that opens on its hit has that hit.
  for (let i = 0; i < db.length; i++) {
    let before = -120;
    for (let j = Math.max(0, i - back); j < i; j++) before = Math.max(before, db[j]!);
    if (db[i]! < floor || db[i]! - before < 8 || i - last < 12) continue;
    let p = i;
    for (let j = i; j < Math.min(db.length, i + ahead); j++) if (db[j]! > db[p]!) p = j;
    let k = p;
    while (k < db.length && db[k]! > db[p]! - 20) k++;
    out.push({ at: f(Math.max(0, i - 1)), peak: f(p), level: Math.round(db[p]! * 10) / 10, length: f(k - p) });
    last = i;
  }
  return out.sort((a, b) => b.level - a.level).slice(0, max).sort((a, b) => a.at - b.at);
};

/** Full analysis of a mono signal. */
export const analyzeMusic = (mono: Float32Array, sampleRate: number): AudioAnalysis => {
  const { env, rate } = onsetEnvelope(mono, sampleRate);
  const hits = soundHits(mono, sampleRate);
  if (env.length < 16) return { version: ANALYSIS_VERSION, bpm: 0, beats: [], downbeatOffset: 0, strengths: [], hits };
  const bpm = estimateTempo(env, rate);
  const frames = trackBeats(env, rate, bpm);
  const strengths = frames.map((f) => Math.max(env[f] ?? 0, env[f - 1] ?? 0, env[f + 1] ?? 0));
  // Downbeat: the bar phase (4/4) whose beats are strongest on average.
  let bestPhase = 0;
  let bestSum = -1;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    let c = 0;
    for (let i = ph; i < strengths.length; i += 4) {
      s += strengths[i]!;
      c++;
    }
    if (c && s / c > bestSum) {
      bestSum = s / c;
      bestPhase = ph;
    }
  }
  // Frame centre → seconds → flicks (the analysis window is centred on the frame).
  const beats = frames.map((f) => Math.round(((f * HOP + N / 2) / sampleRate) * FLICKS_PER_SECOND));
  return { version: ANALYSIS_VERSION, bpm: Math.round(bpm * 10) / 10, beats, downbeatOffset: bestPhase, strengths: strengths.map((s) => Math.round(s * 1000) / 1000), hits };
};

/** Mix interleaved/planar channels down to mono. */
export const toMono = (channels: readonly Float32Array[]): Float32Array => {
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i]! += ch[i]! / channels.length;
  return out;
};

/** Peaks for waveform drawing: [min, max] per bucket. */
export const waveformPeaks = (mono: Float32Array, buckets: number): Float32Array => {
  const out = new Float32Array(buckets * 2);
  const per = mono.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let lo = 0;
    let hi = 0;
    const s = Math.floor(b * per);
    const e = Math.min(mono.length, Math.floor((b + 1) * per));
    for (let i = s; i < e; i++) {
      const v = mono[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
};

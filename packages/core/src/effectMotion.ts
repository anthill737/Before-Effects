/**
 * Timing for the layer effects that move by themselves (Ripple, Glitch): where and when drops land,
 * when glitch bursts hit and what each moment looks like. Everything is a pure function of (time,
 * settings, seed) through the stateless hashes in rng.ts — nothing is carried from frame to frame —
 * so preview, export and seeking always see the same picture for the same frame.
 */
import { hashKeys, rand01 } from "./rng.ts";

const clamp01 = (v: number): number => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));
/** A setting used as a seed: whole numbers, so an animated "Variation" doesn't shimmer between keys. */
const seedOf = (v: number): number => (Number.isFinite(v) ? Math.round(v) >>> 0 : 1);

// ---- Ripple ---------------------------------------------------------------------------------------

/** One drop of a Ripple: where it landed (0..1 across and down the picture), how long ago (s), how strong (0..1). */
export interface RippleDrop {
  readonly x: number;
  readonly y: number;
  readonly age: number;
  readonly strength: number;
}

export interface RippleTiming {
  /** Raindrops per second; 0 = a single drop at the centre. */
  readonly rain: number;
  /** The single drop's landing point, % of the picture. */
  readonly centerX: number;
  readonly centerY: number;
  readonly seed: number;
}

/** Most drops drawn at once (the size of the shader's drop list). */
export const RIPPLE_MAX_DROPS = 16;
/** Longest a raindrop's rings last (seconds). */
export const RAIN_DROP_LIFE = 3;

/** How long each raindrop's rings last: heavy rain shortens it, so no more than RIPPLE_MAX_DROPS are ever alive. */
export const rainDropLife = (rate: number): number => Math.min(RAIN_DROP_LIFE, RIPPLE_MAX_DROPS / Math.max(1e-6, rate));

/**
 * The drops rippling at `seconds` (the layer's own time), newest first. Without rain: one drop at the
 * centre that lands at 0 s and keeps spreading. With rain: drop k lands at a seeded moment within
 * [k, k + 0.9) / rain seconds, at a seeded place away from the very edge, and fades out over its life.
 */
export const rippleDrops = (seconds: number, o: RippleTiming): RippleDrop[] => {
  if (!Number.isFinite(seconds) || seconds < 0) return [];
  const rate = Number.isFinite(o.rain) ? Math.max(0, o.rain) : 0;
  if (rate <= 0) return [{ x: clamp01(o.centerX / 100), y: clamp01(o.centerY / 100), age: seconds, strength: 1 }];
  const seed = seedOf(o.seed);
  const life = rainDropLife(rate);
  const drops: RippleDrop[] = [];
  const newest = Math.floor(seconds * rate);
  // Drops older than this have certainly faded out.
  const oldest = Math.max(0, Math.floor((seconds - life) * rate) - 1);
  for (let k = newest; k >= oldest && drops.length < RIPPLE_MAX_DROPS; k--) {
    const age = seconds - (k + 0.9 * rand01(seed, k, 0)) / rate;
    if (age < 0 || age >= life) continue;
    const fade = 1 - age / life;
    drops.push({ x: 0.08 + 0.84 * rand01(seed, k, 1), y: 0.08 + 0.84 * rand01(seed, k, 2), age, strength: (0.55 + 0.45 * rand01(seed, k, 3)) * fade * fade });
  }
  return drops;
};

// ---- Glitch ---------------------------------------------------------------------------------------

/** One moment of a Glitch. */
export interface GlitchMoment {
  /** How hard it glitches now, 0..1: 0 between bursts. The effect multiplies it by its Amount. */
  readonly strength: number;
  /** This moment's random pattern (a 32-bit key): which strips jump, which blocks break. */
  readonly key: number;
  /** Brightness now: 1, or a flash or dip at some moments of a burst. */
  readonly flicker: number;
}

/** How many times a second a burst's pattern changes. */
export const GLITCH_STEPS_PER_SECOND = 15;
/** The shortest burst (seconds), so even rare bursts are seen. */
export const GLITCH_MIN_BURST = 1 / 12;

/**
 * The glitch at `seconds` (the layer's own time). Time is cut into slots of 1 / frequency seconds;
 * each slot holds one burst at a seeded moment with a seeded length (a quarter to most of the slot),
 * and outside the bursts the picture is clean. Within a burst the pattern changes
 * GLITCH_STEPS_PER_SECOND times a second.
 */
export const glitchAt = (seconds: number, frequency: number, seed: number): GlitchMoment => {
  const s = seedOf(seed);
  const t = Number.isFinite(seconds) ? seconds : 0;
  const period = 1 / Math.max(0.01, Number.isFinite(frequency) ? frequency : 1);
  // Work in fractions of the slot (exact, so a burst that fills its slot never drops a frame).
  const x = t / period;
  const slot = Math.floor(x);
  const phase = x - slot;
  const length = Math.min(1, Math.max(GLITCH_MIN_BURST / period, 0.25 + 0.35 * rand01(s, slot, 1)));
  const start = rand01(s, slot, 0) * (1 - length);
  if (phase < start || phase >= start + length) return { strength: 0, key: hashKeys(s, slot, 0x5eed), flicker: 1 };
  const step = Math.floor((phase - start) * period * GLITCH_STEPS_PER_SECOND);
  const key = hashKeys(s, slot, step, 1);
  const strength = (0.5 + 0.5 * rand01(s, slot, 2)) * (0.55 + 0.45 * rand01(key, 3));
  const flicker = rand01(key, 4) < 0.35 ? 0.55 + 0.9 * rand01(key, 5) : 1;
  return { strength, key, flicker };
};

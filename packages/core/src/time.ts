/**
 * Deterministic time.
 *
 * All project time is an integer number of *flicks* (1/705,600,000 s). A flick divides evenly into
 * every common video frame rate (23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 120) and
 * every common audio sample rate (44.1k, 48k, 88.2k, 96k). So frame boundaries are exact integers
 * and preview and export land on bit-identical times. JS numbers stay exact up to about 147 days of
 * flicks, far beyond any show.
 */

export type Flicks = number;

export const FLICKS_PER_SECOND = 705_600_000;

/** A frame rate as a rational number, e.g. 30000/1001 for 29.97. */
export interface Rational {
  readonly num: number;
  readonly den: number;
}

export const rate = (num: number, den = 1): Rational => {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
    throw new RangeError(`Invalid frame rate ${num}/${den}`);
  }
  return { num, den };
};

export const RATES = {
  fps23_976: rate(24000, 1001),
  fps24: rate(24),
  fps25: rate(25),
  fps29_97: rate(30000, 1001),
  fps30: rate(30),
  fps50: rate(50),
  fps59_94: rate(60000, 1001),
  fps60: rate(60),
} as const;

export const rateToFps = (r: Rational): number => r.num / r.den;

/** Flicks per frame, or null when the rate does not divide a second of flicks exactly. */
export const flicksPerFrame = (r: Rational): number | null => {
  const n = FLICKS_PER_SECOND * r.den;
  return n % r.num === 0 ? n / r.num : null;
};

/** Start time of a frame. Exact for every rate where flicksPerFrame() is an integer. */
export const frameToTime = (frame: number, r: Rational): Flicks => {
  const fpf = flicksPerFrame(r);
  if (fpf !== null) return frame * fpf;
  // Uncommon rate: compute in BigInt to avoid overflow, round to nearest flick.
  const n = BigInt(frame) * BigInt(FLICKS_PER_SECOND) * BigInt(r.den);
  const d = BigInt(r.num);
  return Number((n * 2n + d) / (2n * d));
};

/** The frame that contains time t (floor). */
export const timeToFrame = (t: Flicks, r: Rational): number => {
  const fpf = flicksPerFrame(r);
  if (fpf !== null) return Math.floor(t / fpf);
  const n = BigInt(Math.round(t)) * BigInt(r.num);
  const d = BigInt(FLICKS_PER_SECOND) * BigInt(r.den);
  const q = n / d;
  return Number(n < 0n && q * d !== n ? q - 1n : q);
};

export const secondsToTime = (s: number): Flicks => Math.round(s * FLICKS_PER_SECOND);
export const timeToSeconds = (t: Flicks): number => t / FLICKS_PER_SECOND;

/** Number of whole frames in a duration (rounded down). */
export const framesIn = (duration: Flicks, r: Rational): number => timeToFrame(duration, r);

/** Snap an arbitrary time to the start of the frame that contains it. */
export const snapToFrame = (t: Flicks, r: Rational): Flicks => frameToTime(timeToFrame(t, r), r);

/** SMPTE-style display timecode (non-drop-frame), e.g. 00:00:12:07. */
export const formatTimecode = (t: Flicks, r: Rational): string => {
  const fpsInt = Math.round(rateToFps(r));
  const frame = timeToFrame(t, r);
  const ff = ((frame % fpsInt) + fpsInt) % fpsInt;
  const totalSeconds = Math.floor(frame / fpsInt);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
};

/** Friendly display like "12.3 s" or "1 min 04 s" for plain-language UI. */
export const formatSecondsFriendly = (t: Flicks): string => {
  const s = timeToSeconds(t);
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s - m * 60)).padStart(2, "0")} s`;
};

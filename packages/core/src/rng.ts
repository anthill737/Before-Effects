/**
 * Stateless, seeded randomness.
 *
 * Every random value comes from hashing (seed, keys...). Nothing depends on how many values were
 * drawn earlier, so preview, export, seeking and parallel render workers all see the same numbers.
 * The hash is PCG-RXS-M-XS ("pcg_hash", Jarzynski & Olano 2020), which uses only 32-bit integer ops.
 * The WGSL twin lives in packages/engine/src/shaders/common.wgsl (`pcg_hash`, `rand01`) and must
 * stay bit-identical. Change both or neither.
 */

export const pcgHash = (input: number): number => {
  const state = (Math.imul(input >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> (((state >>> 28) + 4) >>> 0)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
};

/** Hash any number of 32-bit keys into one 32-bit value. */
export const hashKeys = (seed: number, ...keys: number[]): number => {
  let h = pcgHash(seed >>> 0);
  for (const k of keys) h = pcgHash((h ^ (k >>> 0)) >>> 0);
  return h;
};

/** Uniform float in [0, 1) with 24 bits of precision, exactly reproducible in WGSL as f32. */
export const rand01 = (seed: number, ...keys: number[]): number => (hashKeys(seed, ...keys) >>> 8) / 16777216;

/** Uniform float in [min, max). */
export const randRange = (min: number, max: number, seed: number, ...keys: number[]): number =>
  min + (max - min) * rand01(seed, ...keys);

/** Hash a string (ids, names) to a 32-bit key with FNV-1a, so string identities can seed randomness. */
export const hashString = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/**
 * Counter-based generator for code that wants a stream (expressions' random(), recipe generators).
 * The n-th draw is always rand01(seed, stream, n), so a stream is reproducible from any point.
 */
export class SeededStream {
  private counter = 0;
  constructor(
    readonly seed: number,
    readonly stream = 0,
  ) {}
  next(): number {
    return rand01(this.seed, this.stream, this.counter++);
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  /** Gaussian-distributed value (Box–Muller), mean 0, sd 1. */
  gaussian(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/**
 * Smooth 1D gradient noise in [-1, 1], continuous in t. Used by wiggle and organic motion.
 * Deterministic for (seed, channel, t).
 */
export const noise1 = (t: number, seed: number, channel = 0): number => {
  const i0 = Math.floor(t);
  const f = t - i0;
  const g0 = rand01(seed, channel, i0 | 0) * 2 - 1;
  const g1 = rand01(seed, channel, (i0 + 1) | 0) * 2 - 1;
  const v0 = g0 * f;
  const v1 = g1 * (f - 1);
  const u = f * f * f * (f * (f * 6 - 15) + 10); // quintic fade
  // Peak of a 1D gradient noise sits near ±0.5; scale to roughly fill [-1, 1].
  return (v0 + (v1 - v0) * u) * 2;
};

/**
 * After Effects–style wiggle: fractal sum of gradient noise.
 * freq is wiggles per second, amp is the amplitude in property units.
 */
export const wiggle1 = (
  seconds: number,
  freq: number,
  amp: number,
  seed: number,
  channel = 0,
  octaves = 1,
  ampMult = 0.5,
): number => {
  let sum = 0;
  let a = 1;
  let f = freq;
  let norm = 0;
  for (let o = 0; o < Math.max(1, Math.floor(octaves)); o++) {
    sum += a * noise1(seconds * f, seed, channel * 16 + o);
    norm += a;
    a *= ampMult;
    f *= 2;
  }
  return (sum / norm) * amp;
};

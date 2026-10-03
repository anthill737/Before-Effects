/**
 * Effect registry. Every effect declares:
 *   - how far it can draw outside its input (bounds expansion, in layer pixels),
 *   - which frames it reads (temporal dependencies; none for these — Ripple and Glitch move with the
 *     layer's own time, but each frame is a pure function of that time),
 *   - the colour space it expects (scene-linear premultiplied for all current effects),
 * and renders as a small graph of GPU passes. Effects never touch projector mapping or output correction.
 */
import { glitchAt, type PropValue, RIPPLE_MAX_DROPS, rippleDrops } from "@be/core";
import type { Gpu } from "./gpu.ts";
import { BLUR, DOWNSAMPLE, GLITCH, GLOW_COMBINE, MELT, RIPPLE, THRESHOLD } from "./shaders.ts";

/** A rectangle in texture pixels. */
export interface TexRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface EffectContext {
  readonly gpu: Gpu;
  readonly encoder: GPUCommandEncoder;
  /** Pixels per layer unit of the texture being processed (preview may render at reduced scale). */
  readonly scale: number;
  /** "draft" trades a little smoothness for speed in preview; exports always use "full". */
  readonly quality?: "full" | "draft";
  /** The layer's own time in seconds (0 at its start), for effects that move by themselves. */
  readonly time?: number;
  /** Where the layer's own picture sits in the texture (the rest is padding for effects). Omitted: all of it. */
  readonly picture?: TexRect;
}

export interface EffectDef {
  readonly type: string;
  readonly title: string;
  /** Extra pixels (in layer units) the effect may draw beyond its input bounds. */
  readonly expand: (params: Readonly<Record<string, PropValue>>) => number;
  /** Returns the output texture (may be the input when the effect is a no-op). Caller releases the input. */
  readonly render: (input: GPUTexture, params: Readonly<Record<string, PropValue>>, ctx: EffectContext) => GPUTexture;
}

const n = (v: PropValue | undefined, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/**
 * Gaussian blur with radius in layer units. Large radii are computed on a downsampled copy and
 * upsampled with bilinear filtering, so cost stays bounded. Edges are transparent beyond the
 * input (the caller pads by `expand`, so nothing clips unexpectedly).
 */
export const gaussianBlur = (gpu: Gpu, encoder: GPUCommandEncoder, input: GPUTexture, radiusPx: number, maxTaps = 24): GPUTexture => {
  if (radiusPx <= 0.25) return input;
  let src = input;
  let level = 1;
  const owned: GPUTexture[] = [];
  // Keep the kernel at most ~maxTaps per side by halving resolution.
  while (radiusPx / level > maxTaps && src.width > 8 && src.height > 8) {
    const half = gpu.acquire(Math.ceil(src.width / 2), Math.ceil(src.height / 2), src.format, "blur-down");
    gpu.pass(encoder, DOWNSAMPLE, half, [src.createView(), gpu.samplerLinear]);
    owned.push(half);
    src = half;
    level *= 2;
  }
  const sigma = radiusPx / level / 2.5;
  const r = Math.ceil(sigma * 3);
  const tmp = gpu.acquire(src.width, src.height, src.format, "blur-h");
  const u1 = gpu.uniform(new Float32Array([1 / src.width, 0, sigma, r]));
  gpu.pass(encoder, BLUR, tmp, [src.createView(), gpu.samplerLinear, { buffer: u1 }]);
  const out = gpu.acquire(src.width, src.height, src.format, "blur-v");
  const u2 = gpu.uniform(new Float32Array([0, 1 / src.height, sigma, r]));
  gpu.pass(encoder, BLUR, out, [tmp.createView(), gpu.samplerLinear, { buffer: u2 }]);
  gpu.release(tmp);
  for (const t of owned) gpu.release(t);
  if (level === 1) return out;
  // Upsample back to the input size (bilinear) so callers always get input-sized output.
  const full = gpu.acquire(input.width, input.height, input.format, "blur-up");
  gpu.pass(encoder, DOWNSAMPLE, full, [out.createView(), gpu.samplerLinear]);
  gpu.release(out);
  return full;
};

export const GaussianBlurEffect: EffectDef = {
  type: "gaussian-blur",
  title: "Blur",
  expand: (p) => n(p.radius, 10) * 1.2,
  render: (input, p, ctx) => {
    return gaussianBlur(ctx.gpu, ctx.encoder, input, n(p.radius, 10) * ctx.scale, ctx.quality === "draft" ? 10 : 24);
  },
};

/**
 * Glow: threshold → wide blur → added back as light. Two blur scales give the soft halo plus a
 * tighter core people expect from neon. Values above 1.0 are preserved (16-bit float), so glows
 * stay smooth and don't band before the output transform.
 */
export const GlowEffect: EffectDef = {
  type: "glow",
  title: "Glow",
  expand: (p) => n(p.radius, 20) * 1.5,
  render: (input, p, ctx) => {
    const { gpu, encoder } = ctx;
    const radius = n(p.radius, 20) * ctx.scale;
    const intensity = n(p.intensity, 1);
    if (radius <= 0 || intensity <= 0) return input;
    const thr = gpu.acquire(input.width, input.height, input.format, "glow-thr");
    gpu.pass(encoder, THRESHOLD, thr, [input.createView(), gpu.samplerLinear, { buffer: gpu.uniform(new Float32Array([n(p.threshold, 0), 0, 0, 0])) }]);
    const taps = ctx.quality === "draft" ? 10 : 24;
    const wide = gaussianBlur(gpu, encoder, thr, radius, taps);
    const tight = gaussianBlur(gpu, encoder, thr, radius * 0.25, taps);
    // Combine: input + tight*0.6*intensity + wide*intensity.
    const mid = gpu.acquire(input.width, input.height, input.format, "glow-mid");
    gpu.pass(encoder, GLOW_COMBINE, mid, [input.createView(), tight.createView(), gpu.samplerLinear, { buffer: gpu.uniform(new Float32Array([0.6 * intensity, 0, 0, 0])) }]);
    const out = gpu.acquire(input.width, input.height, input.format, "glow-out");
    gpu.pass(encoder, GLOW_COMBINE, out, [mid.createView(), wide.createView(), gpu.samplerLinear, { buffer: gpu.uniform(new Float32Array([intensity, 0, 0, 0])) }]);
    for (const t of [thr, wide, tight, mid]) if (t !== input) gpu.release(t);
    return out;
  },
};

/**
 * Melt: the layer sags and drips downward by up to `distance` layer pixels as `amount` goes 0 → 1
 * (animate it). `drip` is how much thin drips run ahead of the slump.
 */
export const MeltEffect: EffectDef = {
  type: "melt",
  title: "Melt",
  expand: (p) => n(p.distance, 300),
  render: (input, p, ctx) => {
    const amount = Math.min(1, Math.max(0, n(p.amount, 0)));
    if (amount <= 0) return input;
    const { gpu, encoder } = ctx;
    // The distance as a fraction of the (padded) texture's height.
    const reach = (n(p.distance, 300) * ctx.scale) / Math.max(1, input.height);
    const out = gpu.acquire(input.width, input.height, input.format, "melt");
    gpu.pass(encoder, MELT, out, [input.createView(), gpu.samplerLinear, { buffer: gpu.uniform(new Float32Array([amount, Math.min(1, Math.max(0, n(p.drip, 0.6))), n(p.seed, 1), reach])) }]);
    return out;
  },
};

const col = (v: PropValue | undefined, d: readonly number[]): readonly number[] => (Array.isArray(v) && v.length >= 3 && v.every((x) => Number.isFinite(x)) ? v : d);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Bytes in the RIPPLE shader's uniform block (must match `struct U` in shaders.ts). */
export const RIPPLE_UNIFORM_BYTES = 48 + 16 * RIPPLE_MAX_DROPS;

/**
 * The RIPPLE shader's uniforms, in texture pixels (`struct U` in shaders.ts):
 *   [0..1] texture size, [2] strength, [3] ring spacing, [4] speed per second, [5] fade per pixel,
 *   [6] rings per drop (0 = keeps rippling), [7] number of drops, [8..11] crest light (sRGB colour,
 *   amount), then one vec4 per drop: x, y, seconds since it landed, strength.
 * Null when there's nothing to draw (calm water and no light, or no drop has landed yet).
 */
export const rippleUniforms = (p: Readonly<Record<string, PropValue>>, time: number, size: { readonly w: number; readonly h: number }, picture: TexRect, scale: number): Float32Array | null => {
  const strength = Math.max(0, n(p.strength, 12)) * scale;
  const light = Math.max(0, n(p.highlight, 0.3));
  if (strength <= 0 && light <= 0) return null;
  const drops = rippleDrops(time, { rain: n(p.rain, 0), centerX: n(p.centerX, 50), centerY: n(p.centerY, 50), seed: n(p.seed, 1) });
  if (!drops.length) return null;
  // "Fades with distance" at 1 leaves e^-4 (2%) of a wave by the time it reaches the picture's corners from its middle.
  const reach = Math.max(1, Math.hypot(picture.w, picture.h) / 2);
  const c = col(p.highlightColor, [1, 1, 1, 1]);
  const u = new Float32Array(RIPPLE_UNIFORM_BYTES / 4);
  u.set([size.w, size.h, strength, Math.max(1, n(p.wavelength, 80) * scale), Math.max(0.01, n(p.speed, 200) * scale), (clamp(n(p.decay, 0.3), 0, 1) * 4) / reach, Math.max(0, Math.round(n(p.rings, 0))), drops.length]);
  u.set([clamp(c[0]!, 0, 1), clamp(c[1]!, 0, 1), clamp(c[2]!, 0, 1), light * clamp(c[3] ?? 1, 0, 1)], 8);
  drops.forEach((d, i) => u.set([picture.x + d.x * picture.w, picture.y + d.y * picture.h, d.age, d.strength], 12 + i * 4));
  return u;
};

/**
 * Ripple: rings of water spread from a point (or from raindrops) and bend the picture under them,
 * with optional light on the crests. Moves with the layer's own time; the drops come from core's
 * rippleDrops, so a frame always looks the same.
 */
export const RippleEffect: EffectDef = {
  type: "ripple",
  title: "Ripple",
  expand: (p) => Math.max(0, n(p.strength, 12)),
  render: (input, p, ctx) => {
    const { gpu, encoder } = ctx;
    const u = rippleUniforms(p, ctx.time ?? 0, { w: input.width, h: input.height }, ctx.picture ?? { x: 0, y: 0, w: input.width, h: input.height }, ctx.scale);
    if (!u) return input;
    const out = gpu.acquire(input.width, input.height, input.format, "ripple");
    gpu.pass(encoder, RIPPLE, out, [input.createView(), gpu.samplerLinear, { buffer: gpu.uniform(u) }]);
    return out;
  },
};

/** Bytes in the GLITCH shader's uniform block (must match `struct U` in shaders.ts). */
export const GLITCH_UNIFORM_BYTES = 48;

/**
 * The GLITCH shader's uniforms, in texture pixels (`struct U` in shaders.ts): f32 [0..1] texture size,
 * [2] strength now, [3] strip height, [4] jump, [5] colour split, [6] blocks, [7] scanline darkness,
 * [8] scanline spacing, [9] scanline roll, [10] brightness; u32 [11] this moment's pattern key.
 * Null when the picture stays clean (Amount 0, or between bursts with no scanlines).
 */
export const glitchUniforms = (p: Readonly<Record<string, PropValue>>, time: number, size: { readonly w: number; readonly h: number }, scale: number): ArrayBuffer | null => {
  const amount = clamp(n(p.amount, 0.6), 0, 1);
  if (amount <= 0) return null;
  const m = glitchAt(time, n(p.frequency, 2), n(p.seed, 1));
  const strength = amount * m.strength;
  const scan = clamp(n(p.scanlines, 0.2), 0, 1) * amount;
  if (strength <= 0 && scan <= 0) return null;
  // Scanlines a few layer pixels apart (never finer than 2 texture pixels), rolling slowly downward.
  const period = Math.max(2, Math.max(3, n(p.slice, 24) / 6) * scale);
  const buf = new ArrayBuffer(GLITCH_UNIFORM_BYTES);
  new Float32Array(buf, 0, 11).set([
    size.w,
    size.h,
    strength,
    Math.max(1, n(p.slice, 24) * scale),
    Math.max(0, n(p.shift, 60)) * scale,
    Math.max(0, n(p.split, 8)) * scale,
    clamp(n(p.blocks, 0.3), 0, 1),
    scan,
    period,
    (((time * 12 * scale) % period) + period) % period,
    strength > 0 ? 1 + (m.flicker - 1) * amount : 1,
  ]);
  new Uint32Array(buf, 44, 1)[0] = m.key >>> 0;
  return buf;
};

/**
 * Glitch: in seeded bursts (core's glitchAt), strips of the picture jump sideways, red and blue split
 * apart, square blocks break up and the brightness flickers; scanlines roll across throughout.
 */
export const GlitchEffect: EffectDef = {
  type: "glitch",
  title: "Glitch",
  expand: (p) => Math.max(0, n(p.shift, 60)) + Math.max(0, n(p.split, 8)),
  render: (input, p, ctx) => {
    const { gpu, encoder } = ctx;
    const u = glitchUniforms(p, ctx.time ?? 0, { w: input.width, h: input.height }, ctx.scale);
    if (!u) return input;
    const out = gpu.acquire(input.width, input.height, input.format, "glitch");
    gpu.pass(encoder, GLITCH, out, [input.createView(), gpu.samplerLinear, { buffer: gpu.uniform(u) }]);
    return out;
  },
};

const registry = new Map<string, EffectDef>([GaussianBlurEffect, GlowEffect, MeltEffect, RippleEffect, GlitchEffect].map((e) => [e.type, e]));

export const getEffect = (type: string): EffectDef | undefined => registry.get(type);
export const registerEffect = (def: EffectDef): void => {
  registry.set(def.type, def);
};
export const listEffects = (): EffectDef[] => [...registry.values()];

/**
 * Effect registry. Every effect declares:
 *   - how far it can draw outside its input (bounds expansion, in layer pixels),
 *   - which frames it reads (temporal dependencies; none for these),
 *   - the colour space it expects (scene-linear premultiplied for all current effects),
 * and renders as a small graph of GPU passes. Effects never touch projector mapping or output correction.
 */
import type { PropValue } from "@be/core";
import type { Gpu } from "./gpu.ts";
import { BLUR, DOWNSAMPLE, GLOW_COMBINE, THRESHOLD } from "./shaders.ts";

export interface EffectContext {
  readonly gpu: Gpu;
  readonly encoder: GPUCommandEncoder;
  /** Pixels per layer unit of the texture being processed (preview may render at reduced scale). */
  readonly scale: number;
  /** "draft" trades a little smoothness for speed in preview; exports always use "full". */
  readonly quality?: "full" | "draft";
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

const registry = new Map<string, EffectDef>([GaussianBlurEffect, GlowEffect].map((e) => [e.type, e]));

export const getEffect = (type: string): EffectDef | undefined => registry.get(type);
export const registerEffect = (def: EffectDef): void => {
  registry.set(def.type, def);
};
export const listEffects = (): EffectDef[] => [...registry.values()];

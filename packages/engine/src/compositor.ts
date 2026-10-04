/**
 * The compositor: renders an EvaluatedComp (from @be/core) into a linear, premultiplied
 * rgba16float texture.
 *
 * Order per layer follows After Effects: source → masks → effects → transform → track matte →
 * blend. Each layer renders in its own layer space at the size it needs, padded by its effects'
 * declared bounds expansion, so blurs and glows never clip at the layer edge. The composition
 * background is not baked in. Encoders decide whether to keep alpha or flatten over the background
 * (see output.ts / encode), as AE does.
 */
import {
  type EvaluatedComp,
  type EvaluatedLayer,
  type EvaluatedShape,
  type Mat4,
  mat4Mul,
  type PathData,
  type RGBA,
  type Vec2,
} from "@be/core";
import { type EffectContext, gaussianBlur, getEffect } from "./effects.ts";
import { BLEND_ADD, BLEND_MULTIPLY, BLEND_OVER, BLEND_SCREEN, type Gpu, WORK_FORMAT } from "./gpu.ts";
import { CoverageRasterizer, type RasterTarget } from "./raster.ts";
import { APPLY_MASK, COLORIZE, LAYER_BLEND, LAYER_COMPOSITE, MASK_COMBINE } from "./shaders.ts";
import type { SimEngine } from "./sim/engine.ts";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Supplies imported images and video frames as textures. Lookups are synchronous: when a frame
 * isn't ready yet, return null and start loading it; the renderer reports the frame as incomplete
 * so previews retry and exports wait (see FrameRenderer.prepare).
 */
export interface MediaProvider {
  footage(assetId: string, frame: number, still: boolean, maxWidth: number): GPUTexture | null;
}

/** Something that can render a 3D scene into a texture. `pending`: drawn, but not final yet (physics or photo still loading). */
export interface ExternalSourceRenderer {
  renderScene(src: Extract<EvaluatedLayer["source"], { kind: "scene3d" }>, width: number, height: number): { texture: GPUTexture; pending: boolean } | null;
}

export interface RenderStats {
  layers: number;
  passes: number;
  warnings: string[];
  /** Footage frames that weren't loaded yet; the frame is incomplete when > 0. */
  missingMedia: number;
  /** Which footage frames were missing (for error messages). */
  missing: Array<{ assetId: string; frame: number }>;
  /** Simulation frames that aren't prepared (or loaded) yet; the frame is incomplete when > 0. */
  simsPending: number;
}

const MAX_LAYER_TEXTURE = 8192;

export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** User colour (sRGB-encoded, straight alpha) → linear premultiplied, for the GPU. */
export const toLinearPremul = (c: RGBA, opacity = 1): [number, number, number, number] => {
  const a = c[3] * opacity;
  return [srgbToLinear(c[0]) * a, srgbToLinear(c[1]) * a, srgbToLinear(c[2]) * a, a];
};

const invert2D = (m: Mat4): ((p: Vec2) => Vec2) => {
  // Affine 2D part of the 4x4 (column-major): x' = a x + c y + e, y' = b x + d y + f.
  const a = m[0]!;
  const b = m[1]!;
  const c = m[4]!;
  const d = m[5]!;
  const e = m[12]!;
  const f = m[13]!;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return (p) => p;
  return (p) => {
    const x = p[0] - e;
    const y = p[1] - f;
    return [(d * x - c * y) / det, (-b * x + a * y) / det];
  };
};

const mapPath = (path: PathData, f: (p: Vec2) => Vec2): PathData => ({
  closed: path.closed,
  vertices: path.vertices.map((v) => {
    const p = f(v.p);
    const at = (t?: Vec2): Vec2 | undefined => {
      if (!t) return undefined;
      const q = f([v.p[0] + t[0], v.p[1] + t[1]]);
      return [q[0] - p[0], q[1] - p[1]];
    };
    const inT = at(v.in);
    const outT = at(v.out);
    return { p, ...(inT ? { in: inT } : {}), ...(outT ? { out: outT } : {}) };
  }),
});

const boundsOf = (paths: readonly PathData[]): Rect | null => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of paths)
    for (const v of p.vertices) {
      for (const q of [v.p, v.in ? [v.p[0] + v.in[0], v.p[1] + v.in[1]] : null, v.out ? [v.p[0] + v.out[0], v.p[1] + v.out[1]] : null]) {
        if (!q) continue;
        x0 = Math.min(x0, q[0]!);
        y0 = Math.min(y0, q[1]!);
        x1 = Math.max(x1, q[0]!);
        y1 = Math.max(y1, q[1]!);
      }
    }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
};

const union = (a: Rect | null, b: Rect | null): Rect | null => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

const orthoComp = (w: number, h: number): Mat4 => {
  const m = new Float64Array(16);
  m[0] = 2 / w;
  m[5] = -2 / h;
  m[10] = 1;
  m[12] = -1;
  m[13] = 1;
  m[14] = 0.5;
  m[15] = 1;
  return m;
};

/** Normal, Add, Screen and Multiply mix in hardware (on linear light); the rest go through LAYER_BLEND. */
const hardwareBlend = (mode: EvaluatedLayer["blendMode"]): GPUBlendState | null => {
  switch (mode) {
    case "normal":
      return BLEND_OVER;
    case "add":
      return BLEND_ADD;
    case "screen":
      return BLEND_SCREEN;
    case "multiply":
      return BLEND_MULTIPLY;
    default:
      return null;
  }
};

/** LAYER_BLEND's mode numbers (see shaders.ts). */
const BLEND_INDEX: Record<EvaluatedLayer["blendMode"], number> = {
  normal: 0,
  overlay: 1,
  "soft-light": 2,
  "hard-light": 3,
  "color-dodge": 4,
  "color-burn": 5,
  darken: 6,
  lighten: 7,
  difference: 8,
  exclusion: 9,
  hue: 10,
  saturation: 11,
  color: 12,
  luminosity: 13,
  add: 14,
  screen: 15,
  multiply: 16,
};

type MatteMode = "alpha" | "alpha-inverted" | "luma" | "luma-inverted";

export class Compositor {
  readonly raster: CoverageRasterizer;
  private readonly white: GPUTexture;
  private readonly transparent: GPUTexture;
  stats: RenderStats = { layers: 0, passes: 0, warnings: [], missingMedia: 0, missing: [], simsPending: 0 };
  media: MediaProvider | null = null;
  /** Prepared smoke and water simulations (set by the renderer when a frame store is available). */
  sims: SimEngine | null = null;

  constructor(
    readonly gpu: Gpu,
    private readonly external?: ExternalSourceRenderer,
  ) {
    this.raster = new CoverageRasterizer(gpu.device);
    const mk = (rgba: number[]) => {
      const t = gpu.device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      gpu.device.queue.writeTexture({ texture: t }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
      return t;
    };
    this.white = mk([255, 255, 255, 255]);
    this.transparent = mk([0, 0, 0, 0]);
  }

  private quality: "full" | "draft" = "full";

  /** Render a composition. `scale` < 1 renders a faster, lower-resolution preview. Caller releases the result. */
  render(comp: EvaluatedComp, encoder: GPUCommandEncoder, scale = 1, quality: "full" | "draft" = "full"): GPUTexture {
    this.stats = { layers: 0, passes: 0, warnings: [], missingMedia: 0, missing: [], simsPending: 0 };
    this.quality = quality;
    return this.renderComp(comp, encoder, scale);
  }

  private renderComp(comp: EvaluatedComp, encoder: GPUCommandEncoder, scale: number): GPUTexture {
    const { gpu } = this;
    const W = Math.max(1, Math.round(comp.width * scale));
    const H = Math.max(1, Math.round(comp.height * scale));
    const out = gpu.acquire(W, H, WORK_FORMAT, "comp");
    gpu.pass(encoder, COLORIZE, out, [this.transparent.createView(), gpu.samplerNearest, { buffer: gpu.uniform(new Float32Array([0, 0, 0, 0])) }], { clear: { r: 0, g: 0, b: 0, a: 0 } });
    for (const layer of comp.layers) {
      this.stats.layers++;
      if (layer.source.kind === "adjustment") {
        this.applyAdjustment(layer, out, comp, encoder, scale);
        continue;
      }
      const rendered = this.renderLayer(layer, comp, encoder, scale);
      if (!rendered) continue;
      const matte = layer.trackMatte ? this.matteFor(layer.trackMatte, comp, encoder, scale) : null;
      this.composite(rendered.tex, rendered.rect, layer, comp, out, encoder, scale, matte, layer.trackMatte?.mode);
      gpu.release(rendered.tex);
      if (matte) gpu.release(matte);
    }
    return out;
  }

  /** A track matte in composition space: the matte layer drawn on its own (empty while that layer is off). */
  private matteFor(tm: NonNullable<EvaluatedLayer["trackMatte"]>, comp: EvaluatedComp, encoder: GPUCommandEncoder, scale: number): GPUTexture {
    return this.renderLayerToComp(tm.layer, comp, encoder, scale, !tm.active);
  }

  /** Render a layer on its own into a transparent comp-sized texture (used for track mattes). */
  private renderLayerToComp(layer: EvaluatedLayer, comp: EvaluatedComp, encoder: GPUCommandEncoder, scale: number, empty = false): GPUTexture {
    const W = Math.max(1, Math.round(comp.width * scale));
    const H = Math.max(1, Math.round(comp.height * scale));
    const t = this.gpu.acquire(W, H, WORK_FORMAT, "matte");
    this.gpu.pass(encoder, COLORIZE, t, [this.transparent.createView(), this.gpu.samplerNearest, { buffer: this.gpu.uniform(new Float32Array(4)) }], { clear: { r: 0, g: 0, b: 0, a: 0 } });
    if (empty) return t;
    const r = this.renderLayer(layer, comp, encoder, scale);
    if (r) {
      this.composite(r.tex, r.rect, layer, comp, t, encoder, scale, null, undefined);
      this.gpu.release(r.tex);
    }
    return t;
  }

  private contentRect(layer: EvaluatedLayer, comp: EvaluatedComp, toLayer: (p: Vec2) => Vec2): Rect | null {
    const s = layer.source;
    switch (s.kind) {
      case "solid":
        return { x: 0, y: 0, w: s.width, h: s.height };
      case "comp":
        return { x: 0, y: 0, w: s.comp.width, h: s.comp.height };
      case "scene3d":
      case "simulation":
        return { x: 0, y: 0, w: comp.width, h: comp.height };
      case "footage":
        return s.width > 0 && s.height > 0 ? { x: 0, y: 0, w: s.width, h: s.height } : null;
      case "text": {
        const L = this.raster.layoutText(s);
        const pad = (s.stroke?.width ?? 0) + s.size * 0.25;
        return { x: -L.blockW / 2 - pad, y: -L.blockH / 2 - pad, w: L.blockW + 2 * pad, h: L.blockH + 2 * pad };
      }
      case "shape": {
        let r: Rect | null = null;
        for (const sh of s.shapes) {
          const paths = sh.pathSpace === "comp" ? sh.paths.map((p) => mapPath(p, toLayer)) : sh.paths;
          const b = boundsOf(paths);
          if (b) r = union(r, grow(b, (sh.stroke?.width ?? 0) / 2 + 2));
        }
        return r;
      }
      default:
        return null;
    }
  }

  private renderLayer(layer: EvaluatedLayer, comp: EvaluatedComp, encoder: GPUCommandEncoder, scale: number): { tex: GPUTexture; rect: Rect } | null {
    const { gpu } = this;
    const toLayer = invert2D(layer.matrix);
    const content = this.contentRect(layer, comp, toLayer);
    if (!content || content.w <= 0 || content.h <= 0) return null;
    const pad = layer.effects.reduce((s, e) => s + (getEffect(e.type)?.expand(e.params) ?? 0), 0);
    let rect = grow(content, Math.ceil(pad));
    // Keep textures within GPU limits; very large layers render at reduced density.
    const density = Math.min(scale, MAX_LAYER_TEXTURE / Math.max(rect.w, rect.h));
    rect = { x: Math.floor(rect.x), y: Math.floor(rect.y), w: Math.ceil(rect.w), h: Math.ceil(rect.h) };
    const target: RasterTarget = { ...rect, scale: density };
    const tw = Math.max(1, Math.ceil(rect.w * density));
    const th = Math.max(1, Math.ceil(rect.h * density));
    let tex = gpu.acquire(tw, th, WORK_FORMAT, `layer:${layer.name}`);
    gpu.pass(encoder, COLORIZE, tex, [this.transparent.createView(), gpu.samplerNearest, { buffer: gpu.uniform(new Float32Array(4)) }], { clear: { r: 0, g: 0, b: 0, a: 0 } });

    const s = layer.source;
    switch (s.kind) {
      case "solid": {
        const cov = this.raster.fill([rectPath({ x: 0, y: 0, w: s.width, h: s.height })], target, "solid");
        this.colorize(cov, toLinearPremul(s.color), tex, encoder);
        gpu.defer(cov);
        break;
      }
      case "shape":
        for (const sh of s.shapes) this.drawShape(sh, toLayer, target, tex, encoder);
        break;
      case "comp": {
        const nested = this.renderComp(s.comp, encoder, density);
        this.blit(nested, { x: 0, y: 0, w: s.comp.width, h: s.comp.height }, rect, density, tex, encoder);
        gpu.release(nested);
        break;
      }
      case "footage": {
        const t = this.media?.footage(s.assetId, s.frame, s.still, Math.ceil(s.width * density));
        if (t) this.blit(t, { x: 0, y: 0, w: s.width, h: s.height }, rect, density, tex, encoder);
        else {
          this.stats.missingMedia++;
          this.stats.missing.push({ assetId: s.assetId, frame: s.frame });
        }
        break;
      }
      case "text": {
        if (s.stroke && s.stroke.width > 0) {
          const st = this.raster.text(s, target, s.stroke.width * 2, "text-stroke");
          this.colorize(st, toLinearPremul(s.stroke.color), tex, encoder);
          gpu.defer(st);
        }
        const cov = this.raster.text(s, target);
        this.colorize(cov, toLinearPremul(s.color), tex, encoder);
        gpu.defer(cov);
        break;
      }
      case "scene3d": {
        const r = s.resolved ? this.external?.renderScene(s, Math.max(1, Math.round(comp.width * density)), Math.max(1, Math.round(comp.height * density))) : null;
        if (r) {
          this.blit(r.texture, { x: 0, y: 0, w: comp.width, h: comp.height }, rect, density, tex, encoder);
          if (r.pending) this.stats.simsPending++;
        } else this.stats.warnings.push(`The 3D scene "${s.sceneId}" is missing.`);
        break;
      }
      case "simulation": {
        const t = this.sims?.render(s.sim, s.frame, Math.max(1, Math.round(comp.width * density)), Math.max(1, Math.round(comp.height * density)), encoder);
        if (t) {
          this.blit(t, { x: 0, y: 0, w: comp.width, h: comp.height }, rect, density, tex, encoder);
          gpu.release(t);
        } else this.stats.simsPending++;
        break;
      }
      default:
        break;
    }

    if (layer.masks.length) tex = this.applyMasks(layer, toLayer, target, tex, encoder);
    // The layer's own picture inside the padded texture (effects that place things on it, e.g. a ripple's centre).
    const picture = { x: (content.x - rect.x) * density, y: (content.y - rect.y) * density, w: content.w * density, h: content.h * density };
    const ectx: EffectContext = { gpu, encoder, scale: density, quality: this.quality, picture };
    for (const e of layer.effects) {
      const def = getEffect(e.type);
      if (!def) {
        this.stats.warnings.push(`The effect "${e.type}" isn't available yet and was skipped.`);
        continue;
      }
      const next = def.render(tex, e.params, { ...ectx, time: e.time });
      if (next !== tex) {
        gpu.release(tex);
        tex = next;
      }
    }
    return { tex, rect };
  }

  private colorize(cov: GPUTexture, color: number[], target: GPUTexture, encoder: GPUCommandEncoder): void {
    this.gpu.pass(encoder, COLORIZE, target, [cov.createView(), this.gpu.samplerLinear, { buffer: this.gpu.uniform(new Float32Array(color)) }], { clear: null, blend: BLEND_OVER });
    this.stats.passes++;
  }

  private drawShape(sh: EvaluatedShape, toLayer: (p: Vec2) => Vec2, target: RasterTarget, tex: GPUTexture, encoder: GPUCommandEncoder): void {
    const paths = sh.pathSpace === "comp" ? sh.paths.map((p) => mapPath(p, toLayer)) : sh.paths;
    if (paths.length === 0) return;
    if (sh.fill && sh.fill.opacity > 0 && sh.fill.color[3] > 0) {
      const cov = this.raster.fill(paths, target);
      this.colorize(cov, toLinearPremul(sh.fill.color, sh.fill.opacity), tex, encoder);
      this.gpu.defer(cov);
    }
    if (sh.stroke && sh.stroke.opacity > 0 && sh.stroke.width > 0) {
      const visible = !sh.trim || Math.abs(sh.trim.end - sh.trim.start) > 1e-6;
      if (visible) {
        const cov = this.raster.stroke(paths, sh.stroke, target, sh.trim);
        this.colorize(cov, toLinearPremul(sh.stroke.color, sh.stroke.opacity), tex, encoder);
        this.gpu.defer(cov);
      }
    }
  }

  private applyMasks(layer: EvaluatedLayer, toLayer: (p: Vec2) => Vec2, target: RasterTarget, tex: GPUTexture, encoder: GPUCommandEncoder): GPUTexture {
    const { gpu } = this;
    const modeIndex = { add: 0, subtract: 1, intersect: 2, lighten: 3, darken: 4, difference: 5, none: 6 } as const;
    let acc = gpu.acquire(tex.width, tex.height, "rgba8unorm", "mask-acc");
    let first = true;
    for (const m of layer.masks) {
      if (m.mode === "none") continue;
      const paths = m.space === "comp" ? m.paths.map((p) => mapPath(p, toLayer)) : m.paths;
      const raw = this.raster.mask(paths, m.expansion, target, "mask");
      gpu.defer(raw);
      // Feathered coverage comes from the pool; unfeathered coverage is the raster texture itself.
      const cov = m.feather > 0 ? gaussianBlur(gpu, encoder, raw, m.feather * target.scale) : raw;
      const next = gpu.acquire(tex.width, tex.height, "rgba8unorm", "mask-acc");
      const u = new ArrayBuffer(16);
      new Uint32Array(u, 0, 2).set([modeIndex[m.mode], m.inverted ? 1 : 0]);
      new Float32Array(u, 8, 1)[0] = m.opacity;
      new Uint32Array(u, 12, 1)[0] = first ? 1 : 0;
      gpu.pass(encoder, MASK_COMBINE, next, [acc.createView(), cov.createView(), gpu.samplerLinear, { buffer: gpu.uniform(u) }]);
      gpu.release(acc);
      if (cov !== raw) gpu.release(cov);
      acc = next;
      first = false;
    }
    if (first) {
      gpu.release(acc);
      return tex;
    }
    const out = gpu.acquire(tex.width, tex.height, WORK_FORMAT, "masked");
    gpu.pass(encoder, APPLY_MASK, out, [tex.createView(), acc.createView(), gpu.samplerLinear]);
    gpu.release(acc);
    gpu.release(tex);
    return out;
  }

  /** Copy a texture covering `srcRect` (layer units) into `dst` covering `dstRect`. */
  private blit(src: GPUTexture, srcRect: Rect, dstRect: Rect, density: number, dst: GPUTexture, encoder: GPUCommandEncoder): void {
    const m = orthoRect(dstRect);
    this.drawQuad(src, srcRect, m, 1, dst, encoder, BLEND_OVER, null, undefined, { w: dstRect.w * density, h: dstRect.h * density });
  }

  private composite(
    tex: GPUTexture,
    rect: Rect,
    layer: EvaluatedLayer,
    comp: EvaluatedComp,
    out: GPUTexture,
    encoder: GPUCommandEncoder,
    _scale: number,
    matte: GPUTexture | null,
    matteMode: MatteMode | undefined,
  ): void {
    const mvp = mat4Mul(orthoComp(comp.width, comp.height), layer.matrix);
    const hw = hardwareBlend(layer.blendMode);
    if (hw) this.drawQuad(tex, rect, mvp, layer.opacity, out, encoder, hw, matte, matteMode, { w: out.width, h: out.height });
    else this.drawBlended(tex, rect, mvp, layer.opacity, out, encoder, BLEND_INDEX[layer.blendMode] ?? 0, matte, matteMode, false);
  }

  /**
   * Draw a layer onto `target` with a blend mode that reads the picture below: over a copy of it,
   * replacing the pixels the layer covers (see LAYER_BLEND).
   */
  private drawBlended(src: GPUTexture, rect: Rect, mvp: Mat4, opacity: number, target: GPUTexture, encoder: GPUCommandEncoder, mode: number, matte: GPUTexture | null, matteMode: MatteMode | undefined, adjust: boolean): void {
    const { gpu } = this;
    const below = gpu.acquire(target.width, target.height, target.format, "backdrop");
    encoder.copyTextureToTexture({ texture: target }, { texture: below }, [target.width, target.height]);
    const u = new ArrayBuffer(112);
    new Float32Array(u, 0, 16).set(Float32Array.from(mvp));
    new Float32Array(u, 64, 5).set([rect.x, rect.y, rect.w, rect.h, opacity]);
    const modes = { alpha: 1, "alpha-inverted": 2, luma: 3, "luma-inverted": 4 } as const;
    new Uint32Array(u, 84, 1)[0] = matte && matteMode ? modes[matteMode] : 0;
    new Float32Array(u, 88, 2).set([target.width, target.height]);
    new Uint32Array(u, 96, 2).set([mode, adjust ? 1 : 0]);
    const pipe = gpu.pipeline(LAYER_BLEND, target.format);
    const bind = gpu.device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: gpu.samplerLinear },
        { binding: 2, resource: { buffer: gpu.uniform(u) } },
        { binding: 3, resource: (matte ?? this.transparent).createView() },
        { binding: 4, resource: below.createView() },
      ],
    });
    const rp = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "load", storeOp: "store" }] });
    rp.setPipeline(pipe);
    rp.setBindGroup(0, bind);
    rp.draw(6);
    rp.end();
    gpu.release(below);
    this.stats.passes++;
  }

  private drawQuad(
    src: GPUTexture,
    rect: Rect,
    mvp: Mat4,
    opacity: number,
    target: GPUTexture,
    encoder: GPUCommandEncoder,
    blend: GPUBlendState,
    matte: GPUTexture | null,
    matteMode: MatteMode | undefined,
    size: { w: number; h: number },
  ): void {
    const u = new ArrayBuffer(96);
    new Float32Array(u, 0, 16).set(Float32Array.from(mvp));
    new Float32Array(u, 64, 5).set([rect.x, rect.y, rect.w, rect.h, opacity]);
    const modes = { alpha: 1, "alpha-inverted": 2, luma: 3, "luma-inverted": 4 } as const;
    new Uint32Array(u, 84, 1)[0] = matte && matteMode ? modes[matteMode] : 0;
    new Float32Array(u, 88, 2).set([size.w, size.h]);
    const pipe = this.gpu.pipeline(LAYER_COMPOSITE, target.format, blend);
    const bind = this.gpu.device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: this.gpu.samplerLinear },
        { binding: 2, resource: { buffer: this.gpu.uniform(u) } },
        { binding: 3, resource: (matte ?? this.transparent).createView() },
      ],
    });
    const rp = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "load", storeOp: "store" }] });
    rp.setPipeline(pipe);
    rp.setBindGroup(0, bind);
    rp.draw(6);
    rp.end();
    this.stats.passes++;
  }

  /**
   * Adjustment layer: run its effects on everything below it, where it applies — its frame (the
   * composition's size in its own space, so moving or scaling it moves that), its masks and its track
   * matte — mixed in by its opacity and blend mode.
   */
  private applyAdjustment(layer: EvaluatedLayer, out: GPUTexture, comp: EvaluatedComp, encoder: GPUCommandEncoder, scale: number): void {
    if (layer.effects.length === 0) return;
    const { gpu } = this;
    let tex = gpu.acquire(out.width, out.height, WORK_FORMAT, "adjust");
    encoder.copyTextureToTexture({ texture: out }, { texture: tex }, [out.width, out.height]);
    const ectx: EffectContext = { gpu, encoder, scale, quality: this.quality };
    for (const e of layer.effects) {
      const def = getEffect(e.type);
      if (!def) {
        this.stats.warnings.push(`The effect "${e.type}" isn't available yet and was skipped.`);
        continue;
      }
      const next = def.render(tex, e.params, { ...ectx, time: e.time });
      if (next !== tex) {
        gpu.release(tex);
        tex = next;
      }
    }
    const coverage = this.adjustmentCoverage(layer, comp, out, encoder, scale);
    const whole: Rect = { x: 0, y: 0, w: comp.width, h: comp.height };
    this.drawBlended(tex, whole, orthoRect(whole), layer.opacity, out, encoder, BLEND_INDEX[layer.blendMode] ?? 0, coverage, "alpha", true);
    gpu.release(coverage);
    gpu.release(tex);
  }

  /** Where an adjustment layer applies, in composition space (alpha): its frame, its masks, its track matte. */
  private adjustmentCoverage(layer: EvaluatedLayer, comp: EvaluatedComp, out: GPUTexture, encoder: GPUCommandEncoder, scale: number): GPUTexture {
    const { gpu } = this;
    const rect: Rect = { x: 0, y: 0, w: comp.width, h: comp.height };
    const density = Math.min(scale, MAX_LAYER_TEXTURE / Math.max(rect.w, rect.h));
    const target: RasterTarget = { ...rect, scale: density };
    let area = gpu.acquire(Math.max(1, Math.ceil(rect.w * density)), Math.max(1, Math.ceil(rect.h * density)), WORK_FORMAT, "adjust-area");
    gpu.pass(encoder, COLORIZE, area, [this.white.createView(), gpu.samplerNearest, { buffer: gpu.uniform(new Float32Array([1, 1, 1, 1])) }], { clear: { r: 0, g: 0, b: 0, a: 0 } });
    if (layer.masks.length) area = this.applyMasks(layer, invert2D(layer.matrix), target, area, encoder);
    const cov = gpu.acquire(out.width, out.height, WORK_FORMAT, "adjust-coverage");
    gpu.pass(encoder, COLORIZE, cov, [this.transparent.createView(), gpu.samplerNearest, { buffer: gpu.uniform(new Float32Array(4)) }], { clear: { r: 0, g: 0, b: 0, a: 0 } });
    const matte = layer.trackMatte ? this.matteFor(layer.trackMatte, comp, encoder, scale) : null;
    this.drawQuad(area, rect, mat4Mul(orthoComp(comp.width, comp.height), layer.matrix), 1, cov, encoder, BLEND_OVER, matte, layer.trackMatte?.mode, { w: out.width, h: out.height });
    gpu.release(area);
    if (matte) gpu.release(matte);
    return cov;
  }

  /** A 1x1 white texture (e.g. "no output mask"). */
  get whiteTexture(): GPUTexture {
    return this.white;
  }
}

const rectPath = (r: Rect): PathData => ({
  closed: true,
  vertices: [{ p: [r.x, r.y] }, { p: [r.x + r.w, r.y] }, { p: [r.x + r.w, r.y + r.h] }, { p: [r.x, r.y + r.h] }],
});

/** Matrix mapping layer-space `r` to clip space covering the whole target. */
const orthoRect = (r: Rect): Mat4 => {
  const m = new Float64Array(16);
  m[0] = 2 / r.w;
  m[5] = -2 / r.h;
  m[10] = 1;
  m[12] = -1 - (2 * r.x) / r.w;
  m[13] = 1 + (2 * r.y) / r.h;
  m[14] = 0.5;
  m[15] = 1;
  return m;
};

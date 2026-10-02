/**
 * Coverage rasterisation for vector paths (shape fills/strokes, masks, regions, output masks).
 *
 * Paths are rasterised as antialiased coverage with Chromium's Canvas 2D (Skia) into an 8-bit
 * coverage texture. Colour is applied afterwards on the GPU in float precision, so the 8-bit
 * coverage never limits colour depth. Trim paths are cut on the CPU from an arc-length
 * parameterisation. Behind the `CoverageRasterizer` interface this can move to a GPU path
 * renderer (e.g. Vello/CanvasKit) without touching callers.
 */
import { flattenPath, type PathData, type Vec2 } from "@be/core";

export interface RasterTarget {
  /** Rect of layer space covered by the texture. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Pixels per layer unit (1 = native). */
  readonly scale: number;
}

export interface StrokeStyle {
  readonly width: number;
  readonly cap: "butt" | "round" | "square";
  readonly join: "miter" | "round" | "bevel";
}

export interface TrimWindow {
  readonly start: number; // 0..1
  readonly end: number; // 0..1
  readonly offset: number; // turns (1 = full path)
}

/** Cut a polyline to the [start, end] window (wrapping for offsets); returns 0..2 pieces. */
export const trimPolyline = (pts: readonly Vec2[], closed: boolean, trim: TrimWindow): Vec2[][] => {
  const ring = closed && pts.length > 2 ? [...pts, pts[0]!] : [...pts];
  const cum: number[] = [0];
  for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1]! + Math.hypot(ring[i]![0] - ring[i - 1]![0], ring[i]![1] - ring[i - 1]![1]));
  const total = cum.at(-1) ?? 0;
  if (total <= 0) return [];
  let a = Math.min(trim.start, trim.end);
  let b = Math.max(trim.start, trim.end);
  if (b - a >= 1 - 1e-9) return [ring];
  if (b - a <= 1e-9) return [];
  const off = trim.offset - Math.floor(trim.offset);
  a += off;
  b += off;
  const pointAt = (d: number): Vec2 => {
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < d) lo = mid;
      else hi = mid;
    }
    const seg = cum[hi]! - cum[lo]!;
    const f = seg > 0 ? (d - cum[lo]!) / seg : 0;
    return [ring[lo]![0] + (ring[hi]![0] - ring[lo]![0]) * f, ring[lo]![1] + (ring[hi]![1] - ring[lo]![1]) * f];
  };
  const piece = (u0: number, u1: number): Vec2[] => {
    const d0 = u0 * total;
    const d1 = u1 * total;
    const out: Vec2[] = [pointAt(d0)];
    for (let i = 0; i < cum.length; i++) if (cum[i]! > d0 && cum[i]! < d1) out.push(ring[i]!);
    out.push(pointAt(d1));
    return out;
  };
  if (b <= 1) return [piece(a, b)];
  if (a >= 1) return [piece(a - 1, b - 1)];
  // Wraps across the path's start point.
  if (closed) {
    const first = piece(a, 1);
    const second = piece(0, b - 1);
    return [[...first, ...second.slice(1)]];
  }
  return [piece(a, 1), piece(0, b - 1)];
};

export interface TextSpec {
  readonly text: string;
  readonly font: string;
  readonly weight: number;
  readonly size: number;
  readonly align: "left" | "center" | "right";
  readonly lineHeight: number;
  readonly tracking: number;
}

/** Layout of a text block centred on the layer origin. */
export interface TextLayout {
  readonly lines: readonly string[];
  readonly widths: readonly number[];
  readonly blockW: number;
  readonly blockH: number;
  readonly lineH: number;
}

export class CoverageRasterizer {
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;

  constructor(private readonly device: GPUDevice) {
    this.canvas = new OffscreenCanvas(16, 16);
    const ctx = this.canvas.getContext("2d", { willReadFrequently: false, alpha: true });
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    this.ctx = ctx;
  }

  private begin(target: RasterTarget): OffscreenCanvasRenderingContext2D {
    const w = Math.max(1, Math.ceil(target.w * target.scale));
    const h = Math.max(1, Math.ceil(target.h * target.scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    c.setTransform(target.scale, 0, 0, target.scale, -target.x * target.scale, -target.y * target.scale);
    c.fillStyle = "#fff";
    c.strokeStyle = "#fff";
    return c;
  }

  private traceBezier(c: OffscreenCanvasRenderingContext2D, path: PathData): void {
    const vs = path.vertices;
    if (vs.length === 0) return;
    c.moveTo(vs[0]!.p[0], vs[0]!.p[1]);
    const n = vs.length;
    const count = path.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = vs[i]!;
      const b = vs[(i + 1) % n]!;
      const ao = a.out ?? [0, 0];
      const bi = b.in ?? [0, 0];
      if (!ao[0] && !ao[1] && !bi[0] && !bi[1]) c.lineTo(b.p[0], b.p[1]);
      else c.bezierCurveTo(a.p[0] + ao[0], a.p[1] + ao[1], b.p[0] + bi[0], b.p[1] + bi[1], b.p[0], b.p[1]);
    }
    if (path.closed) c.closePath();
  }

  /** Upload the canvas into a fresh r8unorm-ish texture (rgba8 → only .r is read). */
  private upload(label: string): GPUTexture {
    const tex = this.device.createTexture({
      label,
      size: [this.canvas.width, this.canvas.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture({ source: this.canvas }, { texture: tex }, [this.canvas.width, this.canvas.height]);
    return tex;
  }

  fill(paths: readonly PathData[], target: RasterTarget, label = "fill"): GPUTexture {
    const c = this.begin(target);
    c.beginPath();
    for (const p of paths) this.traceBezier(c, p);
    c.fill("nonzero");
    return this.upload(label);
  }

  stroke(paths: readonly PathData[], style: StrokeStyle, target: RasterTarget, trim?: TrimWindow, label = "stroke"): GPUTexture {
    const c = this.begin(target);
    c.lineWidth = style.width;
    c.lineCap = style.cap;
    c.lineJoin = style.join;
    c.miterLimit = 4;
    c.beginPath();
    for (const p of paths) {
      if (!trim) {
        this.traceBezier(c, p);
        continue;
      }
      for (const piece of trimPolyline(flattenPath(p, 24), p.closed, trim)) {
        if (piece.length < 2) continue;
        c.moveTo(piece[0]![0], piece[0]![1]);
        for (let i = 1; i < piece.length; i++) c.lineTo(piece[i]![0], piece[i]![1]);
      }
    }
    c.stroke();
    return this.upload(label);
  }

  private fontString(t: TextSpec): string {
    // Quote single family names with spaces; leave font lists ("A, B") as they are.
    const family = /\s/.test(t.font) && !/[",]/.test(t.font) ? `"${t.font}"` : t.font;
    return `${t.weight} ${Math.max(1, t.size)}px ${family}, "Segoe UI", sans-serif`;
  }

  /** Measure a text block (layer units). */
  layoutText(t: TextSpec): TextLayout {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.font = this.fontString(t);
    c.letterSpacing = `${t.tracking}px`;
    const lines = t.text.split(/\r?\n/);
    const widths = lines.map((l) => c.measureText(l).width);
    const lineH = t.size * t.lineHeight;
    return { lines, widths, blockW: Math.max(1, ...widths), blockH: Math.max(lineH, lines.length * lineH), lineH };
  }

  /** Text coverage, block centred on the layer origin; `strokeWidth` > 0 draws outlines instead of fills. */
  text(t: TextSpec, target: RasterTarget, strokeWidth = 0, label = "text"): GPUTexture {
    const L = this.layoutText(t);
    const c = this.begin(target);
    c.font = this.fontString(t);
    c.letterSpacing = `${t.tracking}px`;
    c.textAlign = t.align;
    c.textBaseline = "middle";
    const x = t.align === "left" ? -L.blockW / 2 : t.align === "right" ? L.blockW / 2 : 0;
    const top = -L.blockH / 2;
    L.lines.forEach((line, i) => {
      const y = top + (i + 0.5) * L.lineH;
      if (strokeWidth > 0) {
        c.lineWidth = strokeWidth;
        c.lineJoin = "round";
        c.strokeText(line, x, y);
      } else c.fillText(line, x, y);
    });
    return this.upload(label);
  }

  /** Mask coverage with expansion (grow/shrink by stroking) — feather is applied on the GPU. */
  mask(paths: readonly PathData[], expansion: number, target: RasterTarget, label = "mask"): GPUTexture {
    const c = this.begin(target);
    c.beginPath();
    for (const p of paths) this.traceBezier(c, p);
    c.fill("nonzero");
    if (expansion !== 0) {
      c.lineJoin = "round";
      c.lineWidth = Math.abs(expansion) * 2;
      if (expansion > 0) c.stroke();
      else {
        c.globalCompositeOperation = "destination-out";
        c.stroke();
        c.globalCompositeOperation = "source-over";
      }
    }
    return this.upload(label);
  }
}

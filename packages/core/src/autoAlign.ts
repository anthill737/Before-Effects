/**
 * Camera-assisted projector alignment: the maths, independent of how images are captured.
 *
 *  1. Where projector pixels land, seen by the camera: binary-reflected Gray-code stripes, each with
 *     its inverse (Inokuchi et al. 1984; Salvi et al. 2004, "Pattern codification strategies in
 *     structured light systems"; the scheme OpenCV's structured_light GrayCodePattern uses). A camera
 *     pixel's bit is decided by pattern − inverse, which cancels the surface's colour, ambient light
 *     and exposure; bits too close to call are not used.
 *  2. Where the camera's pixels are in the house photo (venue canvas): a homography from reference
 *     points (normalised DLT, Hartley & Zisserman; RANSAC for automatic matches), plus a thin-plate
 *     spline on the residuals (Bookstein 1989) when there are enough points, for surfaces that aren't
 *     in one plane with the rest (recessed doors, gables, columns).
 *  3. Chaining both gives, for every observed projector block, the photo point it lights. The
 *     projector's alignment is then a homography fitted to all of them plus a residual grid over the
 *     projector's pixels (as camera-based registration of projector displays does, e.g. Raskar et al.
 *     1999), smoothly filled where nothing was observed. Seen this way, lens distortion of projector
 *     and camera and the camera's offset from the projector don't matter: every block is measured
 *     where it actually lands.
 */
import { applyHomography, homographyResiduals, mat3Invert, type Mat3, solveHomography, solveLinear } from "./geometry.ts";
import type { Calibration, CalibrationPoint, PathData, Vec2 } from "./model.ts";
import { flattenPath } from "./pathmath.ts";

const percentile = (xs: number[], q: number) => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
};

// ---------------------------------------------------------------------------------------------
// Patterns

export interface StripePattern {
  readonly axis: "x" | "y";
  /** Bit of the Gray code (0 = finest stripes). */
  readonly bit: number;
  readonly inverse: boolean;
}

/** What is projected, in order: black, white, then each bit (coarsest first) and its inverse, x then y. */
export type AlignPattern = { readonly kind: "black" } | { readonly kind: "white" } | ({ readonly kind: "stripes" } & StripePattern);

export interface PatternPlan {
  readonly width: number;
  readonly height: number;
  /** Projector pixels per code block (a power of two). */
  readonly block: number;
  readonly bitsX: number;
  readonly bitsY: number;
  readonly patterns: readonly AlignPattern[];
}

export const gray = (n: number): number => n ^ (n >> 1);
export const grayInverse = (g: number): number => {
  let n = g;
  for (let s = g >> 1; s; s >>= 1) n ^= s;
  return n;
};

/**
 * The pattern sequence for a projector. `block`: the finest code block in projector pixels (the
 * narrowest stripes are twice as wide); 4 suits a phone seeing a 1080p projector from beside it.
 */
export const planPatterns = (width: number, height: number, block = 4): PatternPlan => {
  const bitsX = Math.max(1, Math.ceil(Math.log2(Math.ceil(width / block))));
  const bitsY = Math.max(1, Math.ceil(Math.log2(Math.ceil(height / block))));
  const patterns: AlignPattern[] = [{ kind: "black" }, { kind: "white" }];
  for (const [axis, bits] of [["x", bitsX], ["y", bitsY]] as const)
    for (let bit = bits - 1; bit >= 0; bit--) {
      patterns.push({ kind: "stripes", axis, bit, inverse: false });
      patterns.push({ kind: "stripes", axis, bit, inverse: true });
    }
  return { width, height, block, bitsX, bitsY, patterns };
};

/** Whether a projector pixel is lit in a stripe pattern. */
export const stripeLit = (p: StripePattern, x: number, y: number, block: number): boolean => {
  const v = Math.floor((p.axis === "x" ? x : y) / block);
  const on = ((gray(v) >> p.bit) & 1) === 1;
  return p.inverse ? !on : on;
};

// ---------------------------------------------------------------------------------------------
// Decoding

/** An 8-bit greyscale image (camera frames are converted to this). */
export interface Gray8 {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface DecodeOptions {
  /** Minimum white − black difference (0–255) for a pixel to count as lit by the projector. */
  readonly minLight?: number;
  /** A bit counts only if |pattern − inverse| is at least this share of white − black (and ≥ 4 levels). */
  readonly bitContrast?: number;
  /** Bits whose stripes the camera resolves on less than this share of lit pixels are dropped (and finer ones). */
  readonly minBitShare?: number;
}

export interface Correspondence {
  /** Projector pixel (centre of the code block). */
  readonly projector: Vec2;
  /** Camera pixel (centroid of the camera pixels that decoded to that block). */
  readonly camera: Vec2;
  /** Camera pixels behind it. */
  readonly pixels: number;
}

export interface DecodeResult {
  readonly correspondences: Correspondence[];
  /** Camera pixels lit by the projector (white − black ≥ minLight). */
  readonly litMask: Uint8Array;
  readonly litShare: number;
  /** Lit pixels on the frame's edge: the projected area runs outside the camera's view there. */
  readonly litAtEdge: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
  /** Projector pixels per decoded block in x and y (coarser than the plan when fine stripes weren't resolved). */
  readonly resolution: { readonly x: number; readonly y: number };
  /** Projector pixels per correspondence cell (blocks pooled so each has enough camera pixels). */
  readonly cell: number;
  /** Share of lit pixels each bit could be read on, coarsest first. */
  readonly bitShare: { readonly x: number[]; readonly y: number[] };
  /** Share of lit camera pixels with a usable code. */
  readonly decodedShare: number;
}

/**
 * Decode captured frames, in plan order (black, white, then stripes/inverse pairs). Frames must all
 * be the same size and taken from the same place.
 */
export const decodeStripes = (plan: PatternPlan, frames: readonly Gray8[], o: DecodeOptions = {}): DecodeResult => {
  if (frames.length !== plan.patterns.length) throw new Error(`Expected ${plan.patterns.length} frames, got ${frames.length}.`);
  const { width: w, height: h } = frames[0]!;
  for (const f of frames) if (f.width !== w || f.height !== h) throw new Error("All captured frames must be the same size.");
  const n = w * h;
  const minLight = o.minLight ?? 24;
  const contrast = o.bitContrast ?? 0.18;
  const minShare = o.minBitShare ?? 0.55;
  const black = frames[0]!.data;
  const white = frames[1]!.data;
  const lit = new Uint8Array(n);
  let litCount = 0;
  for (let i = 0; i < n; i++)
    if (white[i]! - black[i]! >= minLight) {
      lit[i] = 1;
      litCount++;
    }
  const edge = { left: 0, right: 0, top: 0, bottom: 0 };
  for (let y = 0; y < h; y++) {
    edge.left += lit[y * w]!;
    edge.right += lit[y * w + w - 1]!;
  }
  for (let x = 0; x < w; x++) {
    edge.top += lit[x]!;
    edge.bottom += lit[(h - 1) * w + x]!;
  }

  // Per axis: read every bit, then keep bits down to the finest one read on enough lit pixels.
  const decodeAxis = (axis: "x" | "y", bits: number) => {
    const code = new Int32Array(n).fill(-1);
    const known = new Uint8Array(n);
    const share: number[] = [];
    const bitsOf: Uint8Array[] = [];
    const okOf: Uint8Array[] = [];
    for (let bit = bits - 1; bit >= 0; bit--) {
      const k = plan.patterns.findIndex((p) => p.kind === "stripes" && p.axis === axis && p.bit === bit && !p.inverse);
      const P = frames[k]!.data;
      const I = frames[k + 1]!.data;
      const b = new Uint8Array(n);
      const ok = new Uint8Array(n);
      let good = 0;
      for (let i = 0; i < n; i++) {
        if (!lit[i]) continue;
        const d = P[i]! - I[i]!;
        if (Math.abs(d) >= Math.max(4, contrast * (white[i]! - black[i]!))) {
          ok[i] = 1;
          good++;
          b[i] = d > 0 ? 1 : 0;
        }
      }
      share.push(litCount ? good / litCount : 0);
      bitsOf.push(b);
      okOf.push(ok);
    }
    // The finest bit kept: all coarser bits must be usable too.
    let used = 0;
    while (used < bits && share[used]! >= minShare) used++;
    if (used === 0) return { code, known, share, used };
    for (let i = 0; i < n; i++) {
      if (!lit[i]) continue;
      let g = 0;
      let ok = true;
      for (let j = 0; j < used; j++) {
        if (!okOf[j]![i]) {
          ok = false;
          break;
        }
        g = (g << 1) | bitsOf[j]![i]!;
      }
      if (!ok) continue;
      code[i] = grayInverse(g);
      known[i] = 1;
    }
    return { code, known, share, used };
  };
  const ax = decodeAxis("x", plan.bitsX);
  const ay = decodeAxis("y", plan.bitsY);
  const rx = plan.block * 2 ** (plan.bitsX - ax.used);
  const ry = plan.block * 2 ** (plan.bitsY - ay.used);

  // Pool camera pixels into cells of a few blocks, sized so each cell has enough pixels to average
  // (a block can be smaller than a camera pixel from far away). Each cell pairs the mean of its pixels'
  // block centres with the mean of their camera positions.
  const px = new Float32Array(n).fill(-1);
  const py = new Float32Array(n);
  let decoded = 0;
  for (let i = 0; i < n; i++) {
    if (!ax.known[i] || !ay.known[i]) continue;
    const X = (ax.code[i]! + 0.5) * rx;
    const Y = (ay.code[i]! + 0.5) * ry;
    if (X >= plan.width || Y >= plan.height) continue;
    px[i] = X;
    py[i] = Y;
    decoded++;
  }
  const pool = (cell: number) => {
    const cols = Math.ceil(plan.width / cell) + 1;
    const sums = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      if (px[i]! < 0) continue;
      const key = Math.floor(py[i]! / cell) * cols + Math.floor(px[i]! / cell);
      const x = i % w;
      const y = (i - x) / w;
      const s = sums.get(key);
      if (s) {
        s[0]! += x;
        s[1]! += y;
        s[2]! += px[i]!;
        s[3]! += py[i]!;
        s[4]!++;
        s[5]! += x * x + y * y;
      } else sums.set(key, [x, y, px[i]!, py[i]!, 1, x * x + y * y]);
    }
    return sums;
  };
  let cell = Math.max(rx, ry);
  let sums = pool(cell);
  for (;;) {
    const counts = [...sums.values()].map((s) => s[4]!).sort((a, b) => a - b);
    const median = counts.length ? counts[Math.floor(counts.length / 2)]! : 0;
    if (median >= 8 || cell >= 64 || !counts.length) break;
    cell *= 2;
    sums = pool(cell);
  }
  const correspondences: Correspondence[] = [];
  for (const [, [sx, sy, spx, spy, c, s2]] of sums) {
    if (c! < 3) continue;
    const mx = sx! / c!;
    const my = sy! / c!;
    // Pixels scattered far beyond one cell's footprint are misreads (reflections, mixed surfaces).
    const spread = Math.sqrt(Math.max(0, s2! / c! - mx * mx - my * my));
    if (spread > 2 * Math.sqrt(c!) + 3) continue;
    correspondences.push({ projector: [spx! / c!, spy! / c!], camera: [mx, my], pixels: c! });
  }
  return {
    correspondences,
    litMask: lit,
    litShare: litCount / n,
    litAtEdge: { left: edge.left / h, right: edge.right / h, top: edge.top / w, bottom: edge.bottom / w },
    resolution: { x: rx, y: ry },
    cell,
    bitShare: { x: ax.share, y: ay.share },
    decodedShare: litCount ? decoded / litCount : 0,
  };
};

// ---------------------------------------------------------------------------------------------
// The phone's lens distortion

/**
 * Radial lens distortion, division model (Fitzgibbon 2001): undistorted = c + (d − c) / (1 + λ·r²),
 * r measured in half-diagonals from the image centre.
 */
export interface Lens {
  readonly cx: number;
  readonly cy: number;
  readonly norm: number;
  readonly lambda: number;
}
export const plainLens = (width: number, height: number): Lens => ({ cx: width / 2, cy: height / 2, norm: Math.hypot(width, height) / 2, lambda: 0 });
export const undistort = (l: Lens, p: Vec2): Vec2 => {
  if (!l.lambda) return p;
  const x = (p[0] - l.cx) / l.norm, y = (p[1] - l.cy) / l.norm;
  const s = 1 / (1 + l.lambda * (x * x + y * y));
  return [l.cx + x * s * l.norm, l.cy + y * s * l.norm];
};
export const distort = (l: Lens, p: Vec2): Vec2 => {
  if (!l.lambda) return p;
  const x = (p[0] - l.cx) / l.norm, y = (p[1] - l.cy) / l.norm;
  const ru = Math.hypot(x, y);
  if (ru < 1e-12) return p;
  // ru = rd / (1 + λ rd²)  →  λ ru rd² − rd + ru = 0
  const disc = 1 - 4 * l.lambda * ru * ru;
  if (disc < 0) return p;
  const rd = (1 - Math.sqrt(disc)) / (2 * l.lambda * ru);
  const k = rd / ru;
  return [l.cx + x * k * l.norm, l.cy + y * k * l.norm];
};

/**
 * Estimate the camera's distortion from the projector↔camera correspondences: on the main plane of the
 * house (the largest set related by one homography) the right λ makes camera → projector a homography.
 * Returns plain (λ = 0) when the data can't tell.
 */
export const estimateLens = (corr: readonly Correspondence[], size: { width: number; height: number }): { lens: Lens; planeShare: number; residualPx: number } => {
  const base = plainLens(size.width, size.height);
  const step = Math.max(1, Math.floor(corr.length / 1500));
  const sample = corr.filter((_, i) => i % step === 0);
  if (sample.length < 40) return { lens: base, planeShare: 0, residualPx: Number.NaN };
  const proj = sample.map((c) => c.projector);
  // The main plane, with a loose threshold (distortion adds error before it's removed).
  const r0 = ransacHomography(
    sample.map((c) => c.camera),
    proj,
    Math.max(8, 0.006 * Math.max(...proj.map((p) => Math.max(p[0], p[1])))),
    300,
  );
  if (!r0) return { lens: base, planeShare: 0, residualPx: Number.NaN };
  const plane = sample.filter((_, i) => r0.inliers[i]);
  const cost = (lambda: number) => {
    const l = { ...base, lambda };
    const src = plane.map((c) => undistort(l, c.camera));
    const H = solveHomography(
      src,
      plane.map((c) => c.projector),
    );
    if (!H) return Number.POSITIVE_INFINITY;
    return percentile(
      homographyResiduals(
        H,
        src,
        plane.map((c) => c.projector),
      ),
      0.5,
    );
  };
  let best = 0;
  let bestCost = cost(0);
  for (let lambda = -0.4; lambda <= 0.4001; lambda += 0.025) {
    const c = cost(lambda);
    if (c < bestCost) {
      bestCost = c;
      best = lambda;
    }
  }
  // Golden-section refinement around the best grid value.
  let a = best - 0.025, b = best + 0.025;
  const gr = (Math.sqrt(5) - 1) / 2;
  for (let k = 0; k < 24; k++) {
    const c1 = b - gr * (b - a), c2 = a + gr * (b - a);
    if (cost(c1) < cost(c2)) b = c2;
    else a = c1;
  }
  const lambda = (a + b) / 2;
  const c = cost(lambda);
  // Only keep a correction that clearly helps (else noise would pick a random λ).
  const keep = c < 0.85 * cost(0);
  return { lens: keep ? { ...base, lambda } : base, planeShare: plane.length / sample.length, residualPx: keep ? c : cost(0) };
};

// ---------------------------------------------------------------------------------------------
// Camera ↔ house photo

/** A point identified in both the camera image and the house photo (venue canvas). */
export interface ReferencePair {
  readonly camera: Vec2;
  readonly photo: Vec2;
}

/** Deterministic pseudo-random numbers (RANSAC must give the same answer twice). */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

/** A homography robust to wrong matches (RANSAC on 4-point samples, refitted on the inliers). */
export const ransacHomography = (src: readonly Vec2[], dst: readonly Vec2[], threshold: number, iterations = 600, weights?: readonly number[]): { H: Mat3; inliers: boolean[] } | null => {
  const n = src.length;
  if (n < 4) return null;
  if (n === 4) {
    const H = solveHomography(src, dst);
    return H ? { H, inliers: [true, true, true, true] } : null;
  }
  const rand = rng(12345);
  let best: boolean[] | null = null;
  let bestCount = 0;
  for (let it = 0; it < iterations; it++) {
    const idx = new Set<number>();
    while (idx.size < 4) idx.add(Math.floor(rand() * n));
    const s = [...idx];
    const H = solveHomography(
      s.map((i) => src[i]!),
      s.map((i) => dst[i]!),
    );
    if (!H) continue;
    const r = homographyResiduals(H, src, dst);
    const inl = r.map((e) => Number.isFinite(e) && e <= threshold);
    const c = inl.reduce((t, v, i) => t + (v ? (weights?.[i] ?? 1) : 0), 0);
    if (c > bestCount) {
      bestCount = c;
      best = inl;
      if (inl.every(Boolean)) break;
    }
  }
  if (!best || best.filter(Boolean).length < 4) return null;
  // Refit on the inliers, then take the inliers of the refit.
  for (let pass = 0; pass < 2; pass++) {
    const H = solveHomography(
      src.filter((_, i) => best![i]),
      dst.filter((_, i) => best![i]),
    );
    if (!H) return null;
    best = homographyResiduals(H, src, dst).map((e) => e <= threshold);
  }
  const H = solveHomography(
    src.filter((_, i) => best![i]),
    dst.filter((_, i) => best![i]),
  );
  return H ? { H, inliers: best } : null;
};

/** Thin-plate spline from 2D points to 2D values (Bookstein 1989), with optional smoothing. */
export interface Tps {
  readonly centers: readonly Vec2[];
  readonly w: readonly Vec2[];
  readonly a: readonly [Vec2, Vec2, Vec2];
  readonly scale: number;
}
const tpsU = (r2: number) => (r2 <= 1e-12 ? 0 : r2 * Math.log(r2) * 0.5);
export const fitTps = (pts: readonly Vec2[], vals: readonly Vec2[], smoothing = 0): Tps | null => {
  const n = pts.length;
  if (n < 3) return null;
  // Work in units of the points' spread so the system stays well conditioned.
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cy = pts.reduce((s, p) => s + p[1], 0) / n;
  const scale = Math.max(1e-9, Math.sqrt(pts.reduce((s, p) => s + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / n));
  const q = pts.map((p) => [(p[0] - cx) / scale, (p[1] - cy) / scale] as Vec2);
  const m = n + 3;
  const A = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i]![j] = i === j ? smoothing : tpsU((q[i]![0] - q[j]![0]) ** 2 + (q[i]![1] - q[j]![1]) ** 2);
    A[i]![n] = 1;
    A[i]![n + 1] = q[i]![0];
    A[i]![n + 2] = q[i]![1];
    A[n]![i] = 1;
    A[n + 1]![i] = q[i]![0];
    A[n + 2]![i] = q[i]![1];
  }
  const solve = (k: 0 | 1) => solveLinear(A, [...vals.map((v) => v[k]), 0, 0, 0]);
  const sx = solve(0);
  const sy = solve(1);
  if (!sx || !sy) return null;
  return {
    centers: pts.map((p) => [p[0], p[1]] as Vec2),
    w: q.map((_, i) => [sx[i]!, sy[i]!] as Vec2),
    a: [
      [sx[n]!, sy[n]!],
      [sx[n + 1]!, sy[n + 1]!],
      [sx[n + 2]!, sy[n + 2]!],
    ],
    scale,
  };
};
export const evalTps = (t: Tps, p: Vec2): Vec2 => {
  const n = t.centers.length;
  const cx = t.centers.reduce((s, c) => s + c[0], 0) / n;
  const cy = t.centers.reduce((s, c) => s + c[1], 0) / n;
  const x = (p[0] - cx) / t.scale;
  const y = (p[1] - cy) / t.scale;
  let vx = t.a[0][0] + t.a[1][0] * x + t.a[2][0] * y;
  let vy = t.a[0][1] + t.a[1][1] * x + t.a[2][1] * y;
  for (let i = 0; i < n; i++) {
    const u = tpsU((x - (t.centers[i]![0] - cx) / t.scale) ** 2 + (y - (t.centers[i]![1] - cy) / t.scale) ** 2);
    vx += t.w[i]![0] * u;
    vy += t.w[i]![1] * u;
  }
  return [vx, vy];
};

/**
 * A house surface off the main plane (a recessed door, a proud gable, a column), corrected on its own
 * from the reference points marked on it: its own homography with 4+ points, an affine adjustment of
 * the main mapping with 3, a shift with 1–2.
 */
export interface SurfaceMap {
  readonly id: string;
  /** Its outline in photo pixels. */
  readonly polygon: readonly Vec2[];
  readonly area: number;
  readonly kind: "homography" | "affine" | "shift";
  /** homography: undistorted camera → photo. */
  readonly H?: Mat3;
  /** affine / shift: [a, b, c, d, e, f] applied to the main mapping's photo point. */
  readonly A?: readonly number[];
  readonly points: number;
}

/** Camera pixel → house photo pixel. */
export interface CameraToPhoto {
  /** The camera's distortion; the maps work on undistorted camera pixels. */
  readonly lens: Lens | null;
  /** The house's main plane: the largest set of reference points one homography explains. */
  readonly H: Mat3;
  /** Residual correction on the main plane (photo distortion, slight bowing), with enough points on it. */
  readonly tps: Tps | null;
  readonly surfaces: readonly SurfaceMap[];
  readonly pairs: readonly ReferencePair[];
  /** Which pairs lie on the main plane. */
  readonly onMainPlane: readonly boolean[];
  /** Leave-one-out error of each reference point in photo pixels (null: too few points to tell). */
  readonly looError: readonly (number | null)[];
  readonly method: string;
}

/** Points on the main plane needed before its residual spline is used. */
export const SPLINE_MIN_POINTS = 6;

const applyAffine = (A: readonly number[], q: Vec2): Vec2 => [A[0]! * q[0] + A[1]! * q[1] + A[2]!, A[3]! * q[0] + A[4]! * q[1] + A[5]!];
const fitAffine = (src: readonly Vec2[], dst: readonly Vec2[]): number[] | null => {
  // Least squares for x' = a x + b y + c, y' = d x + e y + f.
  const AtA = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bx = [0, 0, 0];
  const by = [0, 0, 0];
  src.forEach((p, i) => {
    const r = [p[0], p[1], 1];
    for (let a = 0; a < 3; a++) {
      bx[a]! += r[a]! * dst[i]![0];
      by[a]! += r[a]! * dst[i]![1];
      for (let b = 0; b < 3; b++) AtA[a]![b]! += r[a]! * r[b]!;
    }
  });
  const x = solveLinear(AtA, bx);
  const y = solveLinear(AtA, by);
  return x && y ? [...x, ...y] : null;
};

interface FitInput {
  /** Camera positions already undistorted. */
  readonly pairs: readonly ReferencePair[];
  readonly surfaces: ReadonlyArray<{ id: string; polygon: readonly Vec2[] }>;
  readonly threshold: number;
  readonly smoothing: number;
  /** Areas smaller than this (photo px²) count as parts that may stand out from the main plane. */
  readonly mainAreaLimit: number;
}
type FittedModel = Omit<CameraToPhoto, "lens" | "pairs" | "looError">;

const mainMapOf = (H: Mat3, tps: Tps | null) => (c: Vec2): Vec2 => {
  const q = applyHomography(H, c);
  if (!tps) return q;
  const e = evalTps(tps, c);
  return [q[0] + e[0], q[1] + e[1]];
};

const fitModel = (f: FitInput): FittedModel | null => {
  const ps = f.pairs;
  if (ps.length < 4) return null;
  // The main plane: one robust homography over all points, where points on the wall count double
  // against points on smaller parts (doors, windows, gables, columns may stand out or sit back) —
  // so a recessed door plus part of the wall can't outvote the whole wall.
  const small = f.surfaces.filter((s) => s.polygon.length >= 3 && Math.abs(polygonArea(s.polygon)) < f.mainAreaLimit);
  const onPart = ps.map((p) => small.some((s) => pointInPolygon(p.photo, s.polygon)));
  // With enough points on the wall itself, the wall alone decides it.
  const wallIdx = ps.flatMap((_, i) => (onPart[i] ? [] : [i]));
  const cand = wallIdx.length >= 5 ? wallIdx : ps.map((_, i) => i);
  const r = ransacHomography(
    cand.map((i) => ps[i]!.camera),
    cand.map((i) => ps[i]!.photo),
    f.threshold,
    800,
    cand.map((i) => (onPart[i] ? 1 : 2)),
  );
  let onMain: boolean[] = ps.map(() => false);
  if (r && r.inliers.filter(Boolean).length >= 4) cand.forEach((i, k) => (onMain[i] = r.inliers[k]!));
  else cand.forEach((i) => (onMain[i] = true));
  // Points on smaller parts that agree with the main plane belong to it (most windows are nearly flush).
  if (r) {
    ps.forEach((p, i) => {
      if (onMain[i] || !onPart[i]) return;
      const q = applyHomography(r.H, p.camera);
      if (Math.hypot(q[0] - p.photo[0], q[1] - p.photo[1]) <= f.threshold) onMain[i] = true;
    });
  }
  const main = ps.filter((_, i) => onMain[i]);
  const H = solveHomography(
    main.map((p) => p.camera),
    main.map((p) => p.photo),
  );
  if (!H) return null;
  let tps: Tps | null = null;
  if (main.length >= SPLINE_MIN_POINTS) {
    tps = fitTps(
      main.map((p) => p.camera),
      main.map((p) => {
        const q = applyHomography(H, p.camera);
        return [p.photo[0] - q[0], p.photo[1] - q[1]] as Vec2;
      }),
      f.smoothing,
    );
  }
  const mainMap = mainMapOf(H, tps);
  // Surfaces with points of their own that the main plane doesn't explain.
  const surfaces: SurfaceMap[] = [];
  for (const s of f.surfaces) {
    if (s.polygon.length < 3) continue;
    const idx = ps.flatMap((p, i) => (pointInPolygon(p.photo, s.polygon) ? [i] : []));
    const mine = idx.map((i) => ps[i]!);
    if (!mine.length) continue;
    // Off the main plane: the main mapping misses its points by more than clicking accuracy.
    const off = idx.some((i) => {
      if (onMain[i]) return false;
      const q = mainMap(ps[i]!.camera);
      return Math.hypot(q[0] - ps[i]!.photo[0], q[1] - ps[i]!.photo[1]) > f.threshold;
    });
    if (!off) continue;
    const area = Math.abs(polygonArea(s.polygon));
    if (mine.length >= 4) {
      const Hs = solveHomography(
        mine.map((p) => p.camera),
        mine.map((p) => p.photo),
      );
      if (Hs) {
        surfaces.push({ id: s.id, polygon: s.polygon, area, kind: "homography", H: Hs, points: mine.length });
        continue;
      }
    }
    const src = mine.map((p) => mainMap(p.camera));
    if (mine.length === 3) {
      const A = fitAffine(
        src,
        mine.map((p) => p.photo),
      );
      if (A) {
        surfaces.push({ id: s.id, polygon: s.polygon, area, kind: "affine", A, points: 3 });
        continue;
      }
    }
    const dx = mine.reduce((t, p, i) => t + p.photo[0] - src[i]![0], 0) / mine.length;
    const dy = mine.reduce((t, p, i) => t + p.photo[1] - src[i]![1], 0) / mine.length;
    surfaces.push({ id: s.id, polygon: s.polygon, area, kind: "shift", A: [1, 0, dx, 0, 1, dy], points: mine.length });
  }
  // The most specific surface wins where outlines overlap (a door inside a wall).
  surfaces.sort((a, b) => a.area - b.area);
  onMain = onMain.map((v, i) => v && !surfaces.some((s) => pointInPolygon(ps[i]!.photo, s.polygon)));
  const parts = [
    `homography from ${main.length} points`,
    tps ? "residual spline" : "",
    surfaces.length ? `${surfaces.length} surface${surfaces.length === 1 ? "" : "s"} corrected on their own` : "",
  ].filter(Boolean);
  return { H, tps, surfaces, onMainPlane: onMain, method: parts.join(", ") };
};

/** Undistorted camera pixel → photo through a fitted model. */
const mapUndistorted = (g: Pick<CameraToPhoto, "H" | "tps" | "surfaces">, p: Vec2): Vec2 => {
  const q0 = mainMapOf(g.H, g.tps)(p);
  for (const s of g.surfaces) {
    const q = s.kind === "homography" ? applyHomography(s.H!, p) : applyAffine(s.A!, q0);
    if (pointInPolygon(q, s.polygon)) return q;
  }
  return q0;
};

/**
 * Fit camera → photo from reference points. `surfaces`: the house areas' outlines in photo pixels,
 * so points on recessed or proud parts correct those parts only.
 */
export const fitCameraToPhoto = (
  raw: readonly ReferencePair[],
  lens: Lens | null = null,
  surfaces: ReadonlyArray<{ id: string; polygon: readonly Vec2[] }> = [],
  o: { threshold?: number; smoothing?: number; photo?: { width: number; height: number } } = {},
): CameraToPhoto | null => {
  if (raw.length < 4) return null;
  const pairs = raw.map((p) => ({ camera: lens ? undistort(lens, p.camera) : p.camera, photo: p.photo }));
  // Clicking is good to a few pixels; parallax of a surface 10+ cm off the wall is usually more.
  const xs = raw.map((p) => p.photo[0]);
  const ys = raw.map((p) => p.photo[1]);
  const extent = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const photoArea = o.photo ? o.photo.width * o.photo.height : extent * extent;
  const input: FitInput = { pairs, surfaces, threshold: o.threshold ?? Math.max(3, 0.004 * extent), smoothing: o.smoothing ?? 0.02, mainAreaLimit: 0.2 * photoArea };
  const m = fitModel(input);
  if (!m) return null;
  // Leave-one-out needs a refit per point: for hand-marked points (few). Automatic matches (many) are
  // checked on held-out points instead.
  const looError = pairs.map((p, i) => {
    if (pairs.length < 5 || pairs.length > 40) return null;
    const mm = fitModel({ ...input, pairs: pairs.filter((_, j) => j !== i) });
    if (!mm) return null;
    const q = mapUndistorted(mm, p.camera);
    return Math.hypot(q[0] - p.photo[0], q[1] - p.photo[1]);
  });
  return { lens, ...m, pairs: raw, looError };
};

export const mapCameraToPhoto = (g: Pick<CameraToPhoto, "H" | "tps" | "lens" | "surfaces">, cam: Vec2): Vec2 => mapUndistorted(g, g.lens ? undistort(g.lens, cam) : cam);

/** Photo pixel → camera pixel (for drawing the house areas on the camera image). */
export const mapPhotoToCamera = (g: Pick<CameraToPhoto, "H" | "tps" | "lens" | "surfaces">, q: Vec2): Vec2 | null => {
  let u: Vec2 | null = null;
  const s = g.surfaces.find((x) => pointInPolygon(q, x.polygon));
  if (s?.kind === "homography") {
    const Hi = mat3Invert(s.H!);
    u = Hi ? applyHomography(Hi, q) : null;
  } else {
    let q0 = q;
    if (s) {
      // Undo the surface's adjustment, then the main mapping.
      const [a, b, c, d, e, f] = s.A! as number[];
      const det = a! * e! - b! * d!;
      if (Math.abs(det) > 1e-12) q0 = [(e! * (q[0] - c!) - b! * (q[1] - f!)) / det, (-d! * (q[0] - c!) + a! * (q[1] - f!)) / det];
    }
    u = invertMain(g, q0);
  }
  return u && g.lens ? distort(g.lens, u) : u;
};

/** The main mapping's inverse: the homography, then Newton steps through the residual spline. */
const invertMain = (g: Pick<CameraToPhoto, "H" | "tps">, q: Vec2): Vec2 | null => {
  const Hi = mat3Invert(g.H);
  if (!Hi) return null;
  let p = applyHomography(Hi, q);
  const fwd = mainMapOf(g.H, g.tps);
  for (let k = 0; k < 8 && g.tps; k++) {
    const f = fwd(p);
    const e: Vec2 = [q[0] - f[0], q[1] - f[1]];
    if (Math.hypot(e[0], e[1]) < 0.05) break;
    const d = 0.5;
    const fx = fwd([p[0] + d, p[1]]);
    const fy = fwd([p[0], p[1] + d]);
    const a = (fx[0] - f[0]) / d;
    const b = (fy[0] - f[0]) / d;
    const c = (fx[1] - f[1]) / d;
    const dd = (fy[1] - f[1]) / d;
    const det = a * dd - b * c;
    if (Math.abs(det) < 1e-12) break;
    p = [p[0] + (dd * e[0] - b * e[1]) / det, p[1] + (-c * e[0] + a * e[1]) / det];
  }
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : null;
};

/** Reference points too few or badly placed to fix the camera↔photo relation (e.g. all in a line). */
export const referenceProblems = (pairs: readonly ReferencePair[], photo: { width: number; height: number }): string[] => {
  const out: string[] = [];
  if (pairs.length < 4) out.push(`Mark at least 4 matching points (${pairs.length} so far).`);
  if (pairs.length >= 3) {
    // Spread: the area of the points' convex hull against the photo.
    const hull = convexHull(pairs.map((p) => p.photo));
    const area = Math.abs(polygonArea(hull));
    if (area < 0.08 * photo.width * photo.height) out.push("The points are bunched together or in a line — spread them out (corners of the house, far apart).");
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// Solving the projector's alignment

export interface AlignSolveOptions {
  /** Projector output size in pixels. */
  readonly output: { readonly width: number; readonly height: number };
  /** Venue canvas (photo) size. */
  readonly canvas: { readonly width: number; readonly height: number };
  /** Residual grid spacing in projector pixels. */
  readonly gridSpacing?: number;
}

export interface AlignSolution {
  /** The alignment to apply (corner points from the fitted homography; residual grid as `mesh`). */
  readonly calibration: Pick<Calibration, "mode" | "points" | "mesh">;
  /** Homography content(photo) px → projector px. */
  readonly H: Mat3;
  /** Projector-pixel error of the correspondences after the fit: median and 95th percentile. */
  readonly fit: { readonly median: number; readonly p95: number; readonly used: number; readonly inlierShare: number; readonly meshCoverage: number };
  /** Grid vertices with observations behind them (1) or filled in (0). */
  readonly observed: Uint8Array;
  /** Which surface a photo point is on (0: the main wall; k: calibration.mesh.surfaces[k − 1]). */
  readonly labelOf: (q: Vec2) => number;
}


/** A residual grid: offsets (photo px) at vertices over the projector's picture, optionally per surface. */
export interface MeshLike {
  readonly cols: number;
  readonly rows: number;
  readonly offsets: ArrayLike<number> | readonly Vec2[];
  /**
   * Surface label of each vertex: 0 = the main wall, k = surfaces[k − 1]. Where a grid cell spans a
   * depth edge, only vertices of the surface the point actually falls on are used, so a door's
   * correction stops at the door's outline instead of bleeding across it.
   */
  readonly labels?: ArrayLike<number>;
  /** With labels: the main wall's correction at every grid point (used where a pixel's own surface has none near). */
  readonly base?: ArrayLike<number> | readonly Vec2[];
}

/** Which surface a photo point is on: the smallest of the given outlines containing it (label k + 1), else 0. */
export const surfaceLabeler = (outlines: ReadonlyArray<readonly Vec2[]>): ((q: Vec2) => number) => {
  const order = outlines.map((p, i) => ({ p, i, a: Math.abs(polygonArea(p)) })).sort((a, b) => a.a - b.a);
  const boxes = order.map((o) => ({ ...o, x0: Math.min(...o.p.map((v) => v[0])), x1: Math.max(...o.p.map((v) => v[0])), y0: Math.min(...o.p.map((v) => v[1])), y1: Math.max(...o.p.map((v) => v[1])) }));
  return (q) => {
    for (const b of boxes) if (q[0] >= b.x0 && q[0] <= b.x1 && q[1] >= b.y0 && q[1] <= b.y1 && pointInPolygon(q, b.p)) return b.i + 1;
    return 0;
  };
};

/**
 * Fit the projector alignment from projector↔camera correspondences and the camera→photo map.
 * Returns null when there is too little to go on.
 */
export const solveAlignment = (corr: readonly Correspondence[], g: Pick<CameraToPhoto, "H" | "tps" | "lens" | "surfaces">, o: AlignSolveOptions): AlignSolution | null => {
  const { width: W, height: H0 } = o.output;
  // Surfaces corrected on their own get labels; each projector block is labelled by where it lands.
  const surfaces = g.surfaces.map((s) => ({ id: s.id, polygon: s.polygon }));
  const labelOf = surfaceLabeler(surfaces.map((s) => s.polygon));
  const pairs = corr
    .map((c) => {
      const q = mapCameraToPhoto(g, c.camera);
      return { p: c.projector, q, l: labelOf(q) };
    })
    .filter((x) => Number.isFinite(x.q[0]) && Number.isFinite(x.q[1]));
  if (pairs.length < 12) return null;
  // Homography photo → projector, robust to misreads; the threshold allows for depth off the main plane.
  const main = pairs.filter((x) => x.l === 0);
  const basis = main.length >= 12 ? main : pairs;
  const r = ransacHomography(
    basis.map((x) => x.q),
    basis.map((x) => x.p),
    Math.max(6, 0.02 * Math.max(W, H0)),
    400,
  );
  if (!r) return null;
  const Hp = r.H;
  const Hinv = mat3Invert(Hp);
  if (!Hinv) return null;
  const spacing = o.gridSpacing ?? 16;
  const cols = Math.ceil(W / spacing) + 1;
  const rows = Math.ceil(H0 / spacing) + 1;
  const sx = W / (cols - 1);
  const sy = H0 / (rows - 1);
  const sigma = Math.max(sx, sy) * 0.75;
  // Residuals in photo pixels at each observed block: what the homography alone gets wrong.
  const resid = pairs.map((x) => {
    const c = applyHomography(Hinv, x.p);
    return [x.q[0] - c[0], x.q[1] - c[1]] as Vec2;
  });
  // Drop misread blocks: far from the local consensus of the same surface.
  const keep = new Array<boolean>(pairs.length).fill(false);
  const nLabels = surfaces.length + 1;
  for (let l = 0; l < nLabels; l++) {
    const idx = pairs.flatMap((x, i) => (x.l === l ? [i] : []));
    if (!idx.length) continue;
    const k = robustNeighbourFilter(
      idx.map((i) => pairs[i]!.p),
      idx.map((i) => resid[i]!),
      Math.max(sx, sy) * 3,
    );
    idx.forEach((i, j) => (keep[i] = k[j]!));
  }
  // Spread residuals to nearby vertices, per surface: weight per (vertex, label).
  const acc = new Map<number, Float64Array>(); // key: vertex * 256 + label → [x, y, w]
  let used = 0;
  for (let k = 0; k < pairs.length; k++) {
    if (!keep[k]) continue;
    used++;
    const { p, l } = pairs[k]!;
    const gi = p[0] / sx, gj = p[1] / sy;
    for (let j = Math.max(0, Math.floor(gj - 2)); j <= Math.min(rows - 1, Math.ceil(gj + 2)); j++)
      for (let i = Math.max(0, Math.floor(gi - 2)); i <= Math.min(cols - 1, Math.ceil(gi + 2)); i++) {
        const d2 = (i * sx - p[0]) ** 2 + (j * sy - p[1]) ** 2;
        const wgt = Math.exp(-d2 / (2 * sigma * sigma));
        if (wgt < 1e-3) continue;
        const key = (j * cols + i) * 256 + l;
        let a = acc.get(key);
        if (!a) acc.set(key, (a = new Float64Array(3)));
        a[0]! += wgt * resid[k]![0];
        a[1]! += wgt * resid[k]![1];
        a[2]! += wgt;
      }
  }
  const off = new Float64Array(cols * rows * 2);
  const labels = new Uint8Array(cols * rows);
  const observed = new Uint8Array(cols * rows);
  const best = new Float64Array(cols * rows);
  for (const [key, a] of acc) {
    const v = Math.floor(key / 256), l = key % 256;
    // The vertex belongs to the surface with the most support around it.
    if (a[2]! > 0.05 && a[2]! > best[v]!) {
      best[v] = a[2]!;
      labels[v] = l;
      off[v * 2] = a[0]! / a[2]!;
      off[v * 2 + 1] = a[1]! / a[2]!;
      observed[v] = 1;
    }
  }
  // Unobserved vertices: the surface their point of the photo is on; offsets filled from neighbours of
  // the same surface (and towards no correction far from any data).
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const v = j * cols + i;
      if (!observed[v]) labels[v] = labelOf(applyHomography(Hinv, [i * sx, j * sy]));
    }
  for (let it = 0; it < 300; it++)
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const v = j * cols + i;
        if (observed[v]) continue;
        let x = 0, y = 0, c = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= cols || b >= rows) continue;
          const u = b * cols + a;
          if (labels[u] !== labels[v]) continue;
          x += off[u * 2]!;
          y += off[u * 2 + 1]!;
          c++;
        }
        if (!c) continue;
        off[v * 2] = (0.98 * x) / c;
        off[v * 2 + 1] = (0.98 * y) / c;
      }
  // The main wall's layer: from main-wall blocks only, filled everywhere.
  const baseOff = new Float64Array(cols * rows * 2);
  const baseSeen = new Uint8Array(cols * rows);
  for (const [key, a] of acc) {
    if (key % 256 !== 0 || a[2]! <= 0.05) continue;
    const v = Math.floor(key / 256);
    baseOff[v * 2] = a[0]! / a[2]!;
    baseOff[v * 2 + 1] = a[1]! / a[2]!;
    baseSeen[v] = 1;
  }
  if (surfaces.length)
    for (let it = 0; it < 300; it++)
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const v = j * cols + i;
          if (baseSeen[v]) continue;
          let x = 0, y = 0, c = 0;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const a = i + di, b = j + dj;
            if (a < 0 || b < 0 || a >= cols || b >= rows) continue;
            x += baseOff[(b * cols + a) * 2]!;
            y += baseOff[(b * cols + a) * 2 + 1]!;
            c++;
          }
          baseOff[v * 2] = (0.98 * x) / c;
          baseOff[v * 2 + 1] = (0.98 * y) / c;
        }
  const mesh: MeshLike = { cols, rows, offsets: off, labels, ...(surfaces.length ? { base: baseOff } : {}) };
  // Fit quality: how far each correspondence lands from where the final mapping puts it, in projector px.
  const scale = projectorPxPerPhotoPx(Hp, o.canvas);
  const errs: number[] = [];
  for (let k = 0; k < pairs.length; k++) {
    if (!keep[k]) continue;
    const q = mapOutputToContent(Hinv, mesh, W, H0, pairs[k]!.p, labelOf);
    errs.push(Math.hypot(q[0] - pairs[k]!.q[0], q[1] - pairs[k]!.q[1]) * scale);
  }
  const corners: Vec2[] = [
    [0, 0],
    [o.canvas.width, 0],
    [o.canvas.width, o.canvas.height],
    [0, o.canvas.height],
  ];
  const points: CalibrationPoint[] = corners.map((c, i) => {
    const out = applyHomography(Hp, c);
    return { id: `c${i + 1}`, label: String(i + 1), content: c, output: [round2(out[0]), round2(out[1])] };
  });
  const offsets: Vec2[] = [];
  for (let v = 0; v < cols * rows; v++) offsets.push([round2(off[v * 2]!), round2(off[v * 2 + 1]!)]);
  return {
    calibration: {
      mode: "mesh",
      points,
      mesh: {
        cols,
        rows,
        offsets,
        ...(surfaces.length
          ? { labels: Array.from(labels), surfaces: surfaces.map((s) => s.id), base: Array.from({ length: cols * rows }, (_, v) => [round2(baseOff[v * 2]!), round2(baseOff[v * 2 + 1]!)] as Vec2) }
          : {}),
      },
    },
    H: Hp,
    fit: { median: percentile(errs, 0.5), p95: percentile(errs, 0.95), used, inlierShare: r.inliers.filter(Boolean).length / basis.length, meshCoverage: observed.reduce((s, v) => s + v, 0) / observed.length },
    observed,
    labelOf,
  };
};

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Average projector pixels per photo pixel near the middle of the photo (to state errors in projector pixels). */
export const projectorPxPerPhotoPx = (Hp: Mat3, canvas: { width: number; height: number }): number => {
  const c: Vec2 = [canvas.width / 2, canvas.height / 2];
  const a = applyHomography(Hp, c);
  const b = applyHomography(Hp, [c[0] + 10, c[1]]);
  const d = applyHomography(Hp, [c[0], c[1] + 10]);
  return (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(d[0] - a[0], d[1] - a[1])) / 20;
};

const offsetOf = (mesh: MeshLike, v: number, k: 0 | 1): number => {
  const o = mesh.offsets as ArrayLike<number> & readonly Vec2[];
  return typeof o[0] === "number" ? (o as ArrayLike<number>)[v * 2 + k]! : (o as readonly Vec2[])[v]![k];
};

/**
 * Residual at a projector pixel, as the output shader computes it: bilinear between the four grid
 * points around it — but with surface labels, only the points whose surface is the one the pixel's
 * photo point falls on (else the nearest point).
 */
export const meshOffsetAt = (mesh: MeshLike, W: number, H: number, p: Vec2, base?: Vec2, labelOf?: (q: Vec2) => number): Vec2 => {
  const fx = Math.min(Math.max((p[0] / W) * (mesh.cols - 1), 0), mesh.cols - 1);
  const fy = Math.min(Math.max((p[1] / H) * (mesh.rows - 1), 0), mesh.rows - 1);
  const i0 = Math.min(Math.floor(fx), mesh.cols - 2), j0 = Math.min(Math.floor(fy), mesh.rows - 2);
  const tx = fx - i0, ty = fy - j0;
  const corners = [
    [i0, j0, (1 - tx) * (1 - ty)],
    [i0 + 1, j0, tx * (1 - ty)],
    [i0, j0 + 1, (1 - tx) * ty],
    [i0 + 1, j0 + 1, tx * ty],
  ] as const;
  let x = 0, y = 0, w = 0, nx = 0, ny = 0, nw = -1;
  for (const [i, j, wt] of corners) {
    const v = j * mesh.cols + i;
    const ox = offsetOf(mesh, v, 0), oy = offsetOf(mesh, v, 1);
    if (wt > nw) {
      nw = wt;
      nx = ox;
      ny = oy;
    }
    if (mesh.labels && labelOf && base && labelOf([base[0] + ox, base[1] + oy]) !== mesh.labels[v]) continue;
    x += wt * ox;
    y += wt * oy;
    w += wt;
  }
  if (w > 1e-9) return [x / w, y / w];
  // None of the four is on this pixel's surface: the main wall's layer, where the pixel is on the wall.
  if (mesh.base && labelOf && base) {
    const b = { offsets: mesh.base } as MeshLike;
    for (const [i, j, wt] of corners) {
      const v = j * mesh.cols + i;
      const ox = offsetOf(b, v, 0), oy = offsetOf(b, v, 1);
      if (labelOf([base[0] + ox, base[1] + oy]) !== 0) continue;
      x += wt * ox;
      y += wt * oy;
      w += wt;
    }
    if (w > 1e-9) return [x / w, y / w];
  }
  return [nx, ny];
};

/** Projector pixel → content (photo) pixel through a calibration's homography and residual grid. */
export const mapOutputToContent = (Hinv: Mat3, mesh: MeshLike | undefined, W: number, H: number, p: Vec2, labelOf?: (q: Vec2) => number): Vec2 => {
  const c = applyHomography(Hinv, p);
  if (!mesh || mesh.cols < 2 || mesh.rows < 2) return c;
  const o = meshOffsetAt(mesh, W, H, p, c, labelOf);
  return [c[0] + o[0], c[1] + o[1]];
};

/**
 * Content (photo) pixel → projector pixel: invert the mapping above by fixed-point steps (and, near a
 * depth edge where those can cycle, a small search for the closest pixel).
 */
export const mapContentToOutput = (Hp: Mat3, mesh: MeshLike | undefined, W: number, H: number, q: Vec2, labelOf?: (q: Vec2) => number): Vec2 => {
  let p = applyHomography(Hp, q);
  if (!mesh || mesh.cols < 2) return p;
  const Hinv = mat3Invert(Hp);
  if (!Hinv) return p;
  for (let k = 0; k < 12; k++) {
    const c = mapOutputToContent(Hinv, mesh, W, H, p, labelOf);
    const e: Vec2 = [q[0] - c[0], q[1] - c[1]];
    if (Math.hypot(e[0], e[1]) < 0.02) return p;
    // Step in projector space by the local homography's Jacobian applied to the photo-space error.
    const a = applyHomography(Hp, c);
    const b = applyHomography(Hp, [c[0] + e[0], c[1] + e[1]]);
    p = [p[0] + (b[0] - a[0]), p[1] + (b[1] - a[1])];
  }
  return p;
};

/**
 * Keep points whose residual agrees with their neighbours' (within a robust spread of the local
 * median), so a few misread blocks don't bend the grid.
 */
const robustNeighbourFilter = (pts: readonly Vec2[], res: readonly Vec2[], radius: number): boolean[] => {
  const cell = radius;
  const grid = new Map<string, number[]>();
  pts.forEach((p, i) => {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  return pts.map((p, i) => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    const near: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) if (Math.hypot(pts[j]![0] - p[0], pts[j]![1] - p[1]) <= radius) near.push(j);
    if (near.length < 5) return true;
    const mx = percentile(near.map((j) => res[j]![0]), 0.5);
    const my = percentile(near.map((j) => res[j]![1]), 0.5);
    const dev = near.map((j) => Math.hypot(res[j]![0] - mx, res[j]![1] - my));
    const mad = percentile(dev, 0.5);
    return Math.hypot(res[i]![0] - mx, res[i]![1] - my) <= Math.max(3, 4 * mad);
  });
};

// ---------------------------------------------------------------------------------------------
// Per-area report

export interface AreaReport {
  readonly id: string;
  readonly name: string;
  /** Share of the area the camera saw lit by this projector (0–1). */
  readonly observed: number;
  /** Share of the area inside the projector's picture at all. */
  readonly inPicture: number;
  /** Estimated error in projector pixels (from the reference points near it), or null when unknown. */
  readonly errorPx: number | null;
  readonly status: "good" | "check" | "not-covered";
  readonly note: string;
}

const pointInPolygon = (p: Vec2, poly: readonly Vec2[]): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};
const polygonArea = (poly: readonly Vec2[]): number => {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j]![0] + poly[i]![0]) * (poly[j]![1] - poly[i]![1]);
  return s / 2;
};
const convexHull = (pts: readonly Vec2[]): Vec2[] => {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
};

/**
 * How well each house area is covered and aligned. `polygons`: each area's outline in photo pixels.
 * `observedAt(projectorPx)`: whether the camera saw that projector pixel lit.
 */
export const areaReports = (
  areas: ReadonlyArray<{ id: string; name: string; polygon: readonly Vec2[] }>,
  sol: AlignSolution,
  g: CameraToPhoto,
  o: AlignSolveOptions,
  /** Errors measured otherwise (e.g. on held-out automatic matches), projector px, by area id. */
  measured?: Readonly<Record<string, number | null>>,
): AreaReport[] => {
  const W = o.output.width, H = o.output.height;
  const mesh = sol.calibration.mesh!;
  const scale = projectorPxPerPhotoPx(sol.H, o.canvas);
  const observedAt = (p: Vec2) => {
    const i = Math.round((p[0] / W) * (mesh.cols - 1)), j = Math.round((p[1] / H) * (mesh.rows - 1));
    return i >= 0 && j >= 0 && i < mesh.cols && j < mesh.rows && sol.observed[j * mesh.cols + i] === 1;
  };
  return areas.map((a) => {
    const xs = a.polygon.map((p) => p[0]), ys = a.polygon.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    let n = 0, seen = 0, inPic = 0;
    for (let j = 0; j < 12; j++)
      for (let i = 0; i < 12; i++) {
        const q: Vec2 = [x0 + ((i + 0.5) / 12) * (x1 - x0), y0 + ((j + 0.5) / 12) * (y1 - y0)];
        if (!pointInPolygon(q, a.polygon)) continue;
        n++;
        const p = mapContentToOutput(sol.H, mesh, W, H, q, sol.labelOf);
        if (p[0] >= 0 && p[1] >= 0 && p[0] <= W && p[1] <= H) {
          inPic++;
          if (observedAt(p)) seen++;
        }
      }
    const observed = n ? seen / n : 0;
    const inPicture = n ? inPic / n : 0;
    // Error near the area: the reference points' leave-one-out errors, weighted by distance.
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let we = 0, wsum = 0;
    g.pairs.forEach((p, i) => {
      const e = g.looError[i];
      if (e == null) return;
      const d = Math.hypot(p.photo[0] - cx, p.photo[1] - cy);
      const wgt = 1 / (1 + (d / Math.max(50, Math.hypot(x1 - x0, y1 - y0))) ** 2);
      we += wgt * e;
      wsum += wgt;
    });
    const errorPx = measured && measured[a.id] != null ? measured[a.id]! : wsum > 0 ? (we / wsum) * scale : null;
    let status: AreaReport["status"] = "good";
    let note = "Aligned.";
    if (inPicture < 0.5) {
      status = "not-covered";
      note = "Mostly outside this projector's picture.";
    } else if (observed < 0.6) {
      status = "check";
      note = "The camera couldn't see much of it lit (hidden, too dark or too far to the side) — check it by eye.";
    } else if (errorPx === null) {
      status = "check";
      note = "No reference points to estimate the error — check it by eye, or add points.";
    } else if (errorPx > 6) {
      status = "check";
      note = `Estimated ${errorPx.toFixed(0)} projector pixels off — add a reference point on it or nudge it.`;
    }
    return { id: a.id, name: a.name, observed, inPicture, errorPx, status, note };
  });
};

/**
 * A projector's alignment as functions (what the output shader does, on the CPU): photo → projector
 * pixels and back, with the residual grid and its surface labels. `regions`: the venue's house areas.
 */
export const calibrationMapping = (
  projector: { readonly output: { readonly width: number; readonly height: number }; readonly calibration: Calibration },
  regions: Readonly<Record<string, { readonly path: PathData }>> = {},
): { toOutput: (q: Vec2) => Vec2; toContent: (p: Vec2) => Vec2; labelOf: (q: Vec2) => number } | null => {
  const cal = projector.calibration;
  const H = solveHomography(
    cal.points.map((x) => x.content),
    cal.points.map((x) => x.output),
  );
  const Hinv = H && mat3Invert(H);
  if (!H || !Hinv) return null;
  const mesh = cal.mode === "mesh" ? cal.mesh : undefined;
  const labelOf = mesh?.surfaces?.length && mesh.labels ? surfaceLabeler(mesh.surfaces.map((id) => (regions[id] ? flattenPath(regions[id]!.path, 8) : []))) : undefined;
  const W = projector.output.width, Ht = projector.output.height;
  return {
    toOutput: (q) => mapContentToOutput(H, mesh, W, Ht, q, labelOf),
    toContent: (p) => mapOutputToContent(Hinv, mesh, W, Ht, p, labelOf),
    labelOf: labelOf ?? (() => 0),
  };
};

/**
 * Move one house area's projection by `delta` projector pixels — the per-area touch-up, and how a
 * measured residual is corrected. Only that area moves: it becomes a surface of its own in the
 * residual grid (labelled), so neighbouring areas and the wall around it keep their alignment.
 * Returns the new calibration fields (mode "mesh", points unchanged, mesh with labels).
 */
export const shiftAreaCalibration = (
  projector: { readonly output: { readonly width: number; readonly height: number }; readonly calibration: Calibration },
  regions: Readonly<Record<string, { readonly path: PathData }>>,
  areaId: string,
  delta: Vec2,
  gridSpacing = 16,
): Pick<Calibration, "mode" | "points" | "mesh"> | null => {
  const region = regions[areaId];
  if (!region) return null;
  const poly = flattenPath(region.path, 8);
  if (poly.length < 3) return null;
  const cal = projector.calibration;
  const map = calibrationMapping(projector, regions);
  const H = solveHomography(
    cal.points.map((x) => x.content),
    cal.points.map((x) => x.output),
  );
  const Hinv = H && mat3Invert(H);
  if (!map || !Hinv) return null;
  const W = projector.output.width, Ht = projector.output.height;
  // The grid (made, all zero, if this alignment had none).
  const old = cal.mode === "mesh" && cal.mesh && cal.mesh.offsets.length === cal.mesh.cols * cal.mesh.rows ? cal.mesh : null;
  const cols = old?.cols ?? Math.ceil(W / gridSpacing) + 1;
  const rows = old?.rows ?? Math.ceil(Ht / gridSpacing) + 1;
  const offsets: Vec2[] = old ? old.offsets.map((o) => [o[0], o[1]]) : Array.from({ length: cols * rows }, () => [0, 0]);
  const labels: number[] = old?.labels && old.labels.length === cols * rows ? [...old.labels] : new Array(cols * rows).fill(0);
  const surfaces: string[] = [...(old?.surfaces ?? [])];
  // The main wall's layer: kept, or (first time) the grid as it is where it was main wall.
  const baseLayer: Vec2[] = old?.base && old.base.length === cols * rows ? old.base.map((o) => [o[0], o[1]]) : offsets.map((o) => [o[0], o[1]]);
  let label = surfaces.indexOf(areaId) + 1;
  if (!label) {
    surfaces.push(areaId);
    label = surfaces.length;
    if (label > 255) return null;
  }
  // Grid points whose (shifted) photo point is in the area, or within a cell and a half of its edge
  // (so pixels just inside the edge have grid points of their own surface).
  const sx = W / (cols - 1), sy = Ht / (rows - 1);
  const scale = projectorPxPerPhotoPx(H, { width: 2 * Math.max(...poly.map((p) => p[0])), height: 2 * Math.max(...poly.map((p) => p[1])) });
  const margin = (1.5 * Math.max(sx, sy)) / Math.max(1e-6, scale);
  const near = (q: Vec2) => {
    if (pointInPolygon(q, poly)) return true;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j]!, b = poly[i]!;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy) < margin) return true;
    }
    return false;
  };
  let changed = 0;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const v = j * cols + i;
      const p: Vec2 = [i * sx, j * sy];
      // Where this grid point should now take its picture from: where the point delta before it did.
      const from = map.toContent([p[0] - delta[0], p[1] - delta[1]]);
      if (labels[v] !== label && !near(from)) continue;
      const base = applyHomography(Hinv, p);
      offsets[v] = [round2(from[0] - base[0]), round2(from[1] - base[1])];
      labels[v] = label;
      changed++;
    }
  if (!changed) return null;
  return { mode: "mesh", points: cal.points, mesh: { cols, rows, offsets, labels, surfaces, base: baseLayer } };
};

/**
 * Animatable properties and keyframe evaluation.
 *
 * Interpolation follows the After Effects model so users and imported data behave as expected:
 *   - temporal interpolation per keyframe side: linear | bezier | hold
 *   - bezier temporal ease is expressed as { speed (units/second), influence (0..1) } per side;
 *     scalar/multi-dimensional properties ease each dimension independently,
 *   - spatial properties (positions) move along a Bezier motion path defined by per-keyframe
 *     tangents, and the temporal ease controls *speed along the path* (arc-length parameterised).
 * Everything is a pure function of (property, time), so any frame can be evaluated in any order.
 */
import { type Flicks, FLICKS_PER_SECOND } from "./time.ts";

export type PropValue = number | readonly number[];
export type Interp = "linear" | "bezier" | "hold";

export interface Ease {
  /** Property units per second at the keyframe. */
  readonly speed: number;
  /** 0..1 — how far the handle reaches toward the neighbouring keyframe (AE shows this as %). */
  readonly influence: number;
}

export interface Keyframe<V extends PropValue = PropValue> {
  readonly id: string;
  readonly t: Flicks;
  readonly v: V;
  /** Interpolation used when arriving at this keyframe. */
  readonly in: Interp;
  /** Interpolation used when leaving this keyframe. */
  readonly out: Interp;
  /** Temporal ease per dimension (one entry for spatial properties). Omitted = linear-equivalent. */
  readonly easeIn?: readonly Ease[];
  readonly easeOut?: readonly Ease[];
  /** Spatial tangents (relative to v) for motion paths; only used when the property is spatial. */
  readonly tanIn?: readonly number[];
  readonly tanOut?: readonly number[];
  /** Roving keyframes have their time solved for constant speed (resolved by the editor). */
  readonly roving?: boolean;
}

export interface Expression {
  readonly src: string;
  readonly enabled: boolean;
}

export interface AnimProp<V extends PropValue = PropValue> {
  /** Static value, used when there are no keyframes. */
  readonly value: V;
  /** Sorted by time; at least two keyframes are needed for animation. */
  readonly keyframes?: readonly Keyframe<V>[];
  readonly expression?: Expression;
  /** Position-like property: interpolates along a spatial Bezier motion path. */
  readonly spatial?: boolean;
}

export const staticProp = <V extends PropValue>(value: V, spatial = false): AnimProp<V> =>
  spatial ? { value, spatial } : { value };

export const isAnimated = (p: AnimProp): boolean => (p.keyframes?.length ?? 0) > 0;

const dims = (v: PropValue): number => (typeof v === "number" ? 1 : v.length);
const comp = (v: PropValue, i: number): number => (typeof v === "number" ? v : (v[i] ?? 0));
const pack = <V extends PropValue>(like: V, values: number[]): V =>
  (typeof like === "number" ? values[0]! : values) as unknown as V;

/** Easy Ease: zero speed, one-third influence (the AE default). */
export const EASY_EASE: Ease = { speed: 0, influence: 1 / 3 };

// ---------------------------------------------------------------------------------------------
// Cubic Bezier helpers (unit-x curve, used for temporal easing)

const bez = (a: number, b: number, c: number, d: number, s: number): number => {
  const u = 1 - s;
  return u * u * u * a + 3 * u * u * s * b + 3 * u * s * s * c + s * s * s * d;
};
const bezDeriv = (a: number, b: number, c: number, d: number, s: number): number => {
  const u = 1 - s;
  return 3 * u * u * (b - a) + 6 * u * s * (c - b) + 3 * s * s * (d - c);
};

/** Solve x(s) = x for s in [0,1] on a monotonic cubic with x0=0, x3=1. */
const solveUnitX = (x1: number, x2: number, x: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let s = x;
  for (let i = 0; i < 8; i++) {
    const err = bez(0, x1, x2, 1, s) - x;
    if (Math.abs(err) < 1e-9) return s;
    const d = bezDeriv(0, x1, x2, 1, s);
    if (Math.abs(d) < 1e-9) break;
    s -= err / d;
    if (s < 0 || s > 1) break;
  }
  // Bisection fallback — always converges because x(s) is monotonic for influences in [0,1].
  let lo = 0;
  let hi = 1;
  s = x;
  for (let i = 0; i < 60; i++) {
    const v = bez(0, x1, x2, 1, s);
    if (Math.abs(v - x) < 1e-10) break;
    if (v < x) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return s;
};

/**
 * Evaluate one temporal segment for one scalar channel.
 * dtSec is the segment length in seconds and u is the normalised time in [0,1].
 */
const evalTemporal = (
  v0: number,
  v1: number,
  dtSec: number,
  u: number,
  outInterp: Interp,
  inInterp: Interp,
  easeOut: Ease | undefined,
  easeIn: Ease | undefined,
): number => {
  if (outInterp === "hold") return v0;
  if (outInterp === "linear" && inInterp === "linear") return v0 + (v1 - v0) * u;
  const slope = dtSec > 0 ? (v1 - v0) / dtSec : 0;
  // A linear side behaves like a handle pointing straight at the other keyframe.
  const eo = outInterp === "linear" || !easeOut ? { speed: slope, influence: 1 / 3 } : easeOut;
  const ei = inInterp === "linear" || !easeIn ? { speed: slope, influence: 1 / 3 } : easeIn;
  const io = clamp(eo.influence, 0.001, 1);
  const ii = clamp(ei.influence, 0.001, 1);
  const x1 = io;
  const x2 = 1 - ii;
  const y1 = v0 + eo.speed * io * dtSec;
  const y2 = v1 - ei.speed * ii * dtSec;
  const s = solveUnitX(x1, x2, u);
  return bez(v0, y1, y2, v1, s);
};

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

// ---------------------------------------------------------------------------------------------
// Spatial motion paths

interface SpatialSegment {
  readonly p0: readonly number[];
  readonly c0: readonly number[];
  readonly c1: readonly number[];
  readonly p1: readonly number[];
  readonly lut: Float64Array; // cumulative arc length at uniform parameter steps
}

const SPATIAL_STEPS = 64;
const spatialCache = new WeakMap<object, SpatialSegment>();

const toArr = (v: PropValue): number[] => (typeof v === "number" ? [v] : [...v]);

const spatialSegment = (k0: Keyframe, k1: Keyframe): SpatialSegment => {
  const cached = spatialCache.get(k0);
  if (cached && cached.p1 === k1.v) return cached;
  const p0 = toArr(k0.v);
  const p1 = toArr(k1.v);
  const n = Math.max(p0.length, p1.length);
  const c0 = Array.from({ length: n }, (_, i) => (p0[i] ?? 0) + (k0.tanOut?.[i] ?? 0));
  const c1 = Array.from({ length: n }, (_, i) => (p1[i] ?? 0) + (k1.tanIn?.[i] ?? 0));
  const lut = new Float64Array(SPATIAL_STEPS + 1);
  let prev = p0;
  for (let s = 1; s <= SPATIAL_STEPS; s++) {
    const q = s / SPATIAL_STEPS;
    const pt = Array.from({ length: n }, (_, i) => bez(p0[i] ?? 0, c0[i]!, c1[i]!, p1[i] ?? 0, q));
    let d2 = 0;
    for (let i = 0; i < n; i++) d2 += (pt[i]! - (prev[i] ?? 0)) ** 2;
    lut[s] = lut[s - 1]! + Math.sqrt(d2);
    prev = pt;
  }
  const seg = { p0, c0, c1, p1: k1.v as unknown as number[], lut } as SpatialSegment;
  spatialCache.set(k0, seg);
  return seg;
};

const pointAtLength = (seg: SpatialSegment, len: number, p1: readonly number[]): number[] => {
  const { lut, p0, c0, c1 } = seg;
  const total = lut[SPATIAL_STEPS]!;
  if (total <= 0) return [...p0];
  const target = clamp(len, 0, total);
  let lo = 0;
  let hi = SPATIAL_STEPS;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lut[mid]! < target) lo = mid;
    else hi = mid;
  }
  const segLen = lut[hi]! - lut[lo]!;
  const f = segLen > 0 ? (target - lut[lo]!) / segLen : 0;
  const q = (lo + f) / SPATIAL_STEPS;
  return p0.map((_, i) => bez(p0[i]!, c0[i]!, c1[i]!, p1[i] ?? 0, q));
};

const hasTangents = (k0: Keyframe, k1: Keyframe): boolean =>
  !!(k0.tanOut?.some((x) => x !== 0) || k1.tanIn?.some((x) => x !== 0));

// ---------------------------------------------------------------------------------------------

/** Index of the last keyframe with t <= time, or -1. Binary search. */
export const keyframeIndexAt = (kfs: readonly Keyframe[], t: Flicks): number => {
  let lo = 0;
  let hi = kfs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid]!.t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
};

/** Evaluate the keyframed (pre-expression) value of a property at time t. */
export const evalKeyframes = <V extends PropValue>(p: AnimProp<V>, t: Flicks): V => {
  const kfs = p.keyframes;
  if (!kfs || kfs.length === 0) return p.value;
  if (kfs.length === 1 || t <= kfs[0]!.t) return kfs[0]!.v;
  const last = kfs[kfs.length - 1]!;
  if (t >= last.t) return last.v;
  const i = keyframeIndexAt(kfs, t);
  const k0 = kfs[i]!;
  const k1 = kfs[i + 1]!;
  const dt = k1.t - k0.t;
  if (dt <= 0) return k1.v;
  const u = (t - k0.t) / dt;
  const dtSec = dt / FLICKS_PER_SECOND;

  if (k0.out === "hold") return k0.v;

  if (p.spatial && dims(k0.v) > 1 && hasTangents(k0, k1)) {
    const seg = spatialSegment(k0, k1);
    const total = seg.lut[SPATIAL_STEPS]!;
    const len = evalTemporal(0, total, dtSec, u, k0.out, k1.in, k0.easeOut?.[0], k1.easeIn?.[0]);
    return pack(k0.v, pointAtLength(seg, len, toArr(k1.v)));
  }

  if (p.spatial && dims(k0.v) > 1) {
    // Straight-line spatial path: ease the distance travelled (one ease for the whole vector).
    const a = toArr(k0.v);
    const b = toArr(k1.v);
    const total = Math.hypot(...a.map((x, i) => (b[i] ?? 0) - x));
    if (total <= 0) return k0.v;
    const len = evalTemporal(0, total, dtSec, u, k0.out, k1.in, k0.easeOut?.[0], k1.easeIn?.[0]);
    const f = len / total;
    return pack(
      k0.v,
      a.map((x, i) => x + ((b[i] ?? 0) - x) * f),
    );
  }

  const n = dims(k0.v);
  const out: number[] = new Array(n);
  for (let d = 0; d < n; d++) {
    out[d] = evalTemporal(
      comp(k0.v, d),
      comp(k1.v, d),
      dtSec,
      u,
      k0.out,
      k1.in,
      k0.easeOut?.[d] ?? k0.easeOut?.[0],
      k1.easeIn?.[d] ?? k1.easeIn?.[0],
    );
  }
  return pack(k0.v, out);
};

/** Hook for the expression engine. The default evaluator ignores expressions. */
export interface PropertyEvalContext {
  evalExpression?: (prop: AnimProp, keyframedValue: PropValue, t: Flicks) => PropValue;
}

/** Final value: keyframes, then the expression (when enabled and an evaluator is installed). */
export const evalProp = <V extends PropValue>(p: AnimProp<V>, t: Flicks, ctx?: PropertyEvalContext): V => {
  const v = evalKeyframes(p, t);
  if (p.expression?.enabled && ctx?.evalExpression) return ctx.evalExpression(p, v, t) as V;
  return v;
};

/** Numeric velocity (units/second) by central difference; used by the speed graph and motion blur. */
export const velocityAt = (p: AnimProp, t: Flicks, ctx?: PropertyEvalContext): number[] => {
  const h = FLICKS_PER_SECOND / 1000;
  const a = evalProp(p, t - h, ctx);
  const b = evalProp(p, t + h, ctx);
  const n = dims(a);
  return Array.from({ length: n }, (_, i) => (comp(b, i) - comp(a, i)) / (2 / 1000));
};

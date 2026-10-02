/** Path measurement helpers shared by recipes, snapping and the engine's CPU-side geometry. */
import type { PathData, Vec2 } from "./model.ts";

/** Flatten a Bezier path into a polyline (tolerance in path units). */
export const flattenPath = (path: PathData, segmentsPerCurve = 16): Vec2[] => {
  const vs = path.vertices;
  const n = vs.length;
  if (n === 0) return [];
  const out: Vec2[] = [vs[0]!.p];
  const count = path.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % n]!;
    const c0: Vec2 = [a.p[0] + (a.out?.[0] ?? 0), a.p[1] + (a.out?.[1] ?? 0)];
    const c1: Vec2 = [b.p[0] + (b.in?.[0] ?? 0), b.p[1] + (b.in?.[1] ?? 0)];
    const straight = !a.out?.[0] && !a.out?.[1] && !b.in?.[0] && !b.in?.[1];
    if (straight) {
      out.push(b.p);
      continue;
    }
    for (let s = 1; s <= segmentsPerCurve; s++) {
      const t = s / segmentsPerCurve;
      const u = 1 - t;
      out.push([
        u * u * u * a.p[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * b.p[0],
        u * u * u * a.p[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * b.p[1],
      ]);
    }
  }
  return out;
};

export const polylineLength = (pts: readonly Vec2[], closed = false): number => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  if (closed && pts.length > 2) len += Math.hypot(pts[0]![0] - pts.at(-1)![0], pts[0]![1] - pts.at(-1)![1]);
  return len;
};

export const pathLength = (path: PathData): number => polylineLength(flattenPath(path), path.closed);

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const pathBounds = (paths: readonly PathData[]): Bounds => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of paths)
    for (const q of flattenPath(p)) {
      x0 = Math.min(x0, q[0]);
      y0 = Math.min(y0, q[1]);
      x1 = Math.max(x1, q[0]);
      y1 = Math.max(y1, q[1]);
    }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

export const pathCentroid = (path: PathData): Vec2 => {
  const b = pathBounds([path]);
  return [b.x + b.w / 2, b.y + b.h / 2];
};

/** Point-in-polygon (even-odd) on the flattened path; used for click-to-select regions. */
export const pathContains = (path: PathData, p: Vec2): boolean => {
  const pts = flattenPath(path);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};

/** Distance from a point to the path's outline; used for selecting open edges like rooflines. */
export const distanceToPath = (path: PathData, p: Vec2): number => {
  const pts = flattenPath(path);
  if (path.closed && pts.length > 2) pts.push(pts[0]!);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
};

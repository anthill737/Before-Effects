/** Shape operations on area outlines: splitting one in two, and the hull of several. */
import type { Vec2 } from "./model.ts";

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Keep the part of a polygon on one side of a vertical (axis 0) or horizontal (axis 1) line. */
const clipHalf = (pts: readonly Vec2[], axis: 0 | 1, at: number, keepBelow: boolean): Vec2[] => {
  const inside = (p: Vec2) => (keepBelow ? p[axis] <= at : p[axis] >= at);
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) out.push(lerp(a, b, (at - a[axis]) / (b[axis] - a[axis])));
  }
  return out;
};

/** A quad's corners as top-left, top-right, bottom-right, bottom-left (null if they aren't four distinct corners). */
const quadCorners = (q: readonly Vec2[]): Vec2[] | null => {
  const pick = (f: (p: Vec2) => number) => q.reduce((best, p) => (f(p) > f(best) ? p : best), q[0]!);
  const c = [pick((p) => -(p[0] + p[1])), pick((p) => p[0] - p[1]), pick((p) => p[0] + p[1]), pick((p) => p[1] - p[0])];
  return new Set(c).size === 4 ? c : null;
};

/**
 * Split an outline in two: "side" gives left and right parts, "stacked" top and bottom, divided at
 * `at` (0..1) of the way across. A four-cornered outline is split along its own sides (so a window
 * seen in perspective splits into two panes that are also in perspective).
 */
export const splitOutline = (pts: readonly Vec2[], how: "side" | "stacked", at = 0.5): [Vec2[], Vec2[]] => {
  const q = pts.length === 4 ? quadCorners(pts) : null;
  if (q) {
    const [tl, tr, br, bl] = q as [Vec2, Vec2, Vec2, Vec2];
    if (how === "side") {
      const p = lerp(tl, tr, at), r = lerp(bl, br, at);
      return [[tl, p, r, bl], [p, tr, br, r]];
    }
    const p = lerp(tl, bl, at), r = lerp(tr, br, at);
    return [[tl, tr, r, p], [p, r, br, bl]];
  }
  const axis = how === "side" ? 0 : 1;
  const lo = Math.min(...pts.map((p) => p[axis])), hi = Math.max(...pts.map((p) => p[axis]));
  const cut = lo + (hi - lo) * at;
  return [clipHalf(pts, axis, cut, true), clipHalf(pts, axis, cut, false)];
};

/** The convex hull (clockwise on screen), for joining outlines that don't touch. */
export const convexHull = (pts: readonly Vec2[]): Vec2[] => {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const x of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, x) <= 0) lower.pop();
    lower.push(x);
  }
  const upper: Vec2[] = [];
  for (const x of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, x) <= 0) upper.pop();
    upper.push(x);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
};

/**
 * Automatic house setup, second pass: making the traced shapes follow the building the way a
 * person would draw them, using the photo itself.
 *
 *   snapSides       a door's or garage door's sides move to the nearest strong edge in the photo
 *                   whose inner side looks like the part (not a siding groove or a brick course).
 *   solidColumns    the facade is solid from its top edge to its bottom edge in every column.
 *   squareBottom    the bottom edge follows the lowest course of the wall: notches (stonework,
 *                   shadows) are closed and the edge is made of straight runs.
 *   extendEaves     a sloped roof edge that stops short is continued along its line while the
 *                   photo still shows the trim's colour (eave tips the tracing cut off).
 *   removeDark      dark surfaces (shingles) leave the facade: projected light barely shows on them.
 */
import { type BitMask, type Box, maskArea, simplify } from "./houseDetect.ts";
import type { Vec2 } from "./model.ts";

/** A photo's pixels (RGB or RGBA, row by row). */
export interface Picture {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly data: ArrayLike<number>;
}

const px = (img: Picture, x: number, y: number): [number, number, number] => {
  const xi = Math.min(img.width - 1, Math.max(0, Math.round(x))), yi = Math.min(img.height - 1, Math.max(0, Math.round(y)));
  const i = (yi * img.width + xi) * img.channels;
  return [img.data[i]! / 255, img.data[i + 1]! / 255, img.data[i + 2]! / 255];
};
export const lumaAt = (img: Picture, x: number, y: number) => {
  const [r, g, b] = px(img, x, y);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const colourDist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

type Line = { p: Vec2; d: Vec2 };
const meet = (a: Line, b: Line): Vec2 | null => {
  const den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / den;
  return [a.p[0] + a.d[0] * t, a.p[1] + a.d[1] * t];
};

/**
 * Move each side of a four-cornered outline (top-left, top-right, bottom-right, bottom-left) onto
 * the nearest strong edge in the photo whose inner side matches the part's own colour (sampled well
 * inside it), so a door stops where the door stops — not on the bricks below or the siding above.
 */
export const snapSides = (img: Picture, quad: readonly Vec2[], opts: { reach?: number } = {}): Vec2[] => {
  if (quad.length !== 4) return [...quad];
  const lines: Line[] = [];
  for (let s = 0; s < 4; s++) {
    const p0 = quad[s]!, p1 = quad[(s + 1) % 4]!;
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (len < 8) return [...quad];
    const d: Vec2 = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
    // Clockwise on screen, so the normal (−dy, dx) points into the part.
    const n: Vec2 = [-d[1], d[0]];
    const across = Math.hypot(quad[(s + 2) % 4]![0] - p0[0], quad[(s + 2) % 4]![1] - p0[1]) * 0.8;
    const reach = opts.reach ?? Math.max(4, Math.min(30, across * 0.07));
    const at = (t: number, off: number): Vec2 => [p0[0] + d[0] * len * t + n[0] * off, p0[1] + d[1] * len * t + n[1] * off];
    const ts: number[] = [];
    for (let t = 0.12; t <= 0.88; t += Math.max(0.01, 3 / len)) ts.push(t);
    // The part's own brightness, from a band well inside it.
    const ref = median(ts.flatMap((t) => [0.2, 0.3].map((f) => lumaAt(img, ...at(t, across * f)))));
    let best = 0, bestScore = 0;
    for (let off = -reach; off <= reach; off++) {
      let g = 0, inside = 0;
      for (const t of ts) {
        g += Math.abs(lumaAt(img, ...at(t, off + 1.5)) - lumaAt(img, ...at(t, off - 1.5)));
        if (Math.abs(lumaAt(img, ...at(t, off + 3)) - ref) < 0.16) inside++;
      }
      // An edge counts when most of its inner side looks like the part; nearer edges are preferred.
      const score = inside / ts.length > 0.6 ? (g / ts.length) * (1 - (0.4 * Math.abs(off)) / reach) : 0;
      if (score > bestScore) {
        bestScore = score;
        best = off;
      }
    }
    lines.push({ p: [p0[0] + n[0] * best, p0[1] + n[1] * best], d });
  }
  return quad.map((c, i) => {
    const m = meet(lines[(i + 3) % 4]!, lines[i]!);
    return m && Math.hypot(m[0] - c[0], m[1] - c[1]) < 45 ? m : [...c];
  });
};

/** Top and bottom of the mask in each column (−1 where the column is empty). */
const profiles = (m: BitMask) => {
  const top = new Int32Array(m.width).fill(-1), bottom = new Int32Array(m.width).fill(-1);
  for (let x = 0; x < m.width; x++)
    for (let y = 0; y < m.height; y++)
      if (m.data[y * m.width + x]) {
        if (top[x]! < 0) top[x] = y;
        bottom[x] = y;
      }
  return { top, bottom };
};

const fromProfiles = (w: number, h: number, top: ArrayLike<number>, bottom: ArrayLike<number>): BitMask => {
  const data = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    if (top[x]! < 0 || bottom[x]! < top[x]!) continue;
    for (let y = Math.max(0, Math.round(top[x]!)); y <= Math.min(h - 1, Math.round(bottom[x]!)); y++) data[y * w + x] = 1;
  }
  return { width: w, height: h, data };
};

/** Move the bottom edge of each column to `to` (lowering fills, raising clears); nothing above changes. */
const withBottom = (m: BitMask, from: ArrayLike<number>, to: ArrayLike<number>): BitMask => {
  const data = new Uint8Array(m.data);
  for (let x = 0; x < m.width; x++) {
    const a = from[x]!, b = Math.round(to[x]!);
    if (a < 0 || b < 0) continue;
    if (b > a) for (let y = a + 1; y <= Math.min(m.height - 1, b); y++) data[y * m.width + x] = 1;
    else for (let y = Math.max(0, b + 1); y <= a; y++) data[y * m.width + x] = 0;
  }
  return { width: m.width, height: m.height, data };
};

/** Solid from the top edge to the bottom edge in every column (no inner gaps or side notches). */
export const solidColumns = (m: BitMask): BitMask => {
  const { top, bottom } = profiles(m);
  return fromProfiles(m.width, m.height, top, bottom);
};

/**
 * The bottom edge along the lowest course of the wall: dents narrower than `notch` pixels are
 * filled (to the level on both sides), and the edge becomes straight runs (within `tolerance`).
 */
export const squareBottom = (m: BitMask, notch: number, tolerance: number): BitMask => {
  const { top, bottom } = profiles(m);
  const xs: number[] = [];
  for (let x = 0; x < m.width; x++) if (bottom[x]! >= 0) xs.push(x);
  if (xs.length < 3) return m;
  const x0 = xs[0]!, x1 = xs.at(-1)!;
  const r = Math.max(1, Math.round(notch / 2));
  const clo = new Float64Array(m.width);
  for (let x = x0; x <= x1; x++) {
    if (bottom[x]! < 0) continue;
    let left = -Infinity, right = -Infinity;
    for (let k = Math.max(x0, x - r); k <= x; k++) if (bottom[k]! >= 0) left = Math.max(left, bottom[k]!);
    for (let k = x; k <= Math.min(x1, x + r); k++) if (bottom[k]! >= 0) right = Math.max(right, bottom[k]!);
    clo[x] = Math.max(bottom[x]!, Math.min(left, right));
  }
  const line = simplify(
    xs.map((x) => [x, clo[x]!] as Vec2),
    tolerance,
    false,
  );
  const out = new Float64Array(m.width).fill(-1);
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i]!, [bx, by] = line[i + 1]!;
    for (let x = Math.ceil(ax); x <= Math.floor(bx); x++) out[x] = Math.max(bottom[x]!, ay + ((by - ay) * (x - ax)) / Math.max(1e-9, bx - ax));
  }
  void top;
  return withBottom(m, bottom, out);
};

/**
 * Continue a sloped roof edge that stops short: from each end of the top edge, follow its line
 * outward while the photo just under it keeps the trim's colour, then fill the trim's depth.
 */
export const extendEaves = (m: BitMask, img: Picture, limit: Box): BitMask => {
  const { top } = profiles(m);
  const xs: number[] = [];
  for (let x = 0; x < m.width; x++) if (top[x]! >= 0) xs.push(x);
  if (xs.length < 20) return m;
  const width = xs.at(-1)! - xs[0]!;
  const edge = simplify(
    xs.map((x) => [x, top[x]!] as Vec2),
    3,
    false,
  );
  const data = new Uint8Array(m.data);
  for (const side of [-1, 1] as const) {
    // The first long run from this end.
    const pts = side < 0 ? edge : [...edge].reverse();
    let k = 0;
    while (k + 1 < pts.length && Math.abs(pts[k + 1]![0] - pts[k]![0]) < width * 0.03) k++;
    if (k + 1 >= pts.length) continue;
    const [ex, ey] = pts[k]!, [fx, fy] = pts[k + 1]!;
    const slope = (fy - ey) / (fx - ex);
    if (Math.abs(slope) < 0.12 || Math.abs(slope) > 3) continue; // flat or vertical: not a roof slope
    const yAt = (x: number) => ey + slope * (x - ex);
    // The trim's colour, a few pixels under the edge near this end, and how deep it is.
    const span = Math.min(40, Math.abs(fx - ex) * 0.5);
    const samples: Array<[number, number, number]> = [];
    for (let i = 4; i <= span; i += 2) samples.push(px(img, ex - side * i, yAt(ex - side * i) + 4));
    if (samples.length < 4) continue;
    const trim: [number, number, number] = [median(samples.map((c) => c[0])), median(samples.map((c) => c[1])), median(samples.map((c) => c[2]))];
    let depth = 0;
    for (let i = 4; i <= span; i += 4) {
      let d = 0;
      while (d < 40 && colourDist(px(img, ex - side * i, yAt(ex - side * i) + 2 + d), trim) < 0.14) d++;
      depth = Math.max(depth, d);
    }
    depth = Math.max(4, depth + 2);
    let misses = 0;
    for (let i = 1; i < width * 0.08; i++) {
      const x = Math.round(ex + side * i);
      if (x < limit.x0 - 2 || x > limit.x1 + 2 || x < 0 || x >= m.width) break;
      if (colourDist(px(img, x, yAt(x) + 4), trim) > 0.14) {
        if (++misses > 2) break;
        continue;
      }
      misses = 0;
      for (let y = Math.max(0, Math.round(yAt(x))); y <= Math.min(m.height - 1, Math.round(yAt(x) + depth)); y++) data[y * m.width + x] = 1;
    }
  }
  return { width: m.width, height: m.height, data };
};

/** Remove dark pixels (below `threshold` brightness) of `where` from the mask; returns how many went. */
export const removeDark = (m: BitMask, img: Picture, where: BitMask, threshold: number): { mask: BitMask; removed: number } => {
  const data = new Uint8Array(m.data);
  let removed = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i] || !where.data[i]) continue;
    const x = i % m.width, y = (i - x) / m.width;
    if (lumaAt(img, x, y) < threshold) {
      data[i] = 0;
      removed++;
    }
  }
  return { mask: { width: m.width, height: m.height, data }, removed };
};

/** Mean brightness of the photo where the mask is set. */
export const meanLuma = (img: Picture, m: BitMask) => {
  let s = 0, n = 0;
  for (let i = 0; i < m.data.length; i += 3) {
    if (!m.data[i]) continue;
    const x = i % m.width;
    s += lumaAt(img, x, (i - x) / m.width);
    n++;
  }
  return n ? s / n : 0;
};


/**
 * Fit a rectangular part (door, garage door, window, column, vent) to the photo, starting from the
 * detector's box: each side, in two halves (so it can lean with the perspective), moves to the
 * nearest edge where the inside looks like the part's own rim (a door's frame, a window's white
 * trim, a column's brick) and the outside doesn't. Returns top-left, top-right, bottom-right,
 * bottom-left.
 */
export const fitRectToPhoto = (img: Picture, box: Box, opts: { kind?: string } = {}): Vec2[] => {
  const quad: Vec2[] = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  // Windows are glass in the middle: their edge is where the surrounding wall stops. Solid parts
  // (doors, garage doors, posts, columns, vents) are matched by their own colour first.
  const byWall = opts.kind === "window";
  const med = (cs: Array<[number, number, number]>): [number, number, number] => [median(cs.map((c) => c[0])), median(cs.map((c) => c[1])), median(cs.map((c) => c[2]))];
  const lines: Line[] = [];
  for (let s = 0; s < 4; s++) {
    const p0 = quad[s]!, p1 = quad[(s + 1) % 4]!;
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const d: Vec2 = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
    const n: Vec2 = [-d[1], d[0]]; // into the part
    const across = s % 2 === 0 ? h : w;
    const reach = Math.max(12, Math.min(60, across * (opts.kind === "column" ? 0.45 : 0.25)));
    const at = (t: number, off: number): Vec2 => [p0[0] + d[0] * len * t + n[0] * off, p0[1] + d[1] * len * t + n[1] * off];
    const pts: Vec2[] = [];
    const found: Array<{ off: number; score: number }> = [];
    for (const [a, b] of [[0.08, 0.46], [0.54, 0.92]] as const) {
      const ts: number[] = [];
      for (let t = a; t <= b; t += Math.max(0.01, 3 / len)) ts.push(t);
      // The part's own colour (its middle, in this half) and the wall's (a band beyond the box).
      const own = med(ts.flatMap((t) => [0.3, 0.4, 0.5].map((f) => px(img, ...at(t, across * f)))));
      const wall = med(ts.flatMap((t) => [-8, -14, -20].map((o) => px(img, ...at(t, o - reach * 0.3)))));
      // An edge: the inside looks like the part and the outside doesn't, or the outside looks like
      // the wall around it and the inside doesn't. Nearer the detector's box is preferred.
      const valid = (i: [number, number, number], o: [number, number, number]) =>
        (!byWall && colourDist(i, own) < 0.2 && colourDist(o, own) > 0.15) || (colourDist(o, wall) < 0.16 && colourDist(i, wall) > 0.16);
      const r = { best: 0, bestScore: 0 };
      for (let off = -reach; off <= reach; off++) {
        let sc = 0;
        for (const t of ts) {
          const inside = px(img, ...at(t, off + 2)), outside = px(img, ...at(t, off - 2));
          if (valid(inside, outside)) sc += colourDist(inside, outside);
        }
        const score = (sc / ts.length) * (1 - (0.5 * Math.abs(off)) / reach);
        if (score > r.bestScore) {
          r.bestScore = score;
          r.best = off;
        }
      }
      found.push({ off: r.bestScore > 0 ? r.best : 0, score: r.bestScore });
      pts.push(at((a + b) / 2, r.bestScore > 0 ? r.best : 0));
    }
    // Perspective leans a side only a little: if the halves disagree more, the better-supported
    // one moves the whole side.
    if (Math.abs(found[0]!.off - found[1]!.off) > Math.max(8, len * 0.15)) {
      const keep = found[0]!.score >= found[1]!.score ? found[0]!.off : found[1]!.off;
      pts[0] = at(0.27, keep);
      pts[1] = at(0.73, keep);
    }
    const dx = pts[1]![0] - pts[0]![0], dy = pts[1]![1] - pts[0]![1], l = Math.hypot(dx, dy) || 1;
    lines.push({ p: pts[0]!, d: [dx / l, dy / l] });
  }
  return quad.map((c, i) => {
    const m = meet(lines[(i + 3) % 4]!, lines[i]!);
    return m && Math.hypot(m[0] - c[0], m[1] - c[1]) < Math.max(25, 0.5 * Math.min(w, h)) ? m : ([...c] as Vec2);
  });
};

/**
 * Move the bottom edge's runs onto the photo's edge where the wall above ends (the bottom course
 * of bricks, not the foundation or the ground). Columns in `keep` (porches, steps) are left alone.
 */
export const snapBottom = (m: BitMask, img: Picture, tolerance: number, keep: readonly Box[] = []): BitMask => {
  const { top, bottom } = profiles(m);
  const xs: number[] = [];
  for (let x = 0; x < m.width; x++) if (bottom[x]! >= 0) xs.push(x);
  if (xs.length < 10) return m;
  const line = simplify(
    xs.map((x) => [x, bottom[x]!] as Vec2),
    tolerance,
    false,
  );
  const out = Float64Array.from(bottom);
  const kept = (x: number) => keep.some((b) => x >= b.x0 - 4 && x <= b.x1 + 4);
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i]!, [bx, by] = line[i + 1]!;
    const dx = bx - ax;
    if (dx < 30 || Math.abs((by - ay) / dx) > 0.5) continue;
    const runXs: number[] = [];
    for (let x = Math.ceil(ax + dx * 0.05); x <= Math.floor(bx - dx * 0.05); x += 2) if (!kept(x)) runXs.push(x);
    if (runXs.length < 8) continue;
    const yAt = (x: number) => ay + ((by - ay) * (x - ax)) / dx;
    const R = 70;
    let best = 0, bestScore = 0;
    for (let off = -R; off <= R; off++) {
      let sc = 0;
      for (const x of runXs) {
        const y = yAt(x) + off;
        // The wall well above this point, and the pixels just above and below the candidate edge.
        const wall = px(img, x, yAt(x) - 90);
        const above = px(img, x, y - 3), below = px(img, x, y + 3);
        if (colourDist(above, wall) < 0.2 && colourDist(below, wall) > 0.15) sc += colourDist(above, below);
      }
      const score = (sc / runXs.length) * (1 - (0.3 * Math.abs(off)) / R);
      if (score > bestScore) {
        bestScore = score;
        best = off;
      }
    }
    if (bestScore < 0.03) continue;
    for (let x = Math.ceil(ax); x <= Math.floor(bx); x++) if (!kept(x) && out[x]! >= 0) out[x] = yAt(x) + best;
  }
  void top;
  return withBottom(m, bottom, out);
};

/** Fill vertical gaps in each column shorter than `maxGap` pixels (holes and small notches, not overhangs). */
export const fillShortGaps = (m: BitMask, maxGap: number): BitMask => {
  const data = new Uint8Array(m.data);
  for (let x = 0; x < m.width; x++) {
    let last = -1;
    for (let y = 0; y < m.height; y++) {
      if (!m.data[y * m.width + x]) continue;
      if (last >= 0 && y - last > 1 && y - last <= maxGap) for (let k = last + 1; k < y; k++) data[k * m.width + x] = 1;
      last = y;
    }
  }
  return { width: m.width, height: m.height, data };
};

/**
 * The top edge as straight runs: split where it bends (more than `bend` pixels off a straight line),
 * each run fitted robustly to the edge points inside it, corners where neighbouring runs meet.
 */
export const straightTop = (m: BitMask, bend: number): Vec2[] => {
  const { top } = profiles(m);
  const xs: number[] = [];
  for (let x = 0; x < m.width; x++) if (top[x]! >= 0) xs.push(x);
  if (xs.length < 10) return [];
  const raw = xs.map((x) => [x, top[x]!] as Vec2);
  const coarse = simplify(raw, bend, false);
  type Run = { a: Vec2; b: Vec2; line: Line | null };
  const runs: Run[] = [];
  for (let i = 0; i + 1 < coarse.length; i++) {
    const a = coarse[i]!, b = coarse[i + 1]!;
    const dx = b[0] - a[0];
    // Steep steps (a wall's side) stay as they are; slopes and flats get a robust straight fit.
    if (dx < 6 || Math.abs((b[1] - a[1]) / dx) > 3) {
      runs.push({ a, b, line: null });
      continue;
    }
    let pts = raw.filter((p) => p[0] >= a[0] + dx * 0.1 && p[0] <= b[0] - dx * 0.1);
    if (pts.length < 6) {
      runs.push({ a, b, line: null });
      continue;
    }
    let line = fitLine2(pts);
    for (let k = 0; k < 3 && pts.length > 8; k++) {
      const res = pts.map((p) => lineDist(line, p));
      const cut = [...res].sort((u, v) => u - v)[Math.floor(res.length * 0.75)]!;
      pts = pts.filter((_, j) => res[j]! <= cut);
      line = fitLine2(pts);
    }
    runs.push({ a, b, line });
  }
  const yOn = (l: Line, x: number) => l.p[1] + ((x - l.p[0]) * l.d[1]) / (l.d[0] || 1e-9);
  const out: Vec2[] = [];
  runs.forEach((r, i) => {
    const prev = runs[i - 1];
    let start: Vec2 = r.line ? [r.a[0], yOn(r.line, r.a[0])] : r.a;
    if (prev?.line && r.line) {
      const c = meet(prev.line, r.line);
      if (c && Math.abs(c[0] - r.a[0]) < bend * 4) start = c;
    } else if (prev?.line && !r.line) start = [r.a[0], yOn(prev.line, r.a[0])];
    out.push(start);
    if (i === runs.length - 1) out.push(r.line ? [r.b[0], yOn(r.line, r.b[0])] : r.b);
  });
  // A roof edge starts and ends at the eaves: steep drops at its ends are the walls' sides.
  const steep = (a: Vec2, b: Vec2) => Math.abs(b[0] - a[0]) < 6 || Math.abs((b[1] - a[1]) / (b[0] - a[0])) > 3;
  while (out.length > 2 && steep(out[0]!, out[1]!)) out.shift();
  while (out.length > 2 && steep(out.at(-2)!, out.at(-1)!)) out.pop();
  return out;
};

const fitLine2 = (pts: readonly Vec2[]): Line => {
  const n = pts.length;
  const mx = pts.reduce((a, q) => a + q[0], 0) / n, my = pts.reduce((a, q) => a + q[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(a), Math.sin(a)] };
};
const lineDist = (l: Line, q: Vec2) => Math.abs((q[0] - l.p[0]) * l.d[1] - (q[1] - l.p[1]) * l.d[0]);

/** Make the mask's top follow a polyline (left to right): above it is cut, small gaps below it are filled. */
export const setTop = (m: BitMask, line: readonly Vec2[], maxFill: number): BitMask => {
  const data = new Uint8Array(m.data);
  const { top } = profiles(m);
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i]!, [bx, by] = line[i + 1]!;
    for (let x = Math.max(0, Math.ceil(ax)); x <= Math.min(m.width - 1, Math.floor(bx)); x++) {
      const y = Math.round(ay + ((by - ay) * (x - ax)) / Math.max(1e-9, bx - ax));
      if (top[x]! < 0) continue;
      for (let k = 0; k < Math.max(0, y); k++) data[k * m.width + x] = 0;
      if (top[x]! > y && top[x]! - y <= maxFill) for (let k = Math.max(0, y); k < top[x]!; k++) data[k * m.width + x] = 1;
    }
  }
  return { width: m.width, height: m.height, data };
};

/**
 * Continue the end runs of a roof edge along their slope while the photo just under the line keeps
 * the trim's colour (eave tips the tracing cut off); fills the trim's depth under the extension.
 * Returns the mask and the lengthened line.
 */
export const extendRoofEnds = (m: BitMask, img: Picture, line: readonly Vec2[], limit: Box): { mask: BitMask; line: Vec2[] } => {
  const data = new Uint8Array(m.data);
  const out = [...line];
  if (line.length < 2) return { mask: m, line: out };
  for (const side of [-1, 1] as const) {
    const end = side < 0 ? out[0]! : out.at(-1)!;
    const next = side < 0 ? out[1]! : out.at(-2)!;
    const dx = next[0] - end[0];
    const slope = (next[1] - end[1]) / (dx || 1e-9);
    if (Math.abs(dx) < 20 || Math.abs(slope) < 0.1 || Math.abs(slope) > 3) continue;
    const yAt = (x: number) => end[1] + slope * (x - end[0]);
    // The trim's colour and depth, just inside this end.
    const samples: Array<[number, number, number]> = [];
    for (let i = 6; i <= Math.min(50, Math.abs(dx) * 0.5); i += 2) samples.push(px(img, end[0] - side * i, yAt(end[0] - side * i) + 4));
    if (samples.length < 4) continue;
    const trim: [number, number, number] = [median(samples.map((c) => c[0])), median(samples.map((c) => c[1])), median(samples.map((c) => c[2]))];
    let depth = 4;
    for (let i = 6; i <= 40; i += 6) {
      let dd = 0;
      while (dd < 45 && colourDist(px(img, end[0] - side * i, yAt(end[0] - side * i) + 2 + dd), trim) < 0.15) dd++;
      depth = Math.max(depth, dd + 2);
    }
    let reachedX = end[0], misses = 0;
    for (let i = 1; i < (limit.x1 - limit.x0) * 0.1; i++) {
      const x = Math.round(end[0] + side * i);
      if (x < Math.max(0, limit.x0 - 4) || x > Math.min(m.width - 1, limit.x1 + 4)) break;
      if (colourDist(px(img, x, yAt(x) + 3), trim) > 0.15) {
        if (++misses > 2) break;
        continue;
      }
      misses = 0;
      reachedX = x;
      for (let y = Math.max(0, Math.round(yAt(x))); y <= Math.min(m.height - 1, Math.round(yAt(x) + depth)); y++) data[y * m.width + x] = 1;
    }
    if (reachedX !== end[0]) {
      const p: Vec2 = [reachedX, yAt(reachedX)];
      if (side < 0) out.unshift(p);
      else out.push(p);
    }
  }
  return { mask: { width: m.width, height: m.height, data }, line: out };
};

/** Remove narrow downward spikes from the bottom edge (an opening of its profile, `width` pixels). */
export const trimBottomSpikes = (m: BitMask, width: number): BitMask => {
  const { bottom } = profiles(m);
  const r = Math.max(1, Math.round(width / 2));
  const out = Float64Array.from(bottom);
  for (let x = 0; x < m.width; x++) {
    if (bottom[x]! < 0) continue;
    let left = Infinity, right = Infinity;
    let hasL = false, hasR = false;
    for (let k = Math.max(0, x - r); k < x; k++) if (bottom[k]! >= 0) (left = Math.min(left, bottom[k]!)), (hasL = true);
    for (let k = x + 1; k <= Math.min(m.width - 1, x + r); k++) if (bottom[k]! >= 0) (right = Math.min(right, bottom[k]!)), (hasR = true);
    // A spike: higher ground on both sides within the window.
    if (hasL && hasR) out[x] = Math.min(bottom[x]!, Math.max(left, right));
  }
  return withBottom(m, bottom, out);
};

type RGB = [number, number, number];
const medRGB = (cs: RGB[]): RGB => [median(cs.map((c) => c[0])), median(cs.map((c) => c[1])), median(cs.map((c) => c[2]))];

/**
 * Search along a side's normal for the photo's edge of a part: the inside looks like the part's
 * own colour and the outside doesn't, or the outside looks like the wall around the part and the
 * inside doesn't. Scored over the given stretch of the side; nearer the starting line is preferred.
 */
/**
 * The same material, allowing for shade: close in colour, or — for clearly coloured materials like
 * brick — the same hue at a brightness a shadow could explain. (Neutral greys and whites need the
 * colour itself to match, or siding would pass for white trim.)
 */
const sameMaterial = (a: RGB, b: RGB) => {
  if (colourDist(a, b) < 0.18) return true;
  const sa = a[0] + a[1] + a[2], sb = b[0] + b[1] + b[2];
  if (sa < 0.05 || sb < 0.05) return false;
  const ca: Vec2 = [a[0] / sa - 1 / 3, a[1] / sa - 1 / 3], cb: Vec2 = [b[0] / sb - 1 / 3, b[1] / sb - 1 / 3];
  const vivid = Math.hypot(...ca) > 0.018 && Math.hypot(...cb) > 0.018;
  const ratio = sa / sb;
  // Shade only darkens: `a` may be a shaded version of `b`, not a brighter one.
  return vivid && Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) < 0.025 && ratio > 0.3 && ratio < 0.8;
};

const inTraced = (m: BitMask, [x, y]: Vec2) => {
  const xi = Math.round(x), yi = Math.round(y);
  return xi >= 0 && yi >= 0 && xi < m.width && yi < m.height && m.data[yi * m.width + xi] === 1;
};

export const sideEdge = (img: Picture, p0: Vec2, p1: Vec2, across: number, reach: number, byWall: boolean, wall: RGB, range: readonly [number, number], traced?: BitMask) => {
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const d: Vec2 = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
  const n: Vec2 = [-d[1], d[0]]; // into the part (corners go clockwise on screen)
  const at = (t: number, off: number): Vec2 => [p0[0] + d[0] * len * t + n[0] * off, p0[1] + d[1] * len * t + n[1] * off];
  const ts: number[] = [];
  for (let t = range[0]; t <= range[1]; t += Math.max(0.01, 3 / len)) ts.push(t);
  // The part's own colour at each point along the side (a column can be brick above and stone
  // below; part of a door can be in shade).
  const ownAt = ts.map((t) => medRGB([0.25, 0.32, 0.4, 0.47].map((f) => px(img, ...at(t, across * f)))));
  // Solid parts by their own colour (a textured wall — siding grooves, mortar — makes false
  // "wall stops here" edges); windows, and solid parts with no clear edge of their own, by the wall.
  // An edge separates two bands several pixels deep, not two pixels: a narrow shadow or groove
  // next to a part can't pass for the part.
  // (Each band's average colour, so brick mortar and siding grooves average out.)
  const band = (t: number, off: number, ds: readonly number[]): RGB => {
    const cs = ds.map((dd) => px(img, ...at(t, off + dd)));
    return [cs.reduce((u, c) => u + c[0], 0) / cs.length, cs.reduce((u, c) => u + c[1], 0) / cs.length, cs.reduce((u, c) => u + c[2], 0) / cs.length];
  };
  const byOwn = (ins: RGB, outs: RGB, k: number) => sameMaterial(ins, ownAt[k]!) && !sameMaterial(outs, ownAt[k]!) && colourDist(outs, ownAt[k]!) > 0.1;
  const byWallEdge = (ins: RGB, outs: RGB) => colourDist(outs, wall) < 0.16 && colourDist(ins, wall) > 0.16;
  const profile: Array<[number, number]> = [];
  const search = (valid: (ins: RGB, outs: RGB, k: number) => boolean) => {
    let best = 0, score = 0;
    profile.length = 0;
    // Detectors' boxes enclose the whole part (they're loose, not tight): look mostly inward.
    const outward = Math.min(reach, Math.max(6, across * 0.04));
    for (let off = -outward; off <= reach; off++) {
      let sc = 0;
      for (let k = 0; k < ts.length; k++) {
        const t = ts[k]!;
        const ins = band(t, off, [2, 4, 6, 8, 10]), outs = band(t, off, [-2, -4, -6, -8]);
        if (!valid(ins, outs, k)) continue;
        let v = colourDist(px(img, ...at(t, off + 2)), px(img, ...at(t, off - 2)));
        // The segmentation model's outline of the part, as a second opinion: an edge it agrees
        // with counts fully, one it doesn't counts half.
        if (traced) v *= inTraced(traced, at(t, off + 3)) && !inTraced(traced, at(t, off - 3)) ? 1 : 0.5;
        sc += v;
      }
      // Detectors' boxes rarely cut a part off: edges outside the box count for less.
      const v = (sc / ts.length) * (1 - ((off < 0 ? 0.9 : 0.5) * Math.abs(off)) / reach);
      profile.push([off, v]);
      if (v > score) {
        score = v;
        best = off;
      }
    }
    return { best, score };
  };
  let r = byWall ? { best: 0, score: 0 } : search(byOwn);
  let crit = "own";
  if (r.score < 0.04) {
    r = search(byWallEdge);
    crit = "wall";
  }
  const off = r.best;
  return { off, score: r.score, crit, profile, point: (t: number) => at(t, off) };
};

export interface RectPart {
  readonly key: string;
  readonly kind: string;
  readonly box: Box;
}

type Vanishing = { point: Vec2 } | { dir: Vec2 };

/** The lines' weighted mean direction (oriented like `like`). */
const meanDir = (lines: ReadonlyArray<{ d: Vec2; w: number }>, like: Vec2): Vec2 => {
  let dx = 0, dy = 0;
  for (const l of lines) {
    const sgn = l.d[0] * like[0] + l.d[1] * like[1] >= 0 ? 1 : -1;
    dx += l.w * l.d[0] * sgn;
    dy += l.w * l.d[1] * sgn;
  }
  const n = Math.hypot(dx, dy);
  return n ? [dx / n, dy / n] : like;
};

/** Least-squares meeting point of lines, or their shared direction if they're (nearly) parallel. */
const meetAll = (lines: ReadonlyArray<{ p: Vec2; d: Vec2; w: number }>, size: number, fallback: Vec2): Vanishing => {
  let a = 0, b = 0, c = 0, e = 0, f = 0, dx = 0, dy = 0;
  for (const l of lines) {
    const n: Vec2 = [-l.d[1], l.d[0]];
    const k = n[0] * l.p[0] + n[1] * l.p[1];
    a += l.w * n[0] * n[0];
    b += l.w * n[0] * n[1];
    c += l.w * n[1] * n[1];
    e += l.w * n[0] * k;
    f += l.w * n[1] * k;
    const sgn = l.d[0] * fallback[0] + l.d[1] * fallback[1] >= 0 ? 1 : -1;
    dx += l.w * l.d[0] * sgn;
    dy += l.w * l.d[1] * sgn;
  }
  const mean: Vec2 = [dx / (Math.hypot(dx, dy) || 1), dy / (Math.hypot(dx, dy) || 1)];
  const det = a * c - b * b;
  if (lines.length < 2 || det < 1e-6 * (a + c) * (a + c)) return { dir: lines.length ? mean : fallback };
  const v: Vec2 = [(c * e - b * f) / det, (a * f - b * e) / det];
  if (!Number.isFinite(v[0]) || Math.hypot(v[0], v[1]) > size * 60) return { dir: mean };
  return { point: v };
};

/**
 * Where the measured edges meet — by consensus: every pair of lines proposes a meeting point, the
 * one most lines point at (within `tolAngle`) wins, refined on those lines. Stray measurements
 * (a short vent side, a shadow) can't drag it. Too strong a convergence (more than `maxLean`
 * across the photo) is treated as parallel.
 */
const vanishing = (lines: ReadonlyArray<{ p: Vec2; d: Vec2; w: number }>, frame: { width: number; height: number }, fallback: Vec2, maxLean = 0.35, tolAngle = 0.026): Vanishing => {
  const size = Math.max(frame.width, frame.height);
  if (lines.length < 3) return meetAll(lines, size, fallback);
  const agree = (v: Vanishing, l: { p: Vec2; d: Vec2 }) => {
    const d = dirAt(v, l.p, l.d);
    return Math.abs(d[0] * l.d[1] - d[1] * l.d[0]) < tolAngle;
  };
  let best: Vanishing | null = null, bestW = 0;
  const cands: Vanishing[] = [];
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const m = meet(lines[i]!, lines[j]!);
      if (m && Math.hypot(m[0], m[1]) < size * 60) cands.push({ point: m });
    }
  cands.push(meetAll(lines, size, fallback));
  for (const l of lines) cands.push({ dir: l.d[0] * fallback[0] + l.d[1] * fallback[1] >= 0 ? l.d : [-l.d[0], -l.d[1]] });
  for (const v of cands) {
    const w = lines.reduce((s, l) => s + (agree(v, l) ? l.w : 0), 0);
    if (w > bestW) {
      bestW = w;
      best = v;
    }
  }
  const inliers = best ? lines.filter((l) => agree(best!, l)) : [];
  const v = inliers.length >= 2 ? meetAll(inliers, size, fallback) : (best ?? { dir: fallback });
  // Sanity: how far from the fallback direction this makes edges lean at the photo's corners.
  if ("point" in v) {
    for (const corner of [[0, 0], [frame.width, 0], [0, frame.height], [frame.width, frame.height]] as Vec2[]) {
      const d = dirAt(v, corner, fallback);
      if (Math.abs(d[0] * fallback[1] - d[1] * fallback[0]) > maxLean) return { dir: meanDir(inliers.length ? inliers : lines, fallback) };
    }
  }
  return v;
};

const dirAt = (v: Vanishing, p: Vec2, like: Vec2): Vec2 => {
  if ("dir" in v) return v.dir;
  let d: Vec2 = [v.point[0] - p[0], v.point[1] - p[1]];
  const l = Math.hypot(d[0], d[1]) || 1;
  d = [d[0] / l, d[1] / l];
  return d[0] * like[0] + d[1] * like[1] >= 0 ? d : [-d[0], -d[1]];
};

/**
 * Fit rectangular parts (doors, garage doors, windows, columns, vents) to the photo as the
 * rectangles they are, seen at the house's angle. The house's two vanishing points — where its
 * vertical edges meet, and where its horizontal edges meet — are measured from the parts' sides
 * that the photo shows clearly; then every side takes the direction those give at its place and
 * is found as one whole line along it (a shadow across a door can't bend it). Windows (glass in
 * the middle) are edged by where the surrounding wall stops; solid parts also by their own colour.
 * The wall's colour is taken from all around the part, so a post beside a window doesn't count as
 * wall. Returns each part's corners: top-left, top-right, bottom-right, bottom-left.
 */
export const fitRectsToPhoto = (img: Picture, parts: readonly RectPart[], debug?: unknown[], traced?: ReadonlyMap<string, BitMask>): Map<string, Vec2[]> => {
  const reachFor = (kind: string, across: number) => Math.max(12, Math.min(60, across * (kind === "column" ? 0.45 : 0.25)));
  const ringWall = (b: Box): RGB => {
    const cs: RGB[] = [];
    for (const o of [8, 16, 26]) {
      for (let t = 0.1; t <= 0.9; t += 0.1) {
        const x = b.x0 + (b.x1 - b.x0) * t, y = b.y0 + (b.y1 - b.y0) * t;
        cs.push(px(img, x, b.y0 - o), px(img, x, b.y1 + o), px(img, b.x0 - o, y), px(img, b.x1 + o, y));
      }
    }
    return medRGB(cs);
  };
  const sidesOf = (b: Box): Array<[Vec2, Vec2]> => [
    [[b.x0, b.y0], [b.x1, b.y0]],
    [[b.x1, b.y0], [b.x1, b.y1]],
    [[b.x1, b.y1], [b.x0, b.y1]],
    [[b.x0, b.y1], [b.x0, b.y0]],
  ];
  const walls = new Map(parts.map((p) => [p.key, ringWall(p.box)]));
  // Pass 1: sides measured in two halves; the clear ones (halves agree) give the perspective.
  const verticals: Array<{ p: Vec2; d: Vec2; w: number }> = [], horizontals: Array<{ p: Vec2; d: Vec2; w: number }> = [];
  for (const p of parts) {
    const w = p.box.x1 - p.box.x0, h = p.box.y1 - p.box.y0;
    sidesOf(p.box).forEach(([a, b], s) => {
      const vertical = s % 2 === 1, across = vertical ? w : h, len = vertical ? h : w;
      const reach = reachFor(p.kind, across);
      const e1 = sideEdge(img, a, b, across, reach, p.kind === "window", walls.get(p.key)!, [0.08, 0.46]);
      const e2 = sideEdge(img, a, b, across, reach, p.kind === "window", walls.get(p.key)!, [0.54, 0.92]);
      if (e1.score < 0.06 || e2.score < 0.06 || Math.abs(e1.off - e2.off) > len * 0.12) return;
      const q1 = e1.point(0.27), q2 = e2.point(0.73);
      const l = Math.hypot(q2[0] - q1[0], q2[1] - q1[1]) || 1;
      (vertical ? verticals : horizontals).push({ p: q1, d: [(q2[0] - q1[0]) / l, (q2[1] - q1[1]) / l], w: Math.min(e1.score, e2.score) * len, ...(debug ? { part: `${p.kind}:${s}` } : {}) });
    });
  }
  const size = Math.max(img.width, img.height);
  const vv = vanishing(verticals, img, [0, 1]), vh = vanishing(horizontals, img, [1, 0]);
  if (debug) debug.push({ verticals, horizontals, vv, vh });
  // Pass 2: each side along its perspective direction, found as one whole line.
  const out = new Map<string, Vec2[]>();
  for (const p of parts) {
    const { x0, y0, x1, y1 } = p.box;
    const w = x1 - x0, h = y1 - y0;
    const lines: Line[] = [];
    sidesOf(p.box).forEach(([a, b], s) => {
      const vertical = s % 2 === 1, across = vertical ? w : h;
      const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const half = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
      // Along the side's own direction of travel (clockwise), as perspective sets it here.
      const like: Vec2 = [(b[0] - a[0]) / (2 * half), (b[1] - a[1]) / (2 * half)];
      const base = dirAt(vertical ? vv : vh, mid, like);
      // A leaning side touches its upright box at one end only: start from the line through that
      // corner (the tightest line inside the box), not through the box side's middle.
      const nIn: Vec2 = [-base[1], base[0]];
      const anchor = (a[0] - b[0]) * nIn[0] + (a[1] - b[1]) * nIn[1] > 0 ? a : b;
      const along = (q: Vec2) => (q[0] - anchor[0]) * base[0] + (q[1] - anchor[1]) * base[1];
      const ta = along(a), tb = along(b);
      const midOn: Vec2 = [anchor[0] + base[0] * ((ta + tb) / 2), anchor[1] + base[1] * ((ta + tb) / 2)];
      // The perspective direction is a guide (lenses bend lines a little near a photo's edges):
      // the side may turn by up to ~2° where the photo's edge fits better.
      let e: ReturnType<typeof sideEdge> | null = null, d = base, bestScore = -1;
      // Start from either line (through the touching corner, or the box side's middle) and keep
      // whichever the photo supports better.
      for (const from of [midOn, mid])
      for (const turn of [0, -0.01, 0.01, -0.02, 0.02, -0.035, 0.035, -0.05, 0.05]) {
        const c = Math.cos(turn), sn = Math.sin(turn);
        const dd: Vec2 = [base[0] * c - base[1] * sn, base[0] * sn + base[1] * c];
        const r = sideEdge(img, [from[0] - dd[0] * half, from[1] - dd[1] * half], [from[0] + dd[0] * half, from[1] + dd[1] * half], across, reachFor(p.kind, across), p.kind === "window", walls.get(p.key)!, [0.06, 0.94], traced?.get(p.key));
        const v = r.score * (1 - 3 * Math.abs(turn));
        if (v > bestScore) {
          bestScore = v;
          e = r;
          d = dd;
        }
      }
      lines.push({ p: e!.point(0.5), d });
      if (debug) debug.push({ part: p.kind, box: [x0, y0, x1, y1].map(Math.round), side: s, off: e!.off, score: Math.round(e!.score * 1000) / 1000, crit: e!.crit });
    });
    const start: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    out.set(
      p.key,
      start.map((c, i) => {
        const m = meet(lines[(i + 3) % 4]!, lines[i]!);
        return m && Math.hypot(m[0] - c[0], m[1] - c[1]) < Math.max(25, 0.5 * Math.min(w, h)) ? m : c;
      }),
    );
  }
  return out;
};

/**
 * The bottom edge as robust straight runs: between porches and steps (`keep`), each stretch of
 * wall gets one straight line through most of its bottom points — the bottom course — so notches
 * in stonework and dips into a foundation are ignored.
 */
export const straightBottomRuns = (m: BitMask, keep: readonly Box[], minRun: number, near = 80): BitMask => {
  const { bottom } = profiles(m);
  const out = Float64Array.from(bottom);
  const kept = (x: number) => keep.some((b) => x >= b.x0 - 4 && x <= b.x1 + 4);
  let x = 0;
  while (x < m.width) {
    while (x < m.width && (bottom[x]! < 0 || kept(x))) x++;
    const s = x;
    while (x < m.width && bottom[x]! >= 0 && !kept(x)) x++;
    const e = x - 1;
    if (e - s < minRun) continue;
    const pts: Vec2[] = [];
    for (let k = s; k <= e; k += 2) pts.push([k, bottom[k]!]);
    const line = consensusLine(pts, 4);
    if (!line || Math.abs(line.d[1] / (line.d[0] || 1e-9)) > 0.3) continue; // not a bottom course
    // Keep the runs' ends where they were (corners), straighten the rest.
    const margin = Math.min(12, (e - s) * 0.05);
    for (let k = Math.ceil(s + margin); k <= Math.floor(e - margin); k++) {
      const y = line.p[1] + ((k - line.p[0]) * line.d[1]) / (line.d[0] || 1e-9);
      // Columns ending far above the line (under an eave, beside the wall) are not the wall's bottom.
      if (Math.abs(bottom[k]! - y) <= near) out[k] = y;
    }
  }
  return withBottom(m, bottom, out);
};

/**
 * The straight line most of the points agree with (within `tol` pixels), refined by least squares
 * on those points: robust to a large share of stray points (notches, dips). Deterministic.
 */
export const consensusLine = (pts: readonly Vec2[], tol: number): Line | null => {
  if (pts.length < 4) return null;
  const step = Math.max(1, Math.floor(pts.length / 40));
  const sample = pts.filter((_, i) => i % step === 0);
  let best: Line | null = null, bestCount = 0;
  for (let i = 0; i < sample.length; i++)
    for (let j = i + 1; j < sample.length; j++) {
      const a = sample[i]!, b = sample[j]!;
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
      if (l < 10) continue;
      const line: Line = { p: a, d: [dx / l, dy / l] };
      let c = 0;
      for (const q of pts) if (lineDist(line, q) <= tol) c++;
      if (c > bestCount) {
        bestCount = c;
        best = line;
      }
    }
  if (!best) return null;
  const inliers = pts.filter((q) => lineDist(best!, q) <= tol);
  return inliers.length >= 4 ? fitLine2(inliers) : best;
};

/**
 * Remove a dark surface at the top of the mask within `where` (roof shingles): the dark pixels
 * (below `threshold`) joined to the mask's top edge, if together they're a sizeable part of
 * `where`. Shaded trim below a bright gutter isn't joined to the top, so it stays.
 */
export const removeDarkTop = (m: BitMask, img: Picture, where: BitMask, threshold: number, minShare = 0.15): { mask: BitMask; removed: number } => {
  const W = m.width, H = m.height;
  const dark = new Uint8Array(W * H);
  let region = 0;
  for (let i = 0; i < dark.length; i++) {
    if (!m.data[i] || !where.data[i]) continue;
    region++;
    const x = i % W, y = (i - x) / W;
    let l = 0;
    for (let dy = -2; dy <= 2; dy += 2) for (let dx = -2; dx <= 2; dx += 2) l += lumaAt(img, x + dx, y + dy);
    if (l / 9 < threshold) dark[i] = 1;
  }
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let i = 0; i < dark.length; i++) {
    const y = Math.floor(i / W);
    if (dark[i] && (y === 0 || !m.data[i - W])) {
      seen[i] = 1;
      stack.push(i);
    }
  }
  let n = 0;
  while (stack.length) {
    const i = stack.pop()!;
    n++;
    const x = i % W, y = (i - x) / W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1])
      if (j >= 0 && dark[j] && !seen[j]) {
        seen[j] = 1;
        stack.push(j);
      }
  }
  if (!region || n < region * minShare) return { mask: m, removed: 0 };
  const data = new Uint8Array(m.data);
  for (let i = 0; i < data.length; i++) if (seen[i]) data[i] = 0;
  return { mask: { width: W, height: H, data }, removed: n };
};

/**
 * Turn emitter and container shapes into per-cell masks on the simulation grid (CPU, once per
 * simulation). Closed shapes use their inside (or a top / bottom band of it); open shapes such as
 * rooflines emit along a thin line.
 */
import { flattenPath, type PathData, type ResolvedSim, type Vec2 } from "@be/core";

const inside = (pts: readonly Vec2[], x: number, y: number): boolean => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

const distToSegments = (pts: readonly Vec2[], x: number, y: number): number => {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[i + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
};

/** Coverage 0..1 per cell of the given shapes (cell centres, comp-space shapes). */
export const shapeMask = (paths: readonly PathData[], nx: number, ny: number, cell: number, band: "top" | "bottom" | "whole" = "whole", thin = false): Float32Array => {
  const out = new Float32Array(nx * ny);
  for (const path of paths) {
    const pts = flattenPath(path, 12);
    if (pts.length < 2) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const closed = path.closed && pts.length >= 3;
    const bandH = thin ? 1.5 * cell : Math.max(2 * cell, (maxY - minY) * 0.14);
    const pad = closed ? 0 : 1.6 * cell;
    const i0 = Math.max(0, Math.floor((minX - pad) / cell));
    const i1 = Math.min(nx - 1, Math.ceil((maxX + pad) / cell));
    const j0 = Math.max(0, Math.floor((minY - pad) / cell));
    const j1 = Math.min(ny - 1, Math.ceil((maxY + pad) / cell));
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5) * cell;
      if (closed && band === "top" && y > minY + bandH) continue;
      if (closed && band === "bottom" && y < maxY - bandH) continue;
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * cell;
        const v = closed ? (inside(pts, x, y) ? 1 : 0) : Math.max(0, 1 - distToSegments(pts, x, y) / pad);
        if (v > out[j * nx + i]!) out[j * nx + i] = v;
      }
    }
  }
  return out;
};

/** 3x3 box blur. */
const soften = (m: Float32Array, nx: number, ny: number): Float32Array => {
  const out = new Float32Array(m.length);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) s += m[Math.min(ny - 1, Math.max(0, j + dj)) * nx + Math.min(nx - 1, Math.max(0, i + di))]!;
      out[j * nx + i] = s / 9;
    }
  return out;
};

/**
 * Emitters for one frame as vec4 per cell: (strength 0..1, unused, vx, vy) in cells per second.
 * Emitters outside their time window contribute nothing.
 */
export const emitterField = (sim: ResolvedSim, nx: number, ny: number, cell: number, seconds: number, cache: Map<number, Float32Array>): Float32Array => {
  const out = new Float32Array(nx * ny * 4);
  sim.emitters.forEach(({ emitter, paths }, k) => {
    if (emitter.from !== undefined && seconds < emitter.from) return;
    if (emitter.to !== undefined && seconds > emitter.to) return;
    let m = cache.get(k);
    if (!m) {
      // Water pours from a thin strip; smoke comes from a soft-edged band (no hard lines).
      m = shapeMask(paths, nx, ny, cell, emitter.band, sim.settings.type === "water");
      if (sim.settings.type === "smoke") m = soften(soften(m, nx, ny), nx, ny);
      cache.set(k, m);
    }
    const a = Math.max(0, Math.min(100, emitter.amount)) / 100;
    const vx = emitter.velocity[0] / cell;
    const vy = emitter.velocity[1] / cell;
    for (let i = 0; i < nx * ny; i++) {
      const s = m[i]! * a;
      if (s <= out[i * 4]!) continue;
      out[i * 4] = s;
      out[i * 4 + 2] = vx;
      out[i * 4 + 3] = vy;
    }
  });
  return out;
};

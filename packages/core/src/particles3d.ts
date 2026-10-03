/**
 * Particles in 3D scenes: sparks, embers, snow and confetti, in front of the house.
 *
 * Procedural, not simulated: every particle's position at a moment is worked out directly from its
 * own seeded random values and the time since it was born (motion with air drag, gravity, wind and
 * sway), so seeking, preview and export all show the same particles and nothing is prepared ahead.
 * They don't collide with the house; they come from the traced areas' shapes (or, for snow, fall
 * from the sky above them).
 *
 * Coordinates are the 3D scenes' (metres; x right, y up, z toward the audience; house front z = 0).
 */
import earcut from "earcut";
import { refRegions } from "./areas.ts";
import type { Id, Project, RegionRef, RGBA } from "./model.ts";
import { flattenPath } from "./pathmath.ts";
import { rand01 } from "./rng.ts";
import { type Canvas, canvasToWorld, METERS_PER_PIXEL } from "./world3d.ts";

export type ParticleKind = "sparks" | "embers" | "snow" | "confetti";

export interface Particles3D {
  readonly kind: ParticleKind;
  /** The areas they come from (snow: falls over them). Null: the whole picture. */
  readonly from: RegionRef | null;
  /** Particles born per second while emitting. */
  readonly rate: number;
  /** Seconds each one lasts, on average (snow: until it reaches the ground). */
  readonly life: number;
  /** Typical speed, m/s. */
  readonly speed: number;
  /** Typical size, m. */
  readonly size: number;
  /** Sparks and embers: hot to cool over their life. Confetti: the mix. Snow: the first. */
  readonly colors: readonly RGBA[];
  /** Steady sideways wind, m/s (+ is to the right). */
  readonly wind: number;
  /** When they start and stop being born (seconds into the layer; stop null = until the end). */
  readonly start: number;
  readonly stop: number | null;
  readonly seed: number;
}

export const PARTICLE_PRESETS: Record<ParticleKind, { title: string; description: string; glow: boolean; settings: Omit<Particles3D, "from" | "seed"> }> = {
  sparks: {
    title: "Sparks (3D)",
    description: "Hot sparks spray out of the area, arc down and burn out.",
    glow: true,
    settings: { kind: "sparks", rate: 260, life: 1.1, speed: 5, size: 0.12, colors: [[1, 0.95, 0.75, 1], [1, 0.6, 0.15, 1], [0.8, 0.15, 0.02, 1]], wind: 0, start: 0, stop: null },
  },
  embers: {
    title: "Embers (3D)",
    description: "Glowing embers drift up from the area, flickering as they cool.",
    glow: true,
    settings: { kind: "embers", rate: 70, life: 3.5, speed: 0.9, size: 0.16, colors: [[1, 0.75, 0.3, 1], [1, 0.4, 0.08, 1], [0.6, 0.1, 0.02, 1]], wind: 0.3, start: 0, stop: null },
  },
  snow: {
    title: "Snow (3D)",
    description: "Snow falls in front of the house, nearer flakes bigger, swaying as they go.",
    glow: false,
    settings: { kind: "snow", rate: 160, life: 0, speed: 0.9, size: 0.07, colors: [[1, 1, 1, 1]], wind: 0.2, start: 0, stop: null },
  },
  confetti: {
    title: "Confetti (3D)",
    description: "A burst of confetti flies up from the area and flutters down.",
    glow: false,
    settings: {
      kind: "confetti",
      rate: 900,
      life: 6,
      speed: 9,
      size: 0.07,
      colors: [[0.95, 0.25, 0.3, 1], [1, 0.8, 0.15, 1], [0.2, 0.75, 0.4, 1], [0.25, 0.55, 1, 1], [0.85, 0.4, 0.95, 1]],
      wind: 0,
      start: 0,
      stop: 0.35,
    },
  },
};

/** Where particles are born: the areas as triangles (metres), and the picture's size. */
export interface ParticleEmitter {
  /** x0,y0,x1,y1,x2,y2 per triangle. */
  readonly tris: Float64Array;
  /** Running total of triangle areas. */
  readonly cum: Float64Array;
  readonly bounds: { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number };
  /** The picture, in metres: x from −W/2 to W/2, y from 0 (bottom) to H (top). */
  readonly W: number;
  readonly H: number;
}

const ringOf = (path: Parameters<typeof flattenPath>[0]) => {
  const out: Array<readonly [number, number]> = [];
  for (const p of flattenPath(path, 8)) if (!out.length || Math.hypot(p[0] - out.at(-1)![0], p[1] - out.at(-1)![1]) > 1e-6) out.push(p);
  return out;
};

export const particleEmitter = (project: Project, p: Particles3D, venueId: Id | undefined, canvas: Canvas): ParticleEmitter => {
  const W = canvas.width * METERS_PER_PIXEL, H = canvas.height * METERS_PER_PIXEL;
  const regions = p.from ? refRegions(project, p.from, venueId).filter((r) => r.path.closed) : [];
  const tris: number[] = [];
  for (const r of regions) {
    const ring = ringOf(r.path).map((q) => canvasToWorld(q, canvas));
    if (ring.length < 3) continue;
    const flat = ring.flatMap((q) => [q[0], q[1]]);
    const idx = earcut(flat);
    for (const i of idx) tris.push(flat[i * 2]!, flat[i * 2 + 1]!);
  }
  if (!tris.length) {
    // The whole picture.
    tris.push(-W / 2, 0, W / 2, 0, W / 2, H, -W / 2, 0, W / 2, H, -W / 2, H);
  }
  const n = tris.length / 6;
  const cum = new Float64Array(n);
  let total = 0;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let t = 0; t < n; t++) {
    const [ax, ay, bx, by, cx, cy] = tris.slice(t * 6, t * 6 + 6) as [number, number, number, number, number, number];
    total += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    cum[t] = total;
    x0 = Math.min(x0, ax, bx, cx);
    x1 = Math.max(x1, ax, bx, cx);
    y0 = Math.min(y0, ay, by, cy);
    y1 = Math.max(y1, ay, by, cy);
  }
  return { tris: Float64Array.from(tris), cum, bounds: { x0, x1, y0, y1 }, W, H };
};

/** A point spread evenly over the emitter's areas, from three random numbers. */
export const emitterPoint = (em: ParticleEmitter, a: number, b: number, c: number): [number, number] => {
  const total = em.cum[em.cum.length - 1] ?? 0;
  let lo = 0, hi = em.cum.length - 1;
  const want = a * total;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (em.cum[mid]! < want) lo = mid + 1;
    else hi = mid;
  }
  const t = em.tris.subarray(lo * 6, lo * 6 + 6);
  // Uniform in a triangle: fold the unit square.
  let u = b, v = c;
  if (u + v > 1) {
    u = 1 - u;
    v = 1 - v;
  }
  return [t[0]! + u * (t[2]! - t[0]!) + v * (t[4]! - t[0]!), t[1]! + u * (t[3]! - t[1]!) + v * (t[5]! - t[1]!)];
};

/** Floats per live particle: x, y, z, size, r, g, b, a, angle (about z), tilt (about x), stretch (along the angle). */
export const PARTICLE_STRIDE = 11;

const G = 9.81;

/** Longest a particle can live (s). Snow: the time to fall the whole picture at the slowest speed. */
const maxLife = (p: Particles3D, em: ParticleEmitter) => (p.kind === "snow" ? (em.H + 1) / Math.max(0.05, p.speed * 0.6) : p.life * 1.4);

/** Most particles alive at once (for sizing buffers). */
export const particleCapacity = (p: Particles3D, em: ParticleEmitter): number => {
  const window = p.stop !== null ? Math.min(maxLife(p, em), Math.max(0, p.stop - p.start)) : maxLife(p, em);
  return Math.min(50_000, Math.ceil(p.rate * window) + 4);
};

const mixColors = (cs: readonly RGBA[], u: number): [number, number, number] => {
  if (cs.length === 1) return [cs[0]![0], cs[0]![1], cs[0]![2]];
  const f = Math.min(0.9999, Math.max(0, u)) * (cs.length - 1);
  const i = Math.floor(f), k = f - i;
  const a = cs[i]!, b = cs[i + 1]!;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};

/** Travel with air drag k (1/s): ∫ e^(−k t) dt. */
const dragged = (k: number, t: number) => (1 - Math.exp(-k * t)) / k;

/**
 * The particles alive `t` seconds into the layer: PARTICLE_STRIDE floats each, in `out` (grown if
 * needed). Deterministic: the same settings and time always give the same particles.
 */
export const particlesAt = (p: Particles3D, em: ParticleEmitter, t: number, out?: Float32Array): { count: number; data: Float32Array } => {
  const cap = particleCapacity(p, em);
  const data = out && out.length >= cap * PARTICLE_STRIDE ? out : new Float32Array(cap * PARTICLE_STRIDE);
  const rate = Math.max(0.01, p.rate);
  const life = maxLife(p, em);
  // Snow is already falling when the layer starts.
  const begin = p.kind === "snow" ? p.start - life : p.start;
  const end = p.stop ?? Infinity;
  const nLo = Math.max(0, Math.floor((t - life - begin) * rate) - 1);
  const nHi = Math.floor((Math.min(t, end) - begin) * rate);
  let count = 0;
  const seed = p.seed >>> 0;
  for (let n = nLo; n <= nHi && count < cap; n++) {
    const r = (k: number) => rand01(seed, n, k);
    const born = begin + (n + r(0)) / rate;
    if (born > end || born > t) continue;
    const age = t - born;
    let x: number, y: number, z: number, size: number, rgb: [number, number, number], alpha: number;
    let angle = 0, tilt = 0, stretch = 1;
    if (p.kind === "snow") {
      const vy = p.speed * (0.6 + 0.8 * r(4));
      const top = em.H + 0.4;
      const span = p.from ? em.bounds : { x0: -em.W / 2 - 1, x1: em.W / 2 + 1 };
      x = span.x0 - 0.3 + (span.x1 - span.x0 + 0.6) * r(6) + p.wind * age + 0.25 * Math.sin(age * (0.8 + 0.8 * r(7)) + 6.283 * r(8));
      y = top - vy * age;
      if (y < -0.2) continue;
      z = 0.15 + 2.5 * r(5);
      size = p.size * (0.5 + r(9));
      rgb = mixColors(p.colors, 0);
      alpha = 0.9;
    } else {
      const L = p.life * (0.6 + 0.8 * r(1));
      if (age > L) continue;
      const u = age / L;
      const [px, py] = emitterPoint(em, r(2), r(3), r(10));
      if (p.kind === "sparks") {
        const a = (r(4) - 0.5) * 2.4;
        const sp = p.speed * (0.5 + r(5));
        const v0 = [Math.sin(a) * sp, Math.cos(a) * sp * (0.6 + 0.4 * r(6)), sp * (0.2 + 0.6 * r(7))] as const;
        const k = 1.2;
        const d = dragged(k, age);
        const fall = (G / k) * (age - d);
        x = px + v0[0] * d + p.wind * (age - d);
        y = py + v0[1] * d - fall;
        z = 0.03 + v0[2] * d;
        const e = Math.exp(-k * age);
        const vx = v0[0] * e + p.wind * (1 - e), vy = v0[1] * e - (G / k) * (1 - e);
        angle = Math.atan2(vy, vx);
        stretch = 1 + (Math.hypot(vx, vy) * 0.035) / Math.max(0.005, p.size);
        size = p.size * (1 - 0.5 * u);
        rgb = mixColors(p.colors, u);
        alpha = Math.pow(1 - u, 1.5);
      } else if (p.kind === "embers") {
        const vy = p.speed * (0.4 + 0.8 * r(4));
        x = px + p.wind * age + 0.35 * Math.sin(age * (1.5 + 2 * r(5)) + 6.283 * r(6));
        y = py + vy * age;
        z = 0.05 + 0.5 * r(7) * u;
        const flicker = 0.55 + 0.45 * Math.sin(age * (9 + 8 * r(8)) + 6.283 * r(9));
        size = p.size * (0.6 + 0.8 * r(11)) * (1 - 0.3 * u);
        rgb = mixColors(p.colors, u);
        alpha = flicker * Math.min(1, age / 0.15) * (1 - u);
      } else {
        // Confetti: thrown up, quickly held back by the air, then fluttering down at about 1 m/s.
        const k = 3;
        const fallSpeed = 0.7 + 0.5 * r(16);
        const kg = G / fallSpeed;
        const v0 = [(r(4) - 0.5) * p.speed * 0.9, p.speed * (0.6 + 0.6 * r(5)), p.speed * (0.15 + 0.5 * r(6))] as const;
        const d = dragged(k, age);
        x = px + v0[0] * d + p.wind * (age - dragged(kg, age)) + 0.3 * Math.sin(age * (4 + 3 * r(8)) + 6.283 * r(9));
        y = py + v0[1] * d - fallSpeed * (age - dragged(kg, age));
        if (y < -0.2) continue;
        z = 0.05 + v0[2] * d;
        angle = 6.283 * r(11) + age * (r(12) - 0.5) * 8;
        tilt = 6.283 * r(13) + age * (3 + 6 * r(14));
        stretch = 1.6;
        size = p.size * (0.8 + 0.4 * r(15));
        rgb = [...p.colors[Math.floor(r(7) * p.colors.length) % p.colors.length]!].slice(0, 3) as [number, number, number];
        alpha = Math.min(1, (L - age) / 0.5);
      }
    }
    const o = count * PARTICLE_STRIDE;
    data[o] = x;
    data[o + 1] = y;
    data[o + 2] = z;
    data[o + 3] = size;
    data[o + 4] = rgb[0];
    data[o + 5] = rgb[1];
    data[o + 6] = rgb[2];
    data[o + 7] = Math.max(0, Math.min(1, alpha));
    data[o + 8] = angle;
    data[o + 9] = tilt;
    data[o + 10] = stretch;
    count++;
  }
  return { count, data };
};

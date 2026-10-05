/**
 * Camera-assisted alignment, end to end on a simulated house (SIMULATED, not physical): a facade with a
 * recessed door and a projecting gable, a projector, a phone camera 35 cm beside it with lens
 * distortion, and the house photo taken from somewhere else. The camera frames are rendered by ray
 * casting what each pattern lights; the solved alignment is compared with where each photo point
 * really lands in the projector.
 */
import { describe, expect, it } from "vitest";
import {
  areaReports,
  decodeStripes,
  estimateLens,
  fitCameraToPhoto,
  type Gray8,
  mapContentToOutput,
  mapPhotoToCamera,
  planPatterns,
  type ReferencePair,
  referenceProblems,
  solveAlignment,
  stripeLit,
  type Vec2,
} from "../src/index.ts";

type V3 = [number, number, number];

interface Cam {
  readonly c: V3;
  readonly R: number[]; // world → camera rotation, row-major 3x3
  readonly f: number;
  readonly cx: number;
  readonly cy: number;
  readonly k1: number;
  readonly w: number;
  readonly h: number;
}

const rot = (yawDeg: number, pitchDeg: number): number[] => {
  const a = (yawDeg * Math.PI) / 180, b = (pitchDeg * Math.PI) / 180;
  // yaw about Y, then pitch about X
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const Ry = [ca, 0, -sa, 0, 1, 0, sa, 0, ca];
  const Rx = [1, 0, 0, 0, cb, sb, 0, -sb, cb];
  const m = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) m[i * 3 + j] += Rx[i * 3 + k]! * Ry[k * 3 + j]!;
  return m;
};

const project = (cam: Cam, X: V3): Vec2 | null => {
  const d: V3 = [X[0] - cam.c[0], X[1] - cam.c[1], X[2] - cam.c[2]];
  const x = cam.R[0]! * d[0] + cam.R[1]! * d[1] + cam.R[2]! * d[2];
  const y = cam.R[3]! * d[0] + cam.R[4]! * d[1] + cam.R[5]! * d[2];
  const z = cam.R[6]! * d[0] + cam.R[7]! * d[1] + cam.R[8]! * d[2];
  if (z <= 0) return null;
  let u = x / z, v = y / z;
  const r2 = u * u + v * v;
  u *= 1 + cam.k1 * r2;
  v *= 1 + cam.k1 * r2;
  return [cam.cx + cam.f * u, cam.cy + cam.f * v];
};

/** Ray through a pixel (undistorting iteratively), in world coordinates. */
const ray = (cam: Cam, p: Vec2): V3 => {
  const ud = (p[0] - cam.cx) / cam.f, vd = (p[1] - cam.cy) / cam.f;
  let u = ud, v = vd;
  for (let k = 0; k < 6; k++) {
    const s = 1 + cam.k1 * (u * u + v * v);
    u = ud / s;
    v = vd / s;
  }
  // camera → world: R^T
  const R = cam.R;
  return [R[0]! * u + R[3]! * v + R[6]!, R[1]! * u + R[4]! * v + R[7]!, R[2]! * u + R[5]! * v + R[8]!];
};

// The house: Y down, Z away from the viewer. Wall at Z = 10, a door recessed 40 cm, a gable 40 cm proud.
interface Surface {
  readonly name: string;
  readonly z: number;
  readonly albedo: number;
  readonly inside: (x: number, y: number) => boolean;
}
const door = (x: number, y: number) => x > -0.5 && x < 0.5 && y > 0.6 && y < 3;
const gable = (x: number, y: number) => y < -1.2 && y > -3.6 && Math.abs(x) < (y + 3.6) * (3.5 / 2.4);
const SURFACES: Surface[] = [
  { name: "gable", z: 9.6, albedo: 0.75, inside: gable },
  { name: "door", z: 10.4, albedo: 0.45, inside: door },
  { name: "wall", z: 10, albedo: 0.8, inside: (x, y) => x > -4.5 && x < 4.5 && y > -1.2 && y < 3 && !door(x, y) },
];
const hit = (o: V3, d: V3): { X: V3; s: Surface } | null => {
  let best: { X: V3; s: Surface; t: number } | null = null;
  for (const s of SURFACES) {
    const t = (s.z - o[2]) / d[2];
    if (t <= 0) continue;
    const X: V3 = [o[0] + t * d[0], o[1] + t * d[1], s.z];
    if (!s.inside(X[0], X[1])) continue;
    if (!best || t < best.t) best = { X, s, t };
  }
  return best;
};

const PW = 1920, PH = 1080;
const projector: Cam = { c: [0, 0.6, 0], R: rot(0, 0), f: 2100, cx: PW / 2, cy: PH * 0.8, k1: 0.005, w: PW, h: PH };
const phone: Cam = { c: [0.35, 0.65, -0.1], R: rot(-2, 3), f: 1520, cx: 960, cy: 540, k1: -0.02, w: 1920, h: 1080 };
const photoCam: Cam = { c: [-1.6, 1.0, 0.5], R: rot(8, -2), f: 1150, cx: 800, cy: 500, k1: 0, w: 1600, h: 1000 };
const canvas = { width: 1600, height: 1000 };

/** Where a world point is lit from (the projector pixel), if the projector reaches it unblocked. */
const projectorPixelFor = (X: V3, s: Surface): Vec2 | null => {
  const p = project(projector, X);
  if (!p || p[0] < 0 || p[1] < 0 || p[0] >= PW || p[1] >= PH) return null;
  const back = hit(projector.c, ray(projector, p));
  return back && back.s === s ? p : null;
};

// What the phone sees: for each of 2×2 sub-pixels, the projector pixel lighting it (or none).
const SS = 2;
const camLookup = (() => {
  const out = new Float32Array(phone.w * phone.h * SS * SS * 3).fill(Number.NaN);
  for (let v = 0; v < phone.h; v++)
    for (let u = 0; u < phone.w; u++)
      for (let sv = 0; sv < SS; sv++)
        for (let su = 0; su < SS; su++) {
          const k = ((v * phone.w + u) * SS * SS + sv * SS + su) * 3;
          const h0 = hit(phone.c, ray(phone, [u + (su + 0.5) / SS, v + (sv + 0.5) / SS]));
          if (!h0) continue;
          out[k + 2] = h0.s.albedo * (0.9 + 0.2 * Math.sin(h0.X[0] * 7) * Math.sin(h0.X[1] * 5)); // texture
          const p = projectorPixelFor(h0.X, h0.s);
          if (!p) continue;
          out[k] = p[0];
          out[k + 1] = p[1];
        }
  return out;
})();

let seed = 7;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 4294967296 - 0.5) * 2;
};
const render = (lit: (x: number, y: number) => boolean): Gray8 => {
  const data = new Uint8Array(phone.w * phone.h);
  for (let i = 0; i < phone.w * phone.h; i++) {
    let s = 0;
    for (let k = 0; k < SS * SS; k++) {
      const b = (i * SS * SS + k) * 3;
      const alb = Number.isNaN(camLookup[b + 2]!) ? 0.05 : camLookup[b + 2]!;
      const px = camLookup[b]!;
      const on = !Number.isNaN(px) && lit(px, camLookup[b + 1]!);
      s += 18 * alb + (on ? 170 * alb : 0); // ambient + projector light
    }
    data[i] = Math.max(0, Math.min(255, Math.round(s / (SS * SS) + 3 * noise())));
  }
  return { width: phone.w, height: phone.h, data };
};

const plan = planPatterns(PW, PH, 4);
const frames = plan.patterns.map((pt) => (pt.kind === "black" ? render(() => false) : pt.kind === "white" ? render(() => true) : render((x, y) => stripeLit(pt, x, y, plan.block))));
const decoded = decodeStripes(plan, frames);
const lens = estimateLens(decoded.correspondences, { width: phone.w, height: phone.h });

// Landmarks: wall corners, door corners, gable apex and eaves, a few wall points; with ±1 px clicking error.
const LANDMARKS: V3[] = [
  [-4.4, -1.1, 10], [4.4, -1.1, 10], [4.4, 2.9, 10], [-4.4, 2.9, 10],
  [-0.49, 0.61, 10.4], [0.49, 0.61, 10.4], [0.49, 2.9, 10.4], [-0.49, 2.9, 10.4],
  [0, -3.5, 9.6], [-3.3, -1.3, 9.6], [3.3, -1.3, 9.6],
  [-2.5, 1.0, 10], [2.5, 1.0, 10],
];
const pairsFor = (idx: number[]): ReferencePair[] =>
  idx.map((i) => {
    const X = LANDMARKS[i]!;
    const c = project(phone, X)!;
    const q = project(photoCam, X)!;
    return { camera: [c[0] + noise(), c[1] + noise()], photo: [q[0] + noise(), q[1] + noise()] };
  });

/** The house areas, as traced on the photo. */
const photoPoly = (pts: V3[]) => pts.map((X) => project(photoCam, X)!);
const AREAS = [
  { id: "door", name: "Door", polygon: photoPoly([[-0.52, 0.58, 10.4], [0.52, 0.58, 10.4], [0.52, 3.02, 10.4], [-0.52, 3.02, 10.4]]) },
  { id: "gable", name: "Gable", polygon: photoPoly([[0, -3.65, 9.6], [3.6, -1.15, 9.6], [-3.6, -1.15, 9.6]]) },
];

/** Projector-pixel error over sample points of each surface, against the true projector pixel. */
const errors = (sol: NonNullable<ReturnType<typeof solveAlignment>>) => {
  const by: Record<string, number[]> = { wall: [], door: [], gable: [] };
  for (let j = 0; j < 60; j++)
    for (let i = 0; i < 96; i++) {
      const q: Vec2 = [(i + 0.5) * (canvas.width / 96), (j + 0.5) * (canvas.height / 60)];
      const h0 = hit(photoCam.c, ray(photoCam, q));
      if (!h0) continue;
      const pTrue = projectorPixelFor(h0.X, h0.s);
      if (!pTrue) continue;
      // Only where the phone could see it too (elsewhere nothing was measured).
      const c = project(phone, h0.X);
      if (!c || c[0] < 0 || c[1] < 0 || c[0] >= phone.w || c[1] >= phone.h) continue;
      const p = mapContentToOutput(sol.H, sol.calibration.mesh, PW, PH, q);
      by[h0.s.name]!.push(Math.hypot(p[0] - pTrue[0], p[1] - pTrue[1]));
    }
  const stat = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { median: s[Math.floor(s.length / 2)]!, p95: s[Math.floor(s.length * 0.95)]!, n: s.length };
  };
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, stat(v)])) as Record<string, { median: number; p95: number; n: number }>;
};

describe("auto-align (simulated house, phone beside the projector)", () => {
  it("decodes where projector pixels land, at 4 px blocks", () => {
    console.log("lens:", JSON.stringify(lens));
    console.log("decode:", { cell: decoded.cell, resolution: decoded.resolution, decodedShare: decoded.decodedShare.toFixed(2), correspondences: decoded.correspondences.length, litShare: decoded.litShare.toFixed(2), edge: decoded.litAtEdge });
    expect(decoded.resolution).toEqual({ x: 4, y: 4 });
    expect(decoded.decodedShare).toBeGreaterThan(0.35);
    expect(decoded.correspondences.length).toBeGreaterThan(3000);
  });

  it("with only the 4 wall corners, the main wall is right and off-plane surfaces are flagged by their error", () => {
    const g = fitCameraToPhoto(pairsFor([0, 1, 2, 3]), lens.lens, AREAS, { photo: canvas })!;
    const sol = solveAlignment(decoded.correspondences, g, { output: { width: PW, height: PH }, canvas })!;
    const e = errors(sol);
    console.log("4 points:", JSON.stringify(e));
    expect(e.wall!.median).toBeLessThan(3);
  });

  it("with points on the door and gable too, every surface lands within a few projector pixels", () => {
    const pairs = pairsFor([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const g = fitCameraToPhoto(pairs, lens.lens, AREAS, { photo: canvas })!;
    console.log("camera→photo:", g.method, g.surfaces.map((x) => `${x.id}:${x.kind}`).join(" "));
    expect(g.surfaces.length).toBe(2);
    const sol = solveAlignment(decoded.correspondences, g, { output: { width: PW, height: PH }, canvas })!;
    const e = errors(sol);
    console.log("13 points:", JSON.stringify(e), "fit:", JSON.stringify(sol.fit), "LOO photo px:", g.looError.map((x) => x?.toFixed(1)).join(" "));
    expect(e.wall!.median).toBeLessThan(2);
    expect(e.door!.median).toBeLessThan(2);
    expect(e.gable!.median).toBeLessThan(2);
    expect(Math.max(e.wall!.p95, e.door!.p95, e.gable!.p95)).toBeLessThan(4);
    // The per-area report flags nothing as off when the areas were measured.
    const reps = areaReports(AREAS, sol, g, { output: { width: PW, height: PH }, canvas });
    console.log("areas:", JSON.stringify(reps));
    // The gable is fully lit and measured; the door's lower half is below this projector's picture
    // (lens shift up), which the report must say rather than call it aligned.
    expect(reps.find((r) => r.id === "gable")!.status).toBe("good");
    expect(reps.find((r) => r.id === "door")!.inPicture).toBeLessThan(0.6);
    expect(reps.find((r) => r.id === "door")!.status).not.toBe("good");
    // Photo → camera drawing round-trips.
    const q = pairs[5]!.photo;
    const c = mapPhotoToCamera(g, q)!;
    expect(Math.hypot(c[0] - pairs[5]!.camera[0], c[1] - pairs[5]!.camera[1])).toBeLessThan(3);
  });

  it("refuses badly placed reference points", () => {
    const line: ReferencePair[] = [0, 1, 2, 3].map((i) => ({ camera: [100 + i * 50, 200], photo: [100 + i * 60, 300 + i] }));
    expect(referenceProblems(line, canvas).length).toBeGreaterThan(0);
    expect(referenceProblems(pairsFor([0, 1]), canvas)[0]).toMatch(/at least 4/);
  });

  it("reports no alignment when the projector isn't seen", () => {
    const dark = plan.patterns.map(() => render(() => false));
    const d = decodeStripes(plan, dark);
    expect(d.correspondences.length).toBe(0);
    const g = fitCameraToPhoto(pairsFor([0, 1, 2, 3]))!;
    expect(solveAlignment(d.correspondences, g, { output: { width: PW, height: PH }, canvas })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  areaScene,
  createRegistry,
  emitterPoint,
  emptyProject,
  FRACTURE_PRESETS,
  GLASS,
  glassShards,
  History,
  newComposition,
  PARTICLE_PRESETS,
  PARTICLE_STRIDE,
  particleCapacity,
  particleEmitter,
  type Particles3D,
  particlesAt,
  polygonPath,
  type Region,
  resolveScene3D,
  type Venue,
} from "../src/index.ts";

const rect = (x: number, y: number, w: number, h: number) => polygonPath([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
const canvas = { width: 1000, height: 500 };

const setup = () => {
  const regions: Record<string, Region> = {
    door: { id: "door", name: "Door", kind: "door", tags: [], path: rect(400, 200, 100, 250) },
    wall: { id: "wall", name: "Wall", kind: "wall", tags: [], path: rect(100, 100, 800, 380) },
  };
  const venue: Venue = { id: "v", name: "House", kind: "flat", canvas, regionOrder: Object.keys(regions), regions, groups: {}, projectorOrder: [], projectors: {} };
  const h = new History(emptyProject("t"), createRegistry());
  h.apply([
    { type: "venue.add", args: { venue, makeActive: true } },
    { type: "comp.add", args: { comp: newComposition({ id: "s1", name: "Scene 1", width: 1000, height: 500, durationSeconds: 20, venueId: "v" }) } },
  ]);
  return h;
};

const make = (kind: Particles3D["kind"], regionIds: string[] | null): Particles3D => ({ ...PARTICLE_PRESETS[kind].settings, from: regionIds ? { role: "areas", regionIds } : null, seed: 7 });
const particles = (r: { count: number; data: Float32Array }) =>
  Array.from({ length: r.count }, (_, i) => Array.from(r.data.subarray(i * PARTICLE_STRIDE, (i + 1) * PARTICLE_STRIDE)));

describe("particles", () => {
  it("are born evenly over the areas they come from", () => {
    const h = setup();
    const em = particleEmitter(h.project, make("sparks", ["door"]), "v", canvas);
    // The door, in metres: x 4..5 → −1..0, y (from the bottom) 0.5..3.
    expect(em.bounds.x0).toBeCloseTo(-1, 5);
    expect(em.bounds.x1).toBeCloseTo(0, 5);
    expect(em.bounds.y0).toBeCloseTo(0.5, 5);
    expect(em.bounds.y1).toBeCloseTo(3, 5);
    let left = 0;
    for (let i = 0; i < 2000; i++) {
      const [x, y] = emitterPoint(em, (i * 0.618) % 1, (i * 0.414) % 1, (i * 0.732) % 1);
      expect(x).toBeGreaterThanOrEqual(-1 - 1e-9);
      expect(x).toBeLessThanOrEqual(1e-9);
      expect(y).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(y).toBeLessThanOrEqual(3 + 1e-9);
      if (x < -0.5) left++;
    }
    expect(left / 2000).toBeGreaterThan(0.4);
    expect(left / 2000).toBeLessThan(0.6);
  });

  it("are the same at the same moment however they're reached (seeking, export)", () => {
    const h = setup();
    const p = make("embers", ["door"]);
    const em = particleEmitter(h.project, p, "v", canvas);
    const a = particlesAt(p, em, 3.3);
    particlesAt(p, em, 9.1);
    const b = particlesAt(p, em, 3.3);
    expect(a.count).toBeGreaterThan(50);
    expect(particles(b)).toEqual(particles(a));
    // Another seed, other particles.
    expect(particles(particlesAt({ ...p, seed: 8 }, em, 3.3))).not.toEqual(particles(a));
  });

  it("sparks spray out, arc down and burn out", () => {
    const h = setup();
    const p = make("sparks", ["door"]);
    const em = particleEmitter(h.project, p, "v", canvas);
    const now = particles(particlesAt(p, em, 4));
    expect(now.length).toBeLessThanOrEqual(particleCapacity(p, em));
    expect(now.length).toBeGreaterThan(p.rate * p.life * 0.6);
    // Toward the audience, fading, and some already falling below where they started.
    expect(now.every((q) => q[2]! > 0)).toBe(true);
    expect(now.every((q) => q[7]! >= 0 && q[7]! <= 1)).toBe(true);
    expect(now.some((q) => q[1]! < 0.5)).toBe(true);
    // Streaks: stretched along their motion.
    expect(Math.max(...now.map((q) => q[10]!))).toBeGreaterThan(2);
    // None before they start.
    expect(particlesAt({ ...p, start: 2 }, em, 1.9).count).toBe(0);
  });

  it("snow is already falling when the layer starts, across the picture, and never below the ground", () => {
    const h = setup();
    const p = make("snow", null);
    const em = particleEmitter(h.project, p, "v", canvas);
    const at0 = particles(particlesAt(p, em, 0));
    expect(at0.length).toBeGreaterThan(200);
    const ys = at0.map((q) => q[1]!);
    expect(Math.min(...ys)).toBeLessThan(1);
    expect(Math.max(...ys)).toBeGreaterThan(4);
    expect(Math.min(...ys)).toBeGreaterThan(-0.25);
    const xs = at0.map((q) => q[0]!);
    expect(Math.min(...xs)).toBeLessThan(-4);
    expect(Math.max(...xs)).toBeGreaterThan(4);
  });

  it("confetti is one burst that flutters down", () => {
    const h = setup();
    const p = make("confetti", ["door"]);
    const em = particleEmitter(h.project, p, "v", canvas);
    const born = Math.floor(p.rate * (p.stop! - p.start));
    const mid = particles(particlesAt(p, em, 1));
    expect(mid.length).toBeGreaterThan(born * 0.9);
    expect(mid.length).toBeLessThanOrEqual(born + 2);
    // Up above the door at first; turning as it goes.
    expect(Math.max(...mid.map((q) => q[1]!))).toBeGreaterThan(3.5);
    expect(new Set(mid.map((q) => q[4]!.toFixed(2))).size).toBeGreaterThan(2);
    const later = particles(particlesAt(p, em, 4));
    const avg = (a: number[][]) => a.reduce((s, q) => s + q[1]!, 0) / a.length;
    expect(avg(later)).toBeLessThan(avg(mid));
  });

  it("are part of a 3D scene's resolved objects with their emitter", () => {
    const h = setup();
    const p = make("sparks", ["door"]);
    const scene = {
      id: "s",
      name: "Sparks",
      objectOrder: ["o"],
      objects: { o: { id: "o", name: "Sparks", kind: "particles" as const, visible: true, position: { value: [0, 0, 0] as [number, number, number] }, rotation: { value: [0, 0, 0] as [number, number, number] }, scale: { value: [100, 100, 100] as [number, number, number] }, particles: p } },
      gravity: [0, -9.81, 0] as [number, number, number],
      cameraDistance: 1.6,
    };
    h.apply({ type: "scene3d.add", args: { scene } });
    const r = resolveScene3D(h.project, h.project.scenes3d!["s"]!, { venueId: "v", canvas, fps: 30, frames: 150 });
    expect(r.physics).toBeNull();
    expect(r.objects[0]!.emitter?.bounds.x1).toBeCloseTo(0, 5);
  });
});

describe("breaking apart", () => {
  it("crumbles from the top down; explodes all at once and hard", () => {
    const h = setup();
    const resolve = (preset: keyof typeof FRACTURE_PRESETS) => {
      const scene = areaScene(h.project, { sceneId: preset, idPrefix: preset, name: preset, ref: { role: "areas", regionIds: ["door"] }, venueId: "v", canvas, collapse: true, fracture: FRACTURE_PRESETS[preset].fracture });
      return resolveScene3D(h.project, scene, { venueId: "v", canvas, fps: 30, frames: 150 }).physics!;
    };
    const crumble = resolve("crumble").bodies.filter((b) => b.kind === "fragment");
    const byHeight = [...crumble].sort((a, b) => b.p[1] - a.p[1]);
    const top = byHeight.slice(0, 5).map((b) => b.release!), bottom = byHeight.slice(-5).map((b) => b.release!);
    expect(Math.max(...top)).toBeLessThan(Math.min(...bottom));
    expect(Math.min(...crumble.map((b) => b.release!))).toBe(30);
    const explode = resolve("explode").bodies.filter((b) => b.kind === "fragment");
    expect(new Set(explode.map((b) => b.release)).size).toBe(1);
    expect(Math.max(...explode.map((b) => b.velocity![2]))).toBeGreaterThan(5);
    expect(explode.length).toBeGreaterThan(crumble.length * 0.4);
  });

  it("shatters like glass: shards from an impact point that cover the pane exactly, holes left empty", () => {
    const area = (p: readonly (readonly number[])[]) => Math.abs(p.reduce((s, q, i) => s + q[0]! * p[(i + 1) % p.length]![1]! - p[(i + 1) % p.length]![0]! * q[1]!, 0)) / 2;
    const pane: [number, number][] = [[0, 0], [300, 0], [300, 220], [0, 220]];
    const shards = glassShards(pane, [], 22, 1);
    expect(shards.length).toBeGreaterThan(60);
    // Tiny slivers (under 4 px²) are dropped; everything else is covered.
    expect(Math.abs(shards.reduce((s, p) => s + area(p), 0) / (300 * 220) - 1)).toBeLessThan(0.001);
    // Narrow wedges, not blocks: many shards are much longer than they are wide.
    const long = shards.filter((p) => {
      const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
      const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      return (span * span) / Math.max(1e-6, area(p)) > 5;
    });
    expect(long.length).toBeGreaterThan(shards.length * 0.4);
    expect(glassShards(pane, [], 22, 1)).toEqual(shards);
    const hole: [number, number][] = [[120, 80], [180, 80], [180, 140], [120, 140]];
    const holed = glassShards(pane, [hole], 22, 1);
    expect(Math.abs(holed.reduce((s, p) => s + area(p), 0) / (300 * 220 - 60 * 60) - 1)).toBeLessThan(0.001);
  });

  it("the glass preset is a thin, clear pane that breaks into shards with real physics", () => {
    const h = setup();
    const scene = areaScene(h.project, { sceneId: "g", idPrefix: "g", name: "g", ref: { role: "areas", regionIds: ["door"] }, venueId: "v", canvas, collapse: true, fracture: FRACTURE_PRESETS.shatter.fracture });
    const pane = scene.objects["g-area"]!;
    expect(pane.geometry).toMatchObject({ kind: "area", depth: GLASS.thicknessCm / 100 });
    expect(pane.material?.opacity).toBe(GLASS.opacity);
    const shards = resolveScene3D(h.project, scene, { venueId: "v", canvas, fps: 30, frames: 150 }).physics!.bodies.filter((b) => b.kind === "fragment");
    expect(shards.length).toBeGreaterThan(40);
  });
});

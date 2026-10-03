import { describe, expect, it } from "vitest";
import {
  areaScene,
  BLOCK_PRESETS,
  blockCells,
  blockPose,
  brickPieces,
  type Blocks3D,
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

describe("blocks", () => {
  const area = (p: readonly (readonly number[])[]) => Math.abs(p.reduce((s, q, i) => s + q[0]! * p[(i + 1) % p.length]![1]! - p[(i + 1) % p.length]![0]! * q[1]!, 0)) / 2;
  const wall: [number, number][] = [[0, 0], [400, 0], [400, 200], [0, 200]];

  it("cut the surface into a grid of cubes, full-height columns or full-width rows, with gaps", () => {
    const cubes = blockCells(wall, [], { shape: "cubes", size: 50, gap: 0 });
    expect(cubes.length).toBe(8 * 4);
    expect(Math.abs(cubes.reduce((s, c) => s + area(c), 0) / (400 * 200) - 1)).toBeLessThan(0.001);
    const gapped = blockCells(wall, [], { shape: "cubes", size: 50, gap: 4 });
    expect(gapped.reduce((s, c) => s + area(c), 0)).toBeCloseTo(32 * 46 * 46, -1);
    const cols = blockCells(wall, [], { shape: "columns", size: 50, gap: 0 });
    expect(cols.length).toBe(8);
    expect(cols.every((c) => Math.max(...c.map((q) => q[1])) - Math.min(...c.map((q) => q[1])) === 200)).toBe(true);
    expect(blockCells(wall, [], { shape: "rows", size: 50, gap: 0 }).length).toBe(4);
    // A window cut out of the wall stays empty.
    const holed = blockCells(wall, [[[100, 50], [200, 50], [200, 150], [100, 150]]], { shape: "cubes", size: 50, gap: 0 });
    expect(Math.abs(holed.reduce((s, c) => s + area(c), 0) / (400 * 200 - 100 * 100) - 1)).toBeLessThan(0.001);
  });

  it("move by rule in time: still before they start, flat again after, never into the wall unless asked", () => {
    const h = setup();
    const resolve = (blocks: Blocks3D) => {
      const scene = areaScene(h.project, { sceneId: "b", idPrefix: "b", name: "b", ref: { role: "areas", regionIds: ["wall"] }, venueId: "v", canvas, blocks });
      expect(scene.objects["b-area"]!.blocks).toEqual(blocks);
      return resolveScene3D(h.project, scene, { venueId: "v", canvas, fps: 30, frames: 300 }).objects.find((o) => o.object.id === "b-area")!.pieces;
    };
    const b = { ...BLOCK_PRESETS.pulse.blocks, startAt: 1, stopAt: 6, ramp: 1 };
    const pieces = resolve(b);
    expect(pieces.length).toBeGreaterThan(20);
    const at = (t: number, bb: Blocks3D = b) => pieces.map((_, i) => blockPose(bb, pieces, i, t));
    expect(at(0.5).every((p) => p.dz === 0 && p.angle === 0)).toBe(true);
    expect(at(6.2).every((p) => p.dz === 0)).toBe(true);
    const mid = [2, 2.4, 3.1, 3.7, 4.4].flatMap((t) => at(t));
    expect(mid.every((p) => p.dz >= 0 && p.dz <= b.amount / 100 + 1e-9)).toBe(true);
    expect(Math.max(...mid.map((p) => p.dz))).toBeGreaterThan(0.2);
    expect(at(3.3)).toEqual(at(3.3));
    const both = [2, 2.4, 3.1, 3.7, 4.4].flatMap((t) => at(t, { ...b, bothWays: true }));
    expect(Math.min(...both.map((p) => p.dz))).toBeLessThan(-0.1);
  });

  it("ripple from a point; checker moves neighbours opposite; slats turn", () => {
    const h = setup();
    const scene = areaScene(h.project, { sceneId: "r", idPrefix: "r", name: "r", ref: { role: "areas", regionIds: ["wall"] }, venueId: "v", canvas, blocks: BLOCK_PRESETS.ripple.blocks });
    const pieces = resolveScene3D(h.project, scene, { venueId: "v", canvas, fps: 30, frames: 300 }).objects.find((o) => o.object.id === "r-area")!.pieces;
    // A crest moves outward: the block where the push peaks gets farther from the centre over time.
    const ripple = { ...BLOCK_PRESETS.ripple.blocks, startAt: 0, ramp: 0, stopAt: null, bothWays: true };
    const cx = pieces.reduce((s, p) => s + p.center[0], 0) / pieces.length, cy = pieces.reduce((s, p) => s + p.center[1], 0) / pieces.length;
    const near = pieces.map((p, i) => [Math.hypot(p.center[0] - cx, p.center[1] - cy), i] as const).filter(([d]) => d < (ripple.wavelength / 100) * 0.5);
    const crestDistance = (t: number) => {
      const best = near.reduce((a, c) => (blockPose(ripple, pieces, c[1], t).dz > blockPose(ripple, pieces, a[1], t).dz ? c : a));
      return best[0];
    };
    const t0 = 2, dt = 0.25 / ripple.speed;
    expect(crestDistance(t0 + dt * 0.4)).toBeGreaterThanOrEqual(crestDistance(t0));
    const checker = { ...ripple, pattern: "checker" as const };
    const signs = pieces.map((_, i) => Math.sign(blockPose(checker, pieces, i, 2.2).dz));
    expect(new Set(signs).size).toBe(2);
    const slats = { ...BLOCK_PRESETS.slats.blocks, startAt: 0, ramp: 0 };
    const turned = pieces.map((_, i) => blockPose(slats, pieces, i, 2.2));
    expect(turned.every((p) => p.dz === 0 && p.axis === "y")).toBe(true);
    expect(Math.max(...turned.map((p) => Math.abs(p.angle)))).toBeGreaterThan(0.3);
  });
});

describe("bricks", () => {
  const wall: [number, number][] = [[0, 0], [600, 0], [600, 300], [0, 300]];
  const hole: [number, number][] = [[200, 100], [320, 100], [320, 220], [200, 220]];
  const area = (pts: readonly (readonly [number, number])[]) => Math.abs(pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * p[1], 0)) / 2;

  it("lays courses of blocks about `size` long and half as tall, every other course offset", () => {
    const bricks = brickPieces(wall, [], 80, 1);
    const tops = [...new Set(bricks.map((b) => Math.round(Math.min(...b.map((p) => p[1])))))].sort((a, b) => a - b);
    expect(tops.length).toBeGreaterThan(6);
    const rowH = tops[1]! - tops[0]!;
    expect(rowH).toBeGreaterThan(80 * 0.4);
    expect(rowH).toBeLessThan(80 * 0.6);
    // The joints of one course don't line up with the next (running bond).
    const joints = (top: number) => bricks.filter((b) => Math.round(Math.min(...b.map((p) => p[1]))) === top).map((b) => Math.round(Math.min(...b.map((p) => p[0])))).filter((x) => x > 5);
    const a = joints(tops[1]!), b = joints(tops[2]!);
    expect(a.some((x) => b.every((y) => Math.abs(x - y) > 10))).toBe(true);
    // Together they cover the wall, and the same seed gives the same bricks.
    expect(bricks.reduce((s, b) => s + area(b), 0)).toBeCloseTo(600 * 300, -2);
    expect(brickPieces(wall, [], 80, 1)).toEqual(bricks);
  });

  it("leaves openings empty", () => {
    const bricks = brickPieces(wall, [hole], 80, 2);
    const covered = bricks.reduce((s, b) => s + area(b), 0);
    expect(covered).toBeCloseTo(600 * 300 - 120 * 120, -2);
    // No brick covers the opening (its middle and corners just inside it).
    const inside = (poly: readonly (readonly [number, number])[], x: number, y: number) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    for (const [x, y] of [[260, 160], [205, 105], [315, 215], [205, 215], [315, 105]] as const) expect(bricks.some((b) => inside(b, x, y))).toBe(false);
  });

  it("is used when a wall breaks into bricks", () => {
    expect(brickPieces(wall, [], 10, 1).length).toBeLessThanOrEqual(600);
  });
});

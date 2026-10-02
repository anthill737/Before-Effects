import { describe, expect, it } from "vitest";
import {
  affectedByPatches,
  areaScene,
  createRegistry,
  emptyProject,
  fracture,
  History,
  newComposition,
  type Object3D,
  polygonPath,
  type Region,
  resolveScene3D,
  type Scene3D,
  type Venue,
} from "@be/core";
import { PhysicsEngine } from "../src/physics.ts";

const rect = (x: number, y: number, w: number, h: number) => polygonPath([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
const area = (p: readonly (readonly [number, number])[]) => Math.abs(p.reduce((s, v, i) => s + v[0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * v[1], 0) / 2);

const setup = () => {
  const wall: Region = { id: "wall", name: "Wall", kind: "wall", tags: [], path: rect(400, 300, 800, 500), holes: [rect(700, 450, 180, 160)] };
  const venue: Venue = { id: "v", name: "House", kind: "flat", canvas: { width: 1600, height: 1000 }, regionOrder: ["wall"], regions: { wall }, groups: {}, projectorOrder: [], projectors: {} };
  const h = new History(emptyProject("t"), createRegistry());
  h.apply([
    { type: "venue.add", args: { venue, makeActive: true } },
    { type: "comp.add", args: { comp: newComposition({ id: "s1", name: "Scene 1", width: 1600, height: 1000, durationSeconds: 8, venueId: "v" }) } },
  ]);
  const scene = areaScene(h.project, { sceneId: "w3d", idPrefix: "w", name: "Wall 3D", ref: { role: "areas", regionIds: ["wall"] }, venueId: "v", canvas: venue.canvas, collapse: true });
  h.apply({ type: "scene3d.add", args: { scene } });
  return h;
};

const resolve = (h: History, frames = 241) => resolveScene3D(h.project, h.project.scenes3d!.w3d!, { venueId: "v", canvas: { width: 1600, height: 1000 }, fps: 30, frames });
const wallObj = (h: History) => h.project.scenes3d!.w3d!.objects["w-area"]!;
const update = (h: History, objectId: string, changes: Partial<Object3D>) => h.apply({ type: "object3d.update", args: { sceneId: "w3d", objectId, changes } });

describe("3D areas, fracture and physics", () => {
  it("breaks an area into pieces that cover it, leaving its holes empty", () => {
    const outline: Array<[number, number]> = [[400, 300], [1200, 300], [1200, 800], [400, 800]];
    const hole: Array<[number, number]> = [[700, 450], [880, 450], [880, 610], [700, 610]];
    const pieces = fracture(outline, [hole], 70, 1);
    expect(pieces.length).toBeGreaterThan(40);
    const covered = pieces.reduce((s, p) => s + area(p), 0);
    expect(covered).toBeCloseTo(area(outline) - area(hole), -1);
    // Same input, same pieces.
    expect(JSON.stringify(fracture(outline, [hole], 70, 1))).toBe(JSON.stringify(pieces));
    expect(JSON.stringify(fracture(outline, [hole], 70, 2))).not.toBe(JSON.stringify(pieces));
  });

  it("keys physics on what affects motion, not on lights", () => {
    const h = setup();
    const a = resolve(h);
    expect(a.physics).not.toBeNull();
    const piecesBefore = a.objects.find((o) => o.object.id === "w-area")!.pieces;
    update(h, "w-key", { position: { value: [-8, 9, 7], spatial: true } });
    const b = resolve(h);
    expect(b.physics!.key).toBe(a.physics!.key);
    // Editing a light never rebuilds the pieces.
    expect(b.objects.find((o) => o.object.id === "w-area")!.pieces).toBe(piecesBefore);
    update(h, "w-area", { physics: { ...wallObj(h).physics!, friction: 0.1 } });
    expect(resolve(h).physics!.key).not.toBe(a.physics!.key);
  });

  it("drops the pieces onto the ledge, the same way every time, and rebuilds the wall", async () => {
    const h = setup();
    const r = resolve(h);
    const p = r.physics!;
    const run = async () => new PhysicsEngine(null).ensure(p);
    const t0 = performance.now();
    const d1 = await run();
    const bakeMs = performance.now() - t0;
    const d2 = await run();
    expect(Buffer.from(d1.buffer).equals(Buffer.from(d2.buffer))).toBe(true);

    const fr = wallObj(h).fracture!;
    const ledge = h.project.scenes3d!.w3d!.objects["w-ledge"]!;
    const ledgeTop = ledge.position.value[1] + (ledge.geometry as unknown as { size: number[] }).size[1]! / 2;
    const frags = p.bodies.filter((b) => b.kind === "fragment");
    const ys = (f: number) => frags.map((b) => d1[(f * p.movers + b.poseIndex) * 7 + 1]!);
    const zs = (f: number) => frags.map((b) => d1[(f * p.movers + b.poseIndex) * 7 + 2]!);
    const before = Math.round(fr.collapseAt * 30) - 1;
    const settled = Math.round(fr.rebuildAt! * 30) - 1;
    // Pieces start in place, then fall: most end up low, resting on the ledge or the ground (not through them).
    expect(Math.min(...ys(before))).toBeGreaterThan(ledgeTop);
    const low = ys(settled).filter((y) => y < ledgeTop + 0.6).length;
    expect(low / frags.length).toBeGreaterThan(0.6);
    expect(Math.min(...ys(settled))).toBeGreaterThan(-0.05);
    // Pushed toward the audience.
    expect(zs(settled).reduce((s, z) => s + z, 0) / frags.length).toBeGreaterThan(0.1);
    // After the rebuild every piece is back where it started.
    const end = p.frames - 1;
    const maxErr = Math.max(...frags.map((b) => Math.hypot(d1[(end * p.movers + b.poseIndex) * 7]! - b.p[0], d1[(end * p.movers + b.poseIndex) * 7 + 1]! - b.p[1], d1[(end * p.movers + b.poseIndex) * 7 + 2]! - b.p[2])));
    expect(maxErr).toBeLessThan(1e-3);
    console.log(`physics bake: ${frags.length} pieces, ${p.frames} frames × ${p.substeps} steps in ${bakeMs.toFixed(0)} ms`);
  }, 60_000);

  it("changes the motion when gravity, bounce or piece size change", async () => {
    const h = setup();
    const base = resolve(h).physics!;
    const motion = async () => new PhysicsEngine(null).ensure(resolve(h).physics!);
    const ref = await motion();
    const mid = Math.round(3 * 30) * base.movers * 7;
    const differs = (d: Float32Array) => !Buffer.from(d.buffer, mid * 4, base.movers * 28).equals(Buffer.from(ref.buffer, mid * 4, base.movers * 28));
    h.apply({ type: "scene3d.update", args: { sceneId: "w3d", changes: { gravity: [0, -3, 0] } } });
    expect(differs(await motion())).toBe(true);
    h.undo();
    update(h, "w-area", { physics: { ...wallObj(h).physics!, bounce: 0.8 } });
    expect(differs(await motion())).toBe(true);
    h.undo();
    update(h, "w-area", { fracture: { ...wallObj(h).fracture!, pieceSize: 140 } });
    expect(resolve(h).physics!.bodies.filter((b) => b.kind === "fragment").length).toBeLessThan(base.bodies.filter((b) => b.kind === "fragment").length);
  }, 60_000);

  it("marks the 3D layer's frames stale when its scene changes (preview cache)", () => {
    const h = setup();
    h.apply({ type: "layer.add", args: { compId: "s1", layer: { id: "l3d", name: "Wall 3D", source: { kind: "scene3d", sceneId: "w3d" }, startTime: 705_600_000, inPoint: 705_600_000, outPoint: 705_600_000 * 5, stretch: 1, enabled: true, solo: false, locked: false, audioEnabled: false, is3D: false, blendMode: "normal", transform: { anchor: { value: [0, 0, 0] }, position: { value: [0, 0, 0], spatial: true }, scale: { value: [100, 100, 100] }, rotation: { value: [0, 0, 0] }, opacity: { value: 100 } }, masks: [], effects: [] } } });
    const before = h.project;
    const tx = h.apply({ type: "object3d.update", args: { sceneId: "w3d", objectId: "w-key", changes: { position: { value: [5, 9, 6], spatial: true } } } })!;
    const r = affectedByPatches(before, h.project, tx.patches, "s1");
    expect(r.all).toBe(false);
    expect(r.ranges).toEqual([[705_600_000, 705_600_000 * 5]]);
  });

  it("gives a duplicated scene its own copy of the 3D scene", () => {
    const h = setup();
    h.apply({ type: "layer.add", args: { compId: "s1", layer: { id: "l3d", name: "Wall 3D", source: { kind: "scene3d", sceneId: "w3d" }, startTime: 0, inPoint: 0, outPoint: 705_600_000 * 8, stretch: 1, enabled: true, solo: false, locked: false, audioEnabled: false, is3D: false, blendMode: "normal", transform: { anchor: { value: [0, 0, 0] }, position: { value: [0, 0, 0], spatial: true }, scale: { value: [100, 100, 100] }, rotation: { value: [0, 0, 0] }, opacity: { value: 100 } }, masks: [], effects: [] } } });
    h.apply({ type: "scene.duplicate", args: { compId: "s1", newCompId: "s2", name: "Scene 2" } });
    const l2 = Object.values(h.project.compositions.s2!.layers)[0]!;
    const sid = l2.source.kind === "scene3d" ? l2.source.sceneId : "";
    expect(sid).not.toBe("w3d");
    update(h, "w-area", { name: "Changed in scene 1" });
    expect((h.project.scenes3d![sid] as Scene3D).objects["w-area"]!.name).toBe("Wall (3D)");
  });
});

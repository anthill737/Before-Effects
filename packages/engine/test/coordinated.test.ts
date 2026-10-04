/** Coordinated animation: riding on another object, letting go into physics, and breaking where hit. */
import { describe, expect, it } from "vitest";
import { areaScene, ballObject, boxObject, createRegistry, emptyProject, History, newComposition, objectPose, type Object3D, polygonPath, type Region, resolveScene3D, secondsToTime, type Vec3, type Venue } from "@be/core";
import { PhysicsEngine } from "../src/physics.ts";

const rect = (x: number, y: number, w: number, h: number) => polygonPath([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
const key = (id: string, seconds: number, v: Vec3) => ({ id, t: secondsToTime(seconds), v, in: "linear" as const, out: "linear" as const });
const moving = (from: Vec3, to: Vec3, seconds: number) => ({ value: from, spatial: true, keyframes: [key("a", 0, from), key("b", seconds, to)] });

/** A house wall 8 m wide (x −4…4), 2–7 m up, at the building front; canvas 16 × 10 m. */
const setup = (extra: Object3D[], wallChanges: Partial<Object3D> = {}) => {
  const wall: Region = { id: "wall", name: "Wall", kind: "wall", tags: [], path: rect(400, 300, 800, 500), holes: [] };
  const venue: Venue = { id: "v", name: "House", kind: "flat", canvas: { width: 1600, height: 1000 }, regionOrder: ["wall"], regions: { wall }, groups: {}, projectorOrder: [], projectors: {} };
  const h = new History(emptyProject("t"), createRegistry());
  h.apply([
    { type: "venue.add", args: { venue, makeActive: true } },
    { type: "comp.add", args: { comp: newComposition({ id: "s1", name: "Scene 1", width: 1600, height: 1000, durationSeconds: 8, venueId: "v" }) } },
  ]);
  const scene = areaScene(h.project, { sceneId: "w3d", idPrefix: "w", name: "Wall 3D", ref: { role: "areas", regionIds: ["wall"] }, venueId: "v", canvas: venue.canvas, collapse: true });
  h.apply({ type: "scene3d.add", args: { scene } });
  const w = h.project.scenes3d!.w3d!.objects["w-area"]!;
  h.apply({ type: "object3d.update", args: { sceneId: "w3d", objectId: "w-area", changes: { fracture: { ...w.fracture!, rebuildAt: null }, ...wallChanges } } });
  for (const o of extra) h.apply({ type: "object3d.add", args: { sceneId: "w3d", object: o } });
  return h;
};
const resolve = (h: History) => resolveScene3D(h.project, h.project.scenes3d!.w3d!, { venueId: "v", canvas: { width: 1600, height: 1000 }, fps: 30, frames: 241 });
const poseOf = (data: Float32Array, movers: number, f: number, i: number): Vec3 => [data[(f * movers + i) * 7]!, data[(f * movers + i) * 7 + 1]!, data[(f * movers + i) * 7 + 2]!];

describe("coordinated animation", () => {
  it("lets a thrown ball go with the speed it had: it keeps flying", async () => {
    // Animated from x −3 to 0 over 1 s (3 m/s) at 6 m up, letting go at 1 s.
    const ball: Object3D = { ...ballObject("ball", "Ball", 0.2, [-3, 6, 3], { body: "dynamic", mass: 2, friction: 0.5, bounce: 0.2, releaseAt: 1 }), position: moving([-3, 6, 3], [0, 6, 3], 1) };
    const r = resolve(setup([ball], { physics: undefined }));
    const body = r.physics!.bodies.find((b) => b.kind === "released")!;
    expect(body.release).toBe(30);
    expect(body.velocity![0]).toBeCloseTo(3, 1);
    const data = await new PhysicsEngine(null).ensure(r.physics!);
    const i = r.objects.find((o) => o.object.id === "ball")!.poseIndex;
    // On its path before letting go, then still moving right (and starting to fall).
    expect(poseOf(data, r.physics!.movers, 15, i)[0]).toBeCloseTo(-1.5, 1);
    const a = poseOf(data, r.physics!.movers, 36, i);
    expect(a[0]).toBeGreaterThan(0.45);
    expect(a[0]).toBeLessThan(0.75);
    expect(a[1]).toBeLessThan(6);
  });

  it("carries a pumpkin on a moving carrier, then lets it go with the carrier's speed", async () => {
    const carrier: Object3D = { ...boxObject("carrier", "Carrier", [0.4, 0.4, 0.4], [-2, 3, 4]), position: moving([-2, 3, 4], [2, 3, 4], 2) };
    const pumpkin: Object3D = { ...ballObject("pumpkin", "Pumpkin", 0.3, [0, 0.5, 0], { body: "dynamic", mass: 5, friction: 0.5, bounce: 0.1, releaseAt: 1 }), attach: { to: "carrier", until: 1 } };
    const h = setup([carrier, pumpkin], { physics: undefined });
    const sc = h.project.scenes3d!.w3d!;
    // Riding: half a metre above the carrier wherever it is.
    expect(objectPose(sc, sc.objects.pumpkin!, secondsToTime(0.5)).place([0, 0, 0])).toEqual([-1, 3.5, 4]);
    const r = resolve(h);
    const body = r.physics!.bodies.find((b) => b.kind === "released")!;
    expect(body.velocity![0]).toBeCloseTo(2, 1); // the carrier moves at 2 m/s
    const data = await new PhysicsEngine(null).ensure(r.physics!);
    const i = r.objects.find((o) => o.object.id === "pumpkin")!.poseIndex;
    const at45 = poseOf(data, r.physics!.movers, 45, i);
    expect(at45[0]).toBeGreaterThan(0.7); // kept going right after letting go at x 0
    expect(at45[1]).toBeLessThan(3.5); // and falls
  });

  it("breaks a wall only where a pumpkin hits it, carrying the pieces inward, the same way every time", async () => {
    // A pumpkin flying straight at a heavy brick wall (from 5 m out, 10 m/s), let go at once.
    const pumpkin: Object3D = { ...ballObject("pumpkin", "Pumpkin", 0.35, [1, 4.5, 5], { body: "dynamic", mass: 25, friction: 0.5, bounce: 0.1, releaseAt: 0.1 }), position: moving([1, 4.5, 6], [1, 4.5, 5], 0.1) };
    const h = setup([pumpkin]);
    const w = h.project.scenes3d!.w3d!.objects["w-area"]!;
    h.apply({ type: "object3d.update", args: { sceneId: "w3d", objectId: "w-area", changes: { physics: { ...w.physics!, mass: 1800 }, fracture: { ...w.fracture!, trigger: "impact", impactRadius: 0.9, impactSpeed: 3, collapseAt: 0, rebuildAt: null } } } });
    const r = resolve(h);
    const frags = r.physics!.bodies.map((b, i) => [b, i] as const).filter(([b]) => b.kind === "fragment");
    expect(frags.length).toBeGreaterThan(20);
    expect(frags.every(([b]) => b.impact && b.release === undefined)).toBe(true);
    const run = () => new PhysicsEngine(null).ensure(r.physics!);
    const data = await run();
    const m = r.physics!.movers;
    const end = 240;
    const moved = frags.filter(([b]) => {
      const e = poseOf(data, m, end, b.poseIndex);
      return Math.hypot(e[0] - b.p[0], e[1] - b.p[1], e[2] - b.p[2]) > 0.05;
    });
    // Some pieces broke out — around the hit — and most of the wall stands.
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.length).toBeLessThan(frags.length / 2);
    // The first impact frees only the pieces around the hit (the pumpkin can knock more out later,
    // dropping inside the wall).
    const movedBy = (f: number) => frags.filter(([b]) => {
      const e = poseOf(data, m, f, b.poseIndex);
      return Math.hypot(e[0] - b.p[0], e[1] - b.p[1], e[2] - b.p[2]) > 0.01;
    });
    let first = 0;
    while (first < end && movedBy(first).length === 0) first++;
    const atImpact = movedBy(first + 2);
    expect(first).toBeGreaterThan(8);
    expect(first).toBeLessThan(30);
    expect(atImpact.length).toBeGreaterThan(0);
    // Measured from where the pumpkin really is (it drops about a metre on the way).
    const pi = r.objects.find((o) => o.object.id === "pumpkin")!.poseIndex;
    const hit = poseOf(data, m, first, pi);
    expect(hit[1]).toBeLessThan(4.5);
    for (const [b] of atImpact) expect(Math.hypot(b.p[0] - hit[0], b.p[1] - hit[1])).toBeLessThan(1.0);
    // Inward: the broken pieces went behind the building front, and the pumpkin carried on through.
    const inward = moved.filter(([b]) => poseOf(data, m, end, b.poseIndex)[2] < b.p[2] - 0.1);
    expect(inward.length).toBeGreaterThanOrEqual(Math.ceil(moved.length * 0.8));
    expect(poseOf(data, m, end, pi)[2]).toBeLessThan(-0.5);
    // Nothing breaks before the pumpkin arrives (it's 5 m away at 10 m/s: about half a second).
    const early = frags.filter(([b]) => {
      const e = poseOf(data, m, 8, b.poseIndex);
      return Math.hypot(e[0] - b.p[0], e[1] - b.p[1], e[2] - b.p[2]) > 0.01;
    });
    expect(early.length).toBe(0);
    // Deterministic.
    const again = await run();
    expect(Buffer.from(again.buffer).equals(Buffer.from(data.buffer))).toBe(true);
  });
});

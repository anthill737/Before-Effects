/** 3D models in a shared scene: their collider from the measured hull, and each object's own start under physics. */
import { describe, expect, it } from "vitest";
import { areaScene, type Asset, createRegistry, emptyProject, History, modelObject, newComposition, type ModelInfo, polygonPath, type Region, resolveScene3D, type Venue } from "@be/core";
import { PhysicsEngine } from "../src/physics.ts";

const rect = (x: number, y: number, w: number, h: number) => polygonPath([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);

/** A 0.6 m cube standing on its base (y 0…0.6), as a model's measurements would describe it. */
const cubeInfo: ModelInfo = {
  bounds: [-0.3, 0, -0.3, 0.3, 0.6, 0.3],
  hull: [-0.3, 0, -0.3, 0.3, 0, -0.3, -0.3, 0.6, -0.3, 0.3, 0.6, -0.3, -0.3, 0, 0.3, 0.3, 0, 0.3, -0.3, 0.6, 0.3, 0.3, 0.6, 0.3],
  meshes: 1,
  triangles: 12,
  animations: 0,
  lights: 0,
};

const setup = (info?: ModelInfo) => {
  const wall: Region = { id: "wall", name: "Wall", kind: "wall", tags: [], path: rect(400, 300, 800, 500), holes: [] };
  const venue: Venue = { id: "v", name: "House", kind: "flat", canvas: { width: 1600, height: 1000 }, regionOrder: ["wall"], regions: { wall }, groups: {}, projectorOrder: [], projectors: {} };
  const h = new History(emptyProject("t"), createRegistry());
  const asset: Asset = { id: "m1", kind: "model", name: "Crate", path: "crate.glb", meta: info ? { model: info } : {} };
  h.apply([
    { type: "venue.add", args: { venue, makeActive: true } },
    { type: "comp.add", args: { comp: newComposition({ id: "s1", name: "Scene 1", width: 1600, height: 1000, durationSeconds: 8, venueId: "v" }) } },
    { type: "asset.add", args: { asset } },
  ]);
  // The wall breaks at 2 s; a model dropped from 6 m above the ground falls from the start.
  const scene = areaScene(h.project, { sceneId: "w3d", idPrefix: "w", name: "Wall 3D", ref: { role: "areas", regionIds: ["wall"] }, venueId: "v", canvas: venue.canvas, collapse: true });
  h.apply({ type: "scene3d.add", args: { scene } });
  const wallObj = h.project.scenes3d!.w3d!.objects["w-area"]!;
  h.apply({ type: "object3d.update", args: { sceneId: "w3d", objectId: "w-area", changes: { fracture: { ...wallObj.fracture!, collapseAt: 2 } } } });
  const crate = { ...modelObject("crate", "Crate", "m1", info, [3, 6, 1.5]), physics: { body: "dynamic" as const, mass: 20, friction: 0.6, bounce: 0.1 } };
  h.apply({ type: "object3d.add", args: { sceneId: "w3d", object: crate } });
  return h;
};
const resolve = (h: History) => resolveScene3D(h.project, h.project.scenes3d!.w3d!, { venueId: "v", canvas: { width: 1600, height: 1000 }, fps: 30, frames: 241 });

describe("3D models in a shared scene", () => {
  it("gives a measured model a hull collider, scaled with it, and lets it fall and land", async () => {
    const h = setup(cubeInfo);
    const r = resolve(h);
    const crate = r.objects.find((o) => o.object.id === "crate")!;
    expect(crate.poseIndex).toBeGreaterThanOrEqual(0);
    const body = r.physics!.bodies.find((b) => b.poseIndex === crate.poseIndex)!;
    expect(body.kind).toBe("dynamic");
    expect(body.shape.kind).toBe("hull");
    // Twice the size: the hull doubles.
    h.apply({ type: "object3d.update", args: { sceneId: "w3d", objectId: "crate", changes: { scale: { value: [200, 200, 200] } } } });
    const big = resolve(h).physics!.bodies.find((b) => b.poseIndex === crate.poseIndex)!;
    const xs = (s: typeof body.shape) => (s.kind === "hull" ? s.points.filter((_, i) => i % 3 === 0) : []);
    expect(Math.max(...xs(big.shape)) - Math.min(...xs(big.shape))).toBeCloseTo(2 * (Math.max(...xs(body.shape)) - Math.min(...xs(body.shape))), 5);
    // It falls and comes to rest on the ground or the ledge: not through them.
    const data = await new PhysicsEngine(null).ensure(r.physics!);
    const yAt = (f: number) => data[(f * r.physics!.movers + crate.poseIndex) * 7 + 1]!;
    expect(yAt(0)).toBeCloseTo(6, 3);
    expect(yAt(120)).toBeLessThan(3);
    expect(yAt(240)).toBeGreaterThan(-0.05);
    expect(Math.abs(yAt(240) - yAt(220))).toBeLessThan(0.02);
  });

  it("starts each object's physics at its own moment: the model at once, the wall when it breaks", () => {
    const r = resolve(setup(cubeInfo));
    expect(r.objects.find((o) => o.object.id === "crate")!.motionFrom).toBe(0);
    // Before 2 s the wall keeps following its own animation, even though the model already moves.
    expect(r.objects.find((o) => o.object.id === "w-area")!.motionFrom).toBe(60);
  });

  it("gives a model that hasn't been measured no collider (rather than a wrong one)", () => {
    const r = resolve(setup(undefined));
    const crate = r.objects.find((o) => o.object.id === "crate")!;
    expect(crate.poseIndex).toBe(-1);
    expect(crate.motionFrom).toBeUndefined();
  });
});

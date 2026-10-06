/** A 3D scene seen through its own camera: projection, a model's camera, panels that break, light reach, active times. */
import { describe, expect, it } from "vitest";
import {
  type Asset,
  boxObject,
  createRegistry,
  emptyProject,
  eulerDegToQuat,
  FLICKS_PER_SECOND,
  History,
  lightObject,
  lightReach,
  type Object3D,
  objectPose,
  onPlaneThrough,
  panelObject,
  projectThrough,
  quatToEulerDeg,
  resolveScene3D,
  type Scene3D,
  sceneCameraAt,
  staticProp,
  type Vec3,
} from "../src/index.ts";

const canvas = { width: 1920, height: 1080 };
// A photo's camera: right of the garage, a little above its sill, looking back at the front (as fitted for cut 4).
const photoCam = { kind: "manual" as const, position: [8.03, 0.45, 7.53] as Vec3, rotation: [9.7, -15.8, 1.2] as Vec3, fovY: 47.07 };

const scene = (objects: Object3D[], extra: Partial<Scene3D> = {}): Scene3D => ({ id: "s", name: "S", objectOrder: objects.map((o) => o.id), objects: Object.fromEntries(objects.map((o) => [o.id, o])), gravity: [0, -9.8, 0], ...extra });

const withScene = (s: Scene3D, assets: Asset[] = []) => {
  const h = new History(emptyProject("t"), createRegistry());
  for (const a of assets) h.apply({ type: "asset.add", args: { asset: a } });
  h.apply({ type: "scene3d.add", args: { scene: s } });
  return h;
};

describe("a scene's own camera", () => {
  it("projects a point to the canvas and back onto its plane exactly", () => {
    const cam = { eye: photoCam.position, q: eulerDegToQuat(photoCam.rotation), fovY: photoCam.fovY };
    for (const p of [[0, 0, 0], [4.9, 2, 0], [2.4, 1, 0], [-0.9, 3.3, 0]] as Vec3[]) {
      const px = projectThrough(cam, canvas, p)!;
      expect(px).not.toBeNull();
      const back = onPlaneThrough(cam, canvas, [px.x, px.y], 0)!;
      expect(back[0]).toBeCloseTo(p[0], 6);
      expect(back[1]).toBeCloseTo(p[1], 6);
    }
    // Straight ahead lands in the middle of the canvas.
    const ahead: Vec3 = [cam.eye[0], cam.eye[1], cam.eye[2] - 5];
    const straight = { ...cam, q: eulerDegToQuat([0, 0, 0]) };
    const c = projectThrough(straight, canvas, ahead)!;
    expect(c.x).toBeCloseTo(960, 6);
    expect(c.y).toBeCloseTo(540, 6);
    // Behind the camera: nothing.
    expect(projectThrough(straight, canvas, [cam.eye[0], cam.eye[1], cam.eye[2] + 1])).toBeNull();
  });

  it("turns rotations into degrees and back", () => {
    for (const r of [[10, -20, 30], [-75, 40, 170], [0, 89, 0], [12.5, -15.8, 1.2]] as Vec3[]) {
      const q = eulerDegToQuat(r);
      const q2 = eulerDegToQuat(quatToEulerDeg(q));
      const dot = Math.abs(q[0] * q2[0] + q[1] * q2[1] + q[2] * q2[2] + q[3] * q2[3]);
      expect(dot).toBeCloseTo(1, 6);
    }
  });

  it("uses a model's camera where its object places the model", () => {
    // A camera 2 m up and 10 m out, looking along −z (identity turn), 40° tall.
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 10, 1];
    const asset = { id: "house", kind: "model", name: "house.glb", path: "house.glb", meta: { model: { bounds: [0, 0, 0, 1, 1, 1], hull: [], animations: 0, cameras: [{ name: "Photo camera", matrix: m, fovY: 40, near: 0.1, far: 100 }], nodes: ["Walls"] } } } as unknown as Asset;
    const house: Object3D = { id: "h", name: "House", kind: "mesh", visible: true, position: staticProp<Vec3>([1, 0, 0], true), rotation: staticProp<Vec3>([0, 90, 0]), scale: staticProp<Vec3>([100, 100, 100]), geometry: { kind: "model", assetId: "house" } };
    const h = withScene(scene([house], { camera: { kind: "model", objectId: "h" } }), [asset]);
    const s = h.project.scenes3d!.s!;
    const cam = sceneCameraAt(h.project, s, 0)!;
    const pose = objectPose(s, s.objects.h!, 0);
    const eye = pose.place([0, 2, 10]);
    expect(cam.eye.map((v, i) => v - eye[i]!).every((d) => Math.abs(d) < 1e-9)).toBe(true);
    // Turned with the model: it now looks along −x.
    const look = projectThrough(cam, canvas, [cam.eye[0] - 5, cam.eye[1], cam.eye[2]])!;
    expect(look.x).toBeCloseTo(960, 6);
    expect(look.y).toBeCloseTo(540, 6);
    expect(cam.fovY).toBe(40);
    // The scene says so when it's resolved; a scene without one keeps the show camera.
    expect(resolveScene3D(h.project, s, { canvas, fps: 30, frames: 30 }).cameraAt(0)).not.toBeNull();
    const plain = withScene(scene([house]), [asset]);
    expect(resolveScene3D(plain.project, plain.project.scenes3d!.s!, { canvas, fps: 30, frames: 30 }).cameraAt(0)).toBeNull();
  });

  it("only takes a model's camera from a model object of the scene", () => {
    const h = withScene(scene([boxObject("b", "Box", [1, 1, 1], [0, 0, 0])]));
    expect(() => h.apply({ type: "scene3d.update", args: { sceneId: "s", changes: { camera: { kind: "model", objectId: "b" } } } })).toThrow();
    h.apply({ type: "scene3d.update", args: { sceneId: "s", changes: { camera: photoCam } } });
    expect(h.project.scenes3d!.s!.camera).toEqual(photoCam);
    h.apply({ type: "scene3d.update", args: { sceneId: "s", changes: { camera: null } } });
    expect(h.project.scenes3d!.s!.camera).toBeUndefined();
  });
});

describe("lights that reach so far", () => {
  it("weakens as real light without a range, and fades smoothly to nothing at its range", () => {
    expect(lightReach(2)).toBeCloseTo(0.25, 9);
    expect(lightReach(2, 0, 0)).toBe(1);
    expect(lightReach(2, 0, 1)).toBeCloseTo(0.5, 9);
    expect(lightReach(5, 5)).toBe(0);
    expect(lightReach(6, 5)).toBe(0);
    const near = lightReach(1, 5), mid = lightReach(3, 5), far = lightReach(4.9, 5);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });
});

describe("panels: flat solids in the scene's own space", () => {
  const door = (extra: Partial<Object3D> = {}) => ({
    ...panelObject("door", "Garage door", [[0, 0], [4.9, 0], [4.9, 2], [0, 2]], 0.06, [0, 0, 0], { projected: true }),
    physics: { body: "dynamic" as const, mass: 300, friction: 0.7, bounce: 0.1 },
    fracture: { pieceSize: 40, seed: 3, collapseAt: 0, rebuildAt: null, rebuildSeconds: 2, push: 0, spin: 0.2, trigger: "impact" as const, impactRadius: 3, impactSpeed: 2 },
    ...extra,
  });

  it("breaks into pieces covering its outline, front at its position", () => {
    const h = withScene(scene([door()], { camera: photoCam }));
    const r = resolveScene3D(h.project, h.project.scenes3d!.s!, { canvas, fps: 30, frames: 90 });
    const pieces = r.objects[0]!.pieces;
    expect(pieces.length).toBeGreaterThan(20);
    expect(pieces.reduce((s, p) => s + p.area, 0)).toBeCloseTo(4.9 * 2, 2);
    expect(pieces.every((p) => p.center[2] === -0.03 && p.depth === 0.06)).toBe(true);
    expect(pieces.every((p) => p.center[0] > 0 && p.center[0] < 4.9 && p.center[1] > 0 && p.center[1] < 2)).toBe(true);
    // All of them can be hit; none lets go on its own.
    const frags = r.physics!.bodies.filter((b) => b.kind === "fragment");
    expect(frags.length).toBe(pieces.length);
    expect(frags.every((b) => b.impact && b.release === undefined && !b.path)).toBe(true);
  });

  it("re-cuts when its breaking changes, not when a light does", () => {
    const light = lightObject("key", "Key", { type: "directional" }, [5, 8, 6]);
    const h = withScene(scene([door(), light], { camera: photoCam }));
    const res = () => resolveScene3D(h.project, h.project.scenes3d!.s!, { canvas, fps: 30, frames: 90 });
    const a = res();
    h.apply({ type: "object3d.update", args: { sceneId: "s", objectId: "key", changes: { position: staticProp<Vec3>([2, 8, 6], true) } } });
    const b = res();
    expect(b.physics!.key).toBe(a.physics!.key);
    expect(b.objects[0]!.pieces).toBe(a.objects[0]!.pieces);
    h.apply({ type: "object3d.update", args: { sceneId: "s", objectId: "door", changes: { fracture: { ...door().fracture, pieceSize: 25 } } } });
    const c = res();
    expect(c.physics!.key).not.toBe(a.physics!.key);
    expect(c.objects[0]!.pieces.length).toBeGreaterThan(a.objects[0]!.pieces.length);
  });

  it("follows its animation until it's hit (shaken by blows), only as long as the animation runs", () => {
    const k = (t: number, v: Vec3) => ({ id: `k${t}`, t: t * FLICKS_PER_SECOND, v, in: "linear" as const, out: "linear" as const });
    const shaken = door({ position: { value: [0, 0, 0], spatial: true, keyframes: [k(0, [0, 0, 0]), k(0.5, [0, 0, 0.03]), k(1, [0, 0, 0])] } });
    const h = withScene(scene([shaken], { camera: photoCam }));
    const r = resolveScene3D(h.project, h.project.scenes3d!.s!, { canvas, fps: 30, frames: 300 });
    const frags = r.physics!.bodies.filter((b) => b.kind === "fragment");
    expect(frags.every((b) => !!b.path)).toBe(true);
    // A pose per frame until the animation stops (1 s), not for all 10 s.
    expect(frags[0]!.path!.length / 7).toBeLessThan(40);
    const mid = 15 * 7;
    expect(frags[0]!.path![mid + 2]! - frags[0]!.path![2]!).toBeCloseTo(0.03, 6);
  });

  it("gives obstacles the frames they're there", () => {
    const fist = { ...boxObject("fist", "Push", [0.4, 0.4, 0.4], [2.4, 1, -0.5], { body: "static", mass: 80, friction: 0.5, bounce: 0 }), activeFrom: 1, activeTo: 2 };
    const h = withScene(scene([door(), fist], { camera: photoCam }));
    const r = resolveScene3D(h.project, h.project.scenes3d!.s!, { canvas, fps: 30, frames: 90 });
    const body = r.physics!.bodies.find((b) => b.kind === "fixed")!;
    expect(body.active).toEqual([30, 60]);
  });
});

describe("a picture with light added to it", () => {
  it("shows the picture exactly with no light, and adds what lights bring", async () => {
    const { pictureMix } = await import("../src/index.ts");
    const m = pictureMix({ addLight: true, shading: 0.8 }, 0, [3, 3, 3]);
    expect(m.self).toBe(1);
    expect(m.lit).toEqual([0.8, 0.8, 0.8]);
    // Without it, unchanged: evened out by the picture's lighting.
    expect(pictureMix({ shading: 1 }, 0, [2, 2, 2])).toEqual({ lit: [2, 2, 2], self: 0 });
  });
});

/** A door panel broken outward by something pushing through it (an animated collider, there only for the hit). */
import { describe, expect, it } from "vitest";
import { boxObject, createRegistry, emptyProject, FLICKS_PER_SECOND, History, type Object3D, panelObject, resolveScene3D, type Scene3D, type Vec3 } from "@be/core";
import { PhysicsEngine } from "../src/physics.ts";

const canvas = { width: 1920, height: 1080 };
const k = (t: number, v: Vec3) => ({ id: `k${t}`, t: Math.round(t * FLICKS_PER_SECOND), v, in: "linear" as const, out: "linear" as const });

const build = (fist: Partial<Object3D>, door: Partial<Object3D> = {}) => {
  const d: Object3D = {
    ...panelObject("door", "Garage door", [[0, 0], [4.9, 0], [4.9, 2], [0, 2]], 0.06, [0, 0, 0], { projected: true }),
    physics: { body: "dynamic", mass: 300, friction: 0.7, bounce: 0.1 },
    fracture: { pieceSize: 45, seed: 2, collapseAt: 0, rebuildAt: null, rebuildSeconds: 2, push: 0, spin: 0.2, trigger: "impact", impactRadius: 1.2, impactSpeed: 2 },
    ...door,
  };
  // Something pushing out through the door from inside at 4 m/s from 1 s to 1.5 s.
  const f: Object3D = {
    ...boxObject("fist", "Push", [0.5, 0.6, 0.3], [2.4, 1.1, -0.6], { body: "static", mass: 80, friction: 0.5, bounce: 0 }),
    position: { value: [2.4, 1.1, -0.6], spatial: true, keyframes: [k(0, [2.4, 1.1, -0.6]), k(1, [2.4, 1.1, -0.6]), k(1.5, [2.4, 1.1, 1.4])] },
    ...fist,
  };
  const ground: Object3D = boxObject("ground", "Ground", [20, 0.2, 20], [2.4, -0.1, 0], { body: "static", mass: 1000, friction: 0.8, bounce: 0.1 });
  const scene: Scene3D = { id: "s", name: "S", objectOrder: ["door", "fist", "ground"], objects: { door: d, fist: f, ground }, gravity: [0, -9.8, 0], camera: { kind: "manual", position: [8, 0.45, 7.5], rotation: [9.7, -15.8, 1.2], fovY: 47 } };
  const h = new History(emptyProject("t"), createRegistry());
  h.apply({ type: "scene3d.add", args: { scene } });
  return resolveScene3D(h.project, h.project.scenes3d!.s!, { canvas, fps: 30, frames: 75 });
};

/** Each door piece's z at a frame. */
const zs = (data: Float32Array, movers: number, frame: number, pieces: number) => Array.from({ length: pieces }, (_, i) => data[(frame * movers + i) * 7 + 2]!);

describe("a door panel broken by a push from inside", () => {
  it("stays whole until the push arrives, then breaks out around it, the same way every time", async () => {
    const r = build({});
    const p = r.physics!;
    const n = r.objects[0]!.pieces.length;
    const d1 = await new PhysicsEngine(null).ensure(p);
    const d2 = await new PhysicsEngine(null).ensure(p);
    expect(Buffer.from(d1.buffer).equals(Buffer.from(d2.buffer))).toBe(true);
    const rest = zs(d1, p.movers, 0, n);
    // Whole before the push (frame 30 = 1 s).
    expect(zs(d1, p.movers, 29, n).every((z, i) => Math.abs(z - rest[i]!) < 1e-4)).toBe(true);
    // Half a second after the hit: pieces around it have gone out toward the audience; those far from it stayed.
    const after = zs(d1, p.movers, 60, n);
    const moved = after.filter((z, i) => z - rest[i]! > 0.3).length;
    expect(moved).toBeGreaterThan(3);
    expect(moved).toBeLessThan(n);
  });

  it("isn't broken by a push that isn't there yet", async () => {
    const r = build({ activeFrom: 2 });
    const p = r.physics!;
    const n = r.objects[0]!.pieces.length;
    const d = await new PhysicsEngine(null).ensure(p);
    const rest = zs(d, p.movers, 0, n);
    expect(zs(d, p.movers, 74, n).every((z, i) => Math.abs(z - rest[i]!) < 1e-3)).toBe(true);
  });

  it("shakes with its animation before the hit, then breaks", async () => {
    // Bulging 3 cm outward at 0.5 s (a blow from inside) before the push.
    const r = build({}, { position: { value: [0, 0, 0], spatial: true, keyframes: [k(0, [0, 0, 0]), k(0.5, [0, 0, 0.03]), k(0.7, [0, 0, 0])] } });
    const p = r.physics!;
    const n = r.objects[0]!.pieces.length;
    const d = await new PhysicsEngine(null).ensure(p);
    const rest = zs(d, p.movers, 0, n);
    const bulge = zs(d, p.movers, 15, n);
    expect(bulge.every((z, i) => Math.abs(z - rest[i]! - 0.03) < 2e-3)).toBe(true);
    expect(zs(d, p.movers, 25, n).every((z, i) => Math.abs(z - rest[i]!) < 2e-3)).toBe(true);
    expect(zs(d, p.movers, 60, n).filter((z, i) => z - rest[i]! > 0.3).length).toBeGreaterThan(3);
  });
});

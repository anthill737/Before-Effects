/** Fallen pieces come to rest (Fracture3D.settleAt): no rocking or creeping once they've stopped. */
import { describe, expect, it } from "vitest";
import { boxObject, createRegistry, emptyProject, FLICKS_PER_SECOND, History, type Object3D, panelObject, resolveScene3D, type Scene3D, type Vec3 } from "@be/core";
import { PhysicsEngine } from "../src/physics.ts";

const canvas = { width: 1920, height: 1080 };
const k = (t: number, v: Vec3) => ({ id: `k${t}`, t: Math.round(t * FLICKS_PER_SECOND), v, in: "linear" as const, out: "linear" as const });
const FPS = 30;
const SECONDS = 24;

const build = (settleAt: number | null) => {
  const d: Object3D = {
    ...panelObject("door", "Garage door", [[0, 0], [4.9, 0], [4.9, 2], [0, 2]], 0.06, [0, 0, 0], { projected: true }),
    physics: { body: "dynamic", mass: 2000, friction: 0.7, bounce: 0.15 },
    fracture: { pieceSize: 34, seed: 7, collapseAt: 0, rebuildAt: null, rebuildSeconds: 2, push: 0, spin: 0.6, trigger: "impact", impactRadius: 3.4, impactSpeed: 1.5, ...(settleAt !== null ? { settleAt } : {}) },
  };
  // Something pushing out through the door from inside at 4 m/s from 1 s to 1.5 s.
  const f: Object3D = {
    ...boxObject("fist", "Push", [0.5, 0.6, 0.3], [2.4, 1.1, -0.6], { body: "static", mass: 80, friction: 0.5, bounce: 0 }),
    position: { value: [2.4, 1.1, -0.6], spatial: true, keyframes: [k(0, [2.4, 1.1, -0.6]), k(1, [2.4, 1.1, -0.6]), k(1.5, [2.4, 1.1, 1.4])] },
    activeTo: 2,
  };
  const ground: Object3D = boxObject("ground", "Ground", [16, 0.2, 16], [2.45, -0.1, 0], { body: "static", mass: 1000, friction: 0.85, bounce: 0.1 });
  const scene: Scene3D = { id: "s", name: "S", objectOrder: ["door", "fist", "ground"], objects: { door: d, fist: f, ground }, gravity: [0, -9.81, 0], camera: { kind: "manual", position: [8, 0.45, 7.5], rotation: [9.7, -15.8, 1.2], fovY: 47 } };
  const h = new History(emptyProject("t"), createRegistry());
  h.apply({ type: "scene3d.add", args: { scene } });
  return resolveScene3D(h.project, h.project.scenes3d!.s!, { canvas, fps: FPS, frames: SECONDS * FPS });
};

/** How many pieces lying on the ground still move (> 2 mm or 0.5° a frame) at some frame from `from` on. */
const stillMoving = (data: Float32Array, movers: number, pieces: number, from: number, frames: number) => {
  let n = 0;
  for (let i = 0; i < pieces; i++) {
    const at = (f: number) => data.subarray((f * movers + i) * 7, (f * movers + i) * 7 + 7);
    if (at(from)[1]! < -1) continue; // fell off the ground's edge
    for (let f = from; f < frames - 1; f++) {
      const a = at(f), b = at(f + 1);
      const d = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
      const dot = Math.abs(a[3]! * b[3]! + a[4]! * b[4]! + a[5]! * b[5]! + a[6]! * b[6]!);
      if (d > 0.002 || 2 * Math.acos(Math.min(1, dot)) > (0.5 * Math.PI) / 180) {
        n++;
        break;
      }
    }
  }
  return n;
};

describe("fallen pieces that come to rest", () => {
  it("stay exactly where they lie from the settle time on, the same way every time", async () => {
    const r = build(6);
    const p = r.physics!;
    const n = r.objects[0]!.pieces.length;
    const d1 = await new PhysicsEngine(null).ensure(p);
    const d2 = await new PhysicsEngine(null).ensure(p);
    expect(Buffer.from(d1.buffer).equals(Buffer.from(d2.buffer))).toBe(true);
    // Some time after the settle time, nothing on the ground moves at all.
    expect(stillMoving(d1, p.movers, n, 9 * FPS, p.frames)).toBe(0);
    // It still broke and fell: pieces lie out in front of the wall.
    const out = Array.from({ length: n }, (_, i) => d1[(p.frames - 1) * p.movers * 7 + i * 7 + 2]!).filter((z) => z > 0.5).length;
    expect(out).toBeGreaterThan(10);
  });

  it("leaves the motion as it was when not asked for (where some pieces rock on for good)", async () => {
    const r = build(null);
    const a = r.physics!;
    expect(a.key).not.toBe(build(6).physics!.key);
    expect(a.bodies.some((x) => x.settle !== undefined)).toBe(false);
    const d = await new PhysicsEngine(null).ensure(a);
    expect(stillMoving(d, a.movers, r.objects[0]!.pieces.length, 9 * FPS, a.frames)).toBeGreaterThan(0);
  });
});

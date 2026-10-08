/** House lights: the flames on the building, shared by every 3D scene, flickering by show time. */
import { describe, expect, it } from "vitest";
import {
  builtinExpression,
  createRegistry,
  emptyProject,
  FLICKS_PER_SECOND,
  History,
  HOUSE_LIGHT_DEFAULTS,
  type HouseLight,
  houseLightLevel,
  lightObject,
  projectThrough,
  resolveScene3D,
  type Scene3D,
  sceneCameraAt,
  staticProp,
  type Venue,
} from "../src/index.ts";

const F = FLICKS_PER_SECOND;
const candle = (over: Partial<HouseLight> = {}): HouseLight => ({ id: "c1", name: "Candle", at: [400, 300], depth: 0.3, intensity: staticProp(2), ...HOUSE_LIGHT_DEFAULTS, ...over });

const project = (lights: HouseLight[], scene: Scene3D) => {
  const venue: Venue = { id: "v", name: "House", kind: "flat", canvas: { width: 1920, height: 1080 }, regionOrder: [], regions: {}, groups: {}, projectorOrder: [], projectors: {}, lights };
  const h = new History(emptyProject("t"), createRegistry());
  h.apply([
    { type: "venue.add", args: { venue, makeActive: true } },
    { type: "scene3d.add", args: { scene } },
  ]);
  return h.project;
};

describe("house lights", () => {
  it("flicker by show time, the same every time, smoothly", () => {
    const L = candle();
    const a = [0, 0.5, 1.25, 60.1, 912.4].map((s) => houseLightLevel(L, Math.round(s * F)));
    const b = [0, 0.5, 1.25, 60.1, 912.4].map((s) => houseLightLevel(L, Math.round(s * F)));
    expect(a).toEqual(b);
    // about its brightness, never more than its amount away, never negative
    const levels = Array.from({ length: 3000 }, (_, i) => houseLightLevel(L, Math.round((i / 30) * F)));
    expect(Math.min(...levels)).toBeGreaterThan(2 * (1 - L.flicker.amount) - 1e-9);
    expect(Math.max(...levels)).toBeLessThan(2 * (1 + L.flicker.amount) + 1e-9);
    const mean = levels.reduce((s, v) => s + v, 0) / levels.length;
    expect(Math.abs(mean - 2)).toBeLessThan(0.1);
    // a flicker, not noise: neighbouring frames are close
    const jumps = levels.slice(1).map((v, i) => Math.abs(v - levels[i]!));
    expect(Math.max(...jumps)).toBeLessThan(0.25);
  });

  it("rise and dip with a flame layer's opacity wiggle that uses the same seed and speed", () => {
    // a flame drawn at 80% opacity with wiggle(9.8, 24, 2, 1234); its light: amount 24/80
    const L = candle({ intensity: staticProp(1), flicker: { amount: 24 / 80, speed: 9.8, seed: 1234, octaves: 2 } });
    for (const s of [0.1, 3.3, 77.7, 640.05]) {
      const t = Math.round(s * F);
      const opacity = builtinExpression("wiggle(9.8, 24, 2, 1234)", 80, t) as number;
      expect(houseLightLevel(L, t)).toBeCloseTo(opacity / 80, 9);
    }
  });

  it("hold their keyframed brightness through a scene where they're out", () => {
    const L = candle({ intensity: { value: 0, keyframes: [{ id: "a", t: 0, v: 0, in: "hold", out: "hold" }, { id: "b", t: 10 * F, v: 3, in: "hold", out: "hold" }, { id: "c", t: 20 * F, v: 0, in: "hold", out: "hold" }] } });
    expect(houseLightLevel(L, 5 * F)).toBe(0);
    expect(houseLightLevel(L, 15 * F)).toBeGreaterThan(0);
    expect(houseLightLevel(L, 25 * F)).toBe(0);
  });

  it("follow a measured curve looping with its footage instead of the wiggle", () => {
    const L = candle({ intensity: staticProp(2), curve: { start: 10, fps: 10, values: [1, 1.2, 0.8, 1] } });
    expect(houseLightLevel(L, 10 * F)).toBeCloseTo(2, 9);
    expect(houseLightLevel(L, Math.round(10.1 * F))).toBeCloseTo(2.4, 9);
    expect(houseLightLevel(L, Math.round(10.15 * F))).toBeCloseTo(2.0, 9);
    expect(houseLightLevel(L, Math.round(10.5 * F))).toBeCloseTo(2.4, 9); // 0.4 s loop: 10.5 = 10.1
  });

  it("light every 3D scene of the venue, at their flame seen through the scene's camera", () => {
    const L = candle({ at: [1140, 815], depth: 0.6 });
    const withCam: Scene3D = { id: "s", name: "S", objectOrder: [], objects: {}, gravity: [0, -9.8, 0], camera: { kind: "manual", position: [8, 0.45, 7.5], rotation: [9.7, -15.8, 1.2], fovY: 47 } };
    const p = project([L], withCam);
    const r = resolveScene3D(p, p.scenes3d!.s!, { venueId: "v", canvas: { width: 1920, height: 1080 }, fps: 30, frames: 30 });
    const lights = r.objects.filter((o) => o.house);
    expect(lights.length).toBe(1);
    const pos = lights[0]!.object.position.value;
    expect(pos[2]).toBeCloseTo(0.6, 6);
    const seen = projectThrough(sceneCameraAt(p, withCam, 0)!, { width: 1920, height: 1080 }, pos)!;
    expect(seen.x).toBeCloseTo(1140, 3);
    expect(seen.y).toBeCloseTo(815, 3);
    // and in a scene through the show camera
    const showScene: Scene3D = { id: "s", name: "S", objectOrder: ["k"], objects: { k: lightObject("k", "Key", {}, [0, 5, 5]) }, gravity: [0, -9.8, 0] };
    const p2 = project([L], showScene);
    const r2 = resolveScene3D(p2, p2.scenes3d!.s!, { venueId: "v", canvas: { width: 1920, height: 1080 }, fps: 30, frames: 30 });
    expect(r2.objects.filter((o) => o.house).length).toBe(1);
  });

  it("light a scene as strongly as it asks (an older scene balanced differently)", () => {
    const scene: Scene3D = { id: "s", name: "S", objectOrder: [], objects: {}, gravity: [0, -9.8, 0] };
    const h = new History(project([candle()], scene), createRegistry());
    const resolve = () => resolveScene3D(h.project, h.project.scenes3d!.s!, { venueId: "v", canvas: { width: 1920, height: 1080 }, fps: 30, frames: 30 });
    expect(resolve().objects.find((o) => o.house)!.houseScale).toBe(1);
    h.apply({ type: "scene3d.update", args: { sceneId: "s", changes: { houseLightStrength: 0.4 } } });
    expect(h.project.scenes3d!.s!.houseLightStrength).toBe(0.4);
    expect(resolve().objects.find((o) => o.house)!.houseScale).toBe(0.4);
    h.apply({ type: "scene3d.update", args: { sceneId: "s", changes: { houseLightStrength: 1 } } });
    expect(h.project.scenes3d!.s!.houseLightStrength).toBeUndefined();
  });

  it("leave a scene that opts out alone", () => {
    const scene: Scene3D = { id: "s", name: "S", objectOrder: [], objects: {}, gravity: [0, -9.8, 0], houseLights: false };
    const p = project([candle()], scene);
    const r = resolveScene3D(p, p.scenes3d!.s!, { venueId: "v", canvas: { width: 1920, height: 1080 }, fps: 30, frames: 30 });
    expect(r.objects.some((o) => o.house)).toBe(false);
  });
});

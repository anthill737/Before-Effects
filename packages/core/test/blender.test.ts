import { describe, expect, it } from "vitest";
import {
  type BlenderLink,
  buildExchange,
  checkOwners,
  clothSheet,
  createRegistry,
  emptyProject,
  History,
  newComposition,
  polygonPath,
  preparedObstacles,
  LAYER_EFFECTS,
  newEffect,
  newLayer,
  staticProp as sp,
  type Region,
  type ResolvedScene3D,
  shatterPieces,
  staticProp,
  type Venue,
} from "../src/index.ts";

const rect = (x: number, y: number, w: number, h: number) => polygonPath([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
const canvas = { width: 600, height: 400 };
const output = { blend: "e.blend", frames: "frames", cache: "cache" };

const setup = () => {
  const regions: Record<string, Region> = {
    wall: { id: "wall", name: "Wall", kind: "wall", tags: [], path: rect(0, 0, 600, 400), holes: [rect(100, 100, 100, 200)] },
    w1: { id: "w1", name: "Window 1", kind: "window", tags: [], path: rect(100, 100, 100, 200) },
    w2: { id: "w2", name: "Window 2", kind: "window", tags: [], path: rect(300, 100, 100, 200) },
  };
  const venue: Venue = { id: "v", name: "House", kind: "flat", canvas, regionOrder: Object.keys(regions), regions, groups: {}, projectorOrder: [], projectors: {} };
  const h = new History(emptyProject("t"), createRegistry());
  h.apply([
    { type: "venue.add", args: { venue, makeActive: true } },
    { type: "comp.add", args: { comp: newComposition({ id: "s1", name: "Scene 1", width: 600, height: 400, durationSeconds: 20, venueId: "v" }) } },
  ]);
  return h;
};

const link = (kind: "smoke" | "liquid" | "cloth", regionIds: string[], extra: Partial<BlenderLink> = {}): BlenderLink => ({
  id: "b1",
  name: "Effect",
  origin: "effect",
  effect: { kind, regionIds, params: {} },
  compId: "s1",
  startSeconds: 1,
  seconds: 2,
  quality: "draft",
  ...extra,
});

describe("Blender exchange", () => {
  it("hands Blender the house as obstacles and the area as the effect's source, one owner each", () => {
    const h = setup();
    const x = buildExchange(h.project, link("smoke", ["w1"]), { venueId: "v", canvas, fps: 30, output });
    expect(x.frames).toBe(60);
    expect(x.render).toEqual({ width: 300, height: 200 });
    const byName = new Map(x.objects.map((o) => [o.name, o]));
    expect(byName.get("Emitter: Window 1")).toMatchObject({ owner: "blender", role: "emitter" });
    // The source area isn't also a wall in the way; everything else is, owned by Before Effects.
    expect(byName.has("Area: Window 1")).toBe(false);
    expect(byName.get("Area: Wall")).toMatchObject({ owner: "before-effects", role: "obstacle" });
    expect(byName.get("Area: Window 2")).toMatchObject({ owner: "before-effects", role: "obstacle" });
    expect(byName.get("Ground")?.role).toBe("ground");
    expect(checkOwners(x)).toEqual([]);
    // The simulation box holds the source, with room above it.
    const em = byName.get("Emitter: Window 1")!.mesh.verts;
    for (const v of em) for (let i = 0; i < 3; i++) {
      expect(v[i]!).toBeGreaterThanOrEqual(x.domain!.min[i]!);
      expect(v[i]!).toBeLessThanOrEqual(x.domain!.max[i]!);
    }
    // (up to a metre above the frame: above that is never seen)
    expect(x.domain!.max[1]).toBeGreaterThanOrEqual(Math.max(...em.map((v) => v[1])) + 2);
    expect(x.domain!.resolution).toBe(96);
    expect(buildExchange(h.project, link("smoke", ["w1"], { quality: "full" }), { venueId: "v", canvas, fps: 30, output }).domain!.resolution).toBe(160);
  });

  it("refuses an exchange where something would have two owners", () => {
    const h = setup();
    const x = buildExchange(h.project, link("smoke", ["w1"]), { venueId: "v", canvas, fps: 30, output });
    const bad = { ...x, objects: [...x.objects, { ...x.objects.find((o) => o.role === "emitter")!, owner: "before-effects" as const }] };
    const problems = checkOwners(bad);
    expect(problems.some((p) => p.includes("both"))).toBe(true);
    expect(problems.some((p) => p.includes("isn't owned by Blender"))).toBe(true);
    const moved = { ...x, objects: x.objects.map((o) => (o.role === "emitter" ? { ...o, motion: [[0, 0, 0, 0, 0, 0, 1]] } : o)) };
    expect(checkOwners(moved)[0]).toMatch(/simulated by Blender but also has motion/);
  });

  it("hangs the reveal cloth in front of the area, held along the top until it lets go, left to right", () => {
    const b = { x0: -2, x1: 2, y0: 0, y1: 3 };
    const c = clothSheet(b, 90, 0.3);
    expect(c.owner).toBe("blender");
    const v = c.mesh.verts;
    const xs = v.map((p) => p[0]), ys = v.map((p) => p[1]);
    expect(Math.min(...xs)).toBeLessThan(b.x0);
    expect(Math.max(...xs)).toBeGreaterThan(b.x1);
    expect(Math.min(...ys)).toBeLessThan(b.y0);
    expect(Math.max(...ys)).toBeGreaterThan(b.y1);
    expect(v.every((p) => p[2] > 0)).toBe(true);
    // Held: the whole top row, and only it.
    const top = Math.max(...ys);
    expect(c.pin!.verts.every((i) => v[i]![1] === top)).toBe(true);
    expect(c.pin!.verts.length).toBe(v.filter((p) => p[1] === top).length);
    // Still until just before the reveal, then lets go over a few frames from the left.
    expect(c.pin!.keys[1]).toEqual([19, 0, 0, 0]);
    const rel = c.pin!.release!;
    expect(rel[0]).toBe(27);
    expect(rel.at(-1)).toBe(35);
    for (let i = 1; i < rel.length; i++) expect(rel[i]!).toBeGreaterThanOrEqual(rel[i - 1]!);
    // Every vertex is used by a triangle.
    const used = new Set(c.mesh.tris.flat());
    expect(used.size).toBe(v.length);
  });

  it("passes physics Before Effects prepared to Blender as played-back obstacles in place of the still area", () => {
    const h = setup();
    // A breaking Window 2: two pieces with recorded poses (7 floats each per frame), 40 frames at 20 fps.
    const frames = 40, movers = 2;
    const motion = new Float32Array(frames * movers * 7);
    for (let f = 0; f < frames; f++)
      for (let m = 0; m < movers; m++) motion.set([m, -f * 0.1, 0, 0, 0, 0, 1], (f * movers + m) * 7);
    const piece = { outline: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as [number, number][], holes: [], center: [0, 0, 0] as [number, number, number], depth: 0.2, area: 1 };
    const object = { id: "o", name: "Window 2 (3D)", kind: "mesh", geometry: { kind: "area", ref: { role: "areas", regionIds: ["w2"] }, depth: 0.2 }, scale: staticProp([100, 100, 100]) };
    const ledge = { id: "l", name: "Ledge", kind: "mesh", geometry: { kind: "box", size: [4, 0.4, 1] }, physics: { body: "static" }, position: staticProp([1, 0.2, 0.5]), rotation: staticProp([0, 0, 0]), scale: staticProp([100, 100, 100]) };
    const resolved = { objects: [{ object, pieces: [piece, piece], poseIndex: 0 }, { object: ledge, pieces: [], poseIndex: -1 }], physics: { key: "k", fps: 20, substeps: 1, frames, gravity: [0, -9.8, 0], bodies: [], movers } } as unknown as ResolvedScene3D;
    // The layer starts at 0.5 s; the effect runs from 1 s for 2 s at 30 fps.
    const prepared = preparedObstacles(h.project, "v", resolved, motion, { layerName: "Collapse", layerStartSeconds: 0.5, startSeconds: 1, frames: 60, fps: 30 });
    expect(prepared.regionIds).toEqual(["w2"]);
    expect(prepared.objects).toHaveLength(3);
    // The ledge the pieces land on: still, where it stands.
    const l = prepared.objects[2]!;
    expect(l.motion).toBeUndefined();
    expect(Math.min(...l.mesh.verts.map((v) => v[0]))).toBeCloseTo(-1, 5);
    expect(Math.max(...l.mesh.verts.map((v) => v[1]))).toBeCloseTo(0.4, 5);
    const p1 = prepared.objects[1]!;
    expect(p1).toMatchObject({ owner: "before-effects", role: "obstacle" });
    expect(p1.motion).toHaveLength(60);
    // Blender frame 1 = show time 1 s = 0.5 s into the layer = prepared frame 10; the last clamps.
    expect(p1.motion![0]![0]).toBe(1);
    expect(p1.motion![0]![1]).toBeCloseTo(-1, 5);
    expect(p1.motion![59]![1]).toBeCloseTo(-3.9, 5);
    // A closed box: 8 corners, 12 triangles.
    expect(p1.mesh.verts).toHaveLength(8);
    expect(p1.mesh.tris).toHaveLength(12);
    const x = buildExchange(h.project, link("smoke", ["w1"]), { venueId: "v", canvas, fps: 30, output, prepared });
    expect(x.objects.some((o) => o.name === "Area: Window 2")).toBe(false);
    expect(x.objects.filter((o) => o.motion)).toHaveLength(2);
    expect(checkOwners(x)).toEqual([]);
  });

  it("breaks an area into Blender-owned pieces that let go top first, with a dark backdrop where they were", () => {
    const area = { name: "Door", outline: [[100, 100], [300, 100], [300, 400], [100, 400]] as [number, number][], holes: [] };
    const objs = shatterPieces([area], canvas, 30, 90, { pieceSize: 60, breakAt: 1, stagger: 1, push: 2, spin: 0.5, seed: 3 });
    const pieces = objs.filter((o) => o.role === "debris");
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.every((o) => o.owner === "blender" && o.release && o.mesh.uvs?.length === o.mesh.verts.length)).toBe(true);
    const back = objs.find((o) => o.role === "backdrop")!;
    expect(back.owner).toBe("before-effects");
    // Behind the pieces.
    expect(Math.max(...back.mesh.verts.map((v) => v[2]))).toBeLessThan(Math.min(...pieces.flatMap((o) => o.mesh.verts.map((v) => v[2]))));
    // Top pieces let go first (from frame 31 = 1 s), lower ones up to a second later; pushed toward the audience.
    const topY = (o: (typeof pieces)[number]) => Math.max(...o.mesh.verts.map((v) => v[1]));
    const sorted = [...pieces].sort((a, b) => topY(b) - topY(a));
    expect(sorted[0]!.release!.frame).toBeLessThan(sorted.at(-1)!.release!.frame);
    expect(Math.min(...pieces.map((o) => o.release!.frame))).toBe(31);
    expect(Math.max(...pieces.map((o) => o.release!.frame))).toBeLessThanOrEqual(61);
    expect(pieces.every((o) => o.release!.velocity[2] > 0)).toBe(true);
    const x = { version: 1, kind: "shatter" as const, params: {}, fps: 30, frames: 90, render: { width: 1, height: 1 }, camera: { eye: [0, 0, 1] as [number, number, number], target: [0, 0, 0] as [number, number, number], fovYDegrees: 30 }, objects: objs, output };
    expect(checkOwners(x)).toEqual([]);
    expect(checkOwners({ ...x, objects: [{ ...pieces[0]!, owner: "before-effects" as const }] })[0]).toMatch(/debris but isn't owned by Blender/);
  });
});

describe("layer effects", () => {
  it("start with every setting at its default, each animatable", () => {
    for (const [type, spec] of Object.entries(LAYER_EFFECTS)) {
      const e = newEffect(type, "fx1");
      expect(Object.keys(e.params).sort()).toEqual(spec.params.map((p) => p.key).sort());
      for (const p of spec.params) {
        expect(e.params[p.key]!.value).toBe(p.default);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
      }
    }
    expect(newEffect("melt", "m", { distance: 120 }).params["distance"]!.value).toBe(120);
  });

  it("are stored when a layer's effects or clipping change (one undo step)", () => {
    const h = setup();
    const layer = newLayer({ id: "L", name: "Pic", source: { kind: "solid", color: sp([1, 1, 1, 1]), width: 100, height: 100 }, start: 0, duration: 1000 });
    h.apply({ type: "layer.add", args: { compId: "s1", layer } });
    const mask = { id: "m", name: "Area", source: { kind: "region" as const, ref: { role: "areas", regionIds: ["w1"] } }, mode: "add" as const, inverted: false, feather: sp(4), expansion: sp(0), opacity: sp(100) };
    h.apply({ type: "layer.update", args: { compId: "s1", layerId: "L", changes: { effects: [newEffect("melt", "fx")], masks: [mask] } } });
    const l = h.project.compositions["s1"]!.layers["L"]!;
    expect(l.effects.map((e) => e.type)).toEqual(["melt"]);
    expect(l.masks[0]!.feather.value).toBe(4);
    h.apply({ type: "prop.set", args: { compId: "s1", layerId: "L", path: "effects.fx.params.distance", value: 120 } });
    h.apply({ type: "prop.set", args: { compId: "s1", layerId: "L", path: "masks.m.feather", value: 9 } });
    expect(h.project.compositions["s1"]!.layers["L"]!.effects[0]!.params["distance"]!.value).toBe(120);
    expect(h.project.compositions["s1"]!.layers["L"]!.masks[0]!.feather.value).toBe(9);
    h.undo();
    h.undo();
    h.undo();
    expect(h.project.compositions["s1"]!.layers["L"]!.effects).toEqual([]);
  });
});

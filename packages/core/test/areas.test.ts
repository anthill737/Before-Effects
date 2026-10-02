import { describe, expect, it } from "vitest";
import {
  type Asset,
  createRegistry,
  emptyProject,
  evaluateCompAt,
  History,
  newComposition,
  polygonPath,
  type Region,
  resolveRegionPaths,
  secondsToTime,
  type Venue,
} from "../src/index.ts";

const rect = (x: number, y: number, w: number, h: number) => polygonPath([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);

const setup = () => {
  const regions: Record<string, Region> = {
    w1: { id: "w1", name: "Window 1", kind: "window", tags: [], path: rect(100, 100, 100, 200) },
    w2: { id: "w2", name: "Window 2", kind: "window", tags: [], path: rect(300, 100, 100, 200) },
    wall: { id: "wall", name: "Wall", kind: "wall", tags: [], path: rect(0, 0, 600, 400), holes: [rect(100, 100, 100, 200)] },
  };
  const venue: Venue = { id: "v", name: "House", kind: "flat", canvas: { width: 600, height: 400 }, regionOrder: Object.keys(regions), regions, groups: { up: { id: "up", name: "Upstairs windows", regionIds: ["w1", "w2"] } }, projectorOrder: [], projectors: {} };
  const video: Asset = { id: "vid", kind: "video", name: "clip.mp4", path: "clip.mp4", meta: { width: 400, height: 300, duration: secondsToTime(4), frameRate: { num: 30, den: 1 }, frameCount: 120 } };
  const pic: Asset = { id: "pic", kind: "image", name: "pic.png", path: "pic.png", meta: { width: 800, height: 400 } };
  const h = new History(emptyProject("t"), createRegistry());
  h.apply([
    { type: "venue.add", args: { venue, makeActive: true } },
    { type: "asset.add", args: { asset: video } },
    { type: "asset.add", args: { asset: pic } },
    { type: "comp.add", args: { comp: newComposition({ id: "s1", name: "Scene 1", width: 600, height: 400, durationSeconds: 20, venueId: "v" }) } },
  ]);
  return h;
};

const assign = (h: History, id: string, compId: string, assetId: string, ref: object, params: object = {}) =>
  h.apply({ type: "recipe.apply", args: { instanceId: id, recipeId: "area-content", compId, targets: [{ role: "areas", ...ref }], params: { assetId, ...params } } });

describe("building areas and content assignments", () => {
  it("cuts holes out of an area's fill", () => {
    const h = setup();
    const paths = resolveRegionPaths(h.project, { role: "x", regionIds: ["wall"] });
    expect(paths.length).toBe(2);
    // The hole runs the other way round, so non-zero filling leaves it empty.
    const area = (p: (typeof paths)[number]) => p.vertices.reduce((s, v, i) => { const q = p.vertices[(i + 1) % p.vertices.length]!.p; return s + v.p[0] * q[1] - q[0] * v.p[1]; }, 0);
    expect(Math.sign(area(paths[0]!))).toBe(-Math.sign(area(paths[1]!)));
  });

  it("repeats in each area or spans one picture across them", () => {
    const h = setup();
    assign(h, "rep", "s1", "pic", { groupId: "up" }, { mode: "each" });
    assign(h, "span", "s1", "pic", { groupId: "up" }, { mode: "across" });
    const c = h.project.compositions.s1!;
    const rep = Object.values(c.layers).filter((l) => l.generatedBy?.recipeInstanceId === "rep");
    const span = Object.values(c.layers).filter((l) => l.generatedBy?.recipeInstanceId === "span");
    expect(rep.length).toBe(2);
    expect(rep.every((l) => l.masks.length === 1)).toBe(true);
    expect(rep.map((l) => l.transform.position.value[0])).toEqual([150, 350]); // centred on each window
    expect(span.length).toBe(1);
    expect(span[0]!.masks.length).toBe(2);
    expect(span[0]!.transform.position.value[0]).toBe(250); // centred on both windows together
  });

  it("follows a group's members and adds crop, trim, speed and loop", () => {
    const h = setup();
    assign(h, "a", "s1", "vid", { groupId: "up" }, { mode: "each", cropL: 10, trim: 1, speed: 200, loop: true });
    const l = Object.values(h.project.compositions.s1!.layers)[0]!;
    expect(l.masks.map((m) => m.mode)).toEqual(["add", "intersect"]);
    expect(l.stretch).toBe(2);
    expect(l.source.kind === "footage" && l.source.loop).toBe(true);
    // At the start of the effect the clip is 1 s in (frame 30 at 30 fps); 3 s later it has looped.
    const at = (s: number) => evaluateCompAt(h.project, h.project.compositions.s1!, secondsToTime(s), {}).layers.find((x) => x.id === l.id)!.source;
    const f0 = at(0);
    const f3 = at(3);
    expect(f0.kind === "footage" && f0.frame).toBe(30);
    expect(f3.kind === "footage" && f3.frame).toBe((30 + 3 * 2 * 30) % 120);
  });

  it("plays a repeated video's sound once, not once per area", () => {
    const h = setup();
    h.apply({ type: "asset.update", args: { assetId: "vid", changes: { audioPath: "clip.wav" } } });
    assign(h, "rep", "s1", "vid", { groupId: "up" }, { mode: "each", volume: -6 });
    const layers = Object.values(h.project.compositions.s1!.layers);
    expect(layers.length).toBe(2);
    expect(layers.filter((l) => l.audioEnabled).length).toBe(1);
    expect(layers.find((l) => l.audioEnabled)!.audio!.volume.value).toBe(-6);
  });

  it("shares outlines across scenes but keeps each scene's content separate", () => {
    const h = setup();
    assign(h, "a", "s1", "vid", { regionIds: ["w1"] });
    h.apply({ type: "scene.duplicate", args: { compId: "s1", newCompId: "s2", name: "Scene 2" } });
    const s2inst = Object.values(h.project.recipes).find((r) => r.compId === "s2")!;
    expect(s2inst.id).not.toBe("a");
    // Swap the content in the copy only.
    h.apply({ type: "recipe.update", args: { instanceId: s2inst.id, params: { assetId: "pic" } } });
    const asset = (c: string) => {
      const s = Object.values(h.project.compositions[c]!.layers)[0]!.source;
      return s.kind === "footage" ? s.assetId : null;
    };
    expect(asset("s1")).toBe("vid");
    expect(asset("s2")).toBe("pic");
    // Reshape the shared window: both scenes follow.
    h.apply({ type: "region.update", args: { venueId: "v", regionId: "w1", changes: { path: rect(120, 100, 100, 200) } } });
    const maskPaths = (c: string) => evaluateCompAt(h.project, h.project.compositions[c]!, secondsToTime(1), {}).layers[0]!.masks[0]!.paths[0]!.vertices[0]!.p[0];
    expect(maskPaths("s1")).toBe(120);
    expect(maskPaths("s2")).toBe(120);
  });

  it("adds the area's own soft edge to the scene's adjustment", () => {
    const h = setup();
    assign(h, "a", "s1", "pic", { regionIds: ["w1"] }, { feather: 5 });
    h.apply({ type: "region.update", args: { venueId: "v", regionId: "w1", changes: { feather: 8, expansion: -3 } } });
    const m = evaluateCompAt(h.project, h.project.compositions.s1!, secondsToTime(1), {}).layers[0]!.masks[0]!;
    expect(m.feather).toBe(13);
    expect(m.expansion).toBe(-3);
  });

  it("arranges scenes in a show with cuts and crossfades", () => {
    const h = setup();
    h.apply({ type: "scene.duplicate", args: { compId: "s1", newCompId: "s2", name: "Scene 2" } });
    h.apply({ type: "show.set", args: { showId: "show", entries: [{ sceneId: "s1", seconds: 5, transition: "cut", fadeSeconds: 0 }, { sceneId: "s2", seconds: 5, transition: "fade", fadeSeconds: 1 }], makeMain: true } });
    const show = h.project.compositions.show!;
    expect(show.duration).toBe(secondsToTime(9)); // 5 + 5 − 1 s overlap
    const ev = (s: number) => evaluateCompAt(h.project, show, secondsToTime(s), {}).layers.map((l) => [l.name, Math.round(l.opacity * 100)]);
    expect(ev(2)).toEqual([["Scene 1", 100]]);
    expect(ev(4.5)).toEqual([["Scene 1", 100], ["Scene 2", 50]]);
    expect(ev(7)).toEqual([["Scene 2", 100]]);
    expect(h.project.mainCompId).toBe("show");
  });
});

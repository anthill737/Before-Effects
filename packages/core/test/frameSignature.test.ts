/**
 * Frame signatures: what each frame is made from. Prepared frames are kept and reused by them, so a
 * frame's signature must change whenever what it shows can change (never reuse a stale frame), and
 * stay the same otherwise (reuse frames across edits, saves, undo and copies of a show).
 */
import { describe, expect, it } from "vitest";
import {
  affectedByPatches,
  createRegistry,
  emptyProject,
  frameSignatures,
  History,
  newComposition,
  newLayer,
  newProjector,
  type Project,
  polygonPath,
  secondsToTime,
  staticProp,
  type Venue,
} from "../src/index.ts";

const FPS = 30;
const FRAMES = 10 * FPS;
const solid = (id: string, from: number, seconds: number) =>
  newLayer({ id, name: id.slice(2), source: { kind: "solid", color: staticProp([1, 1, 1, 1] as const), width: 10, height: 10 }, start: secondsToTime(from), duration: secondsToTime(seconds) });

const venue = (): Venue => {
  const v: Venue = {
    id: "venue1",
    name: "Front",
    kind: "flat",
    canvas: { width: 1000, height: 700 },
    regionOrder: ["w1"],
    regions: { w1: { id: "w1", name: "Window", kind: "window", tags: [], path: polygonPath([[100, 100], [250, 100], [250, 300], [100, 300]]) } },
    groups: {},
    projectorOrder: [],
    projectors: {},
  };
  return { ...v, projectors: { p1: newProjector(v, { id: "p1" }) }, projectorOrder: ["p1"] };
};

/**
 * The show: a picture all through; a solid 2–4 s; a nested scene (4 s long, a solid 1–2 s into it)
 * from 5 s; a 3D layer 7–8 s; a matted solid 8–9 s with its matte; a sound all through; a photo.
 */
const makeShow = (): History => {
  const h = new History(emptyProject("t"), createRegistry());
  h.apply([
    { type: "venue.add", args: { venue: venue() } },
    { type: "comp.add", args: { comp: newComposition({ id: "show", width: 1000, height: 700, durationSeconds: 10, venueId: "venue1" }) } },
    { type: "comp.add", args: { comp: newComposition({ id: "inner", width: 1000, height: 700, durationSeconds: 4, venueId: "venue1" }) } },
    { type: "asset.add", args: { asset: { id: "photo", kind: "image", name: "photo.png", path: "C:/media/photo.png", meta: { width: 100, height: 100 } } } },
    { type: "asset.add", args: { asset: { id: "music", kind: "audio", name: "music.wav", path: "C:/media/music.wav", meta: { duration: secondsToTime(10) } } } },
  ]);
  h.apply({ type: "layer.add", args: { compId: "show", layer: { ...solid("L_picture", 0, 10), source: { kind: "footage", assetId: "photo" } } } });
  h.apply({ type: "layer.add", args: { compId: "show", layer: solid("L_solid", 2, 2) } });
  h.apply({ type: "layer.add", args: { compId: "inner", layer: solid("L_innerSolid", 1, 1) } });
  h.apply({ type: "layer.add", args: { compId: "show", layer: { ...solid("L_nest", 5, 4), source: { kind: "comp", compId: "inner" } } } });
  h.apply({ type: "layer.add", args: { compId: "show", layer: { ...solid("L_in3d", 7, 1), source: { kind: "scene3d", sceneId: "s1" } } } });
  h.apply({ type: "layer.add", args: { compId: "show", layer: solid("L_matte", 8, 1) } });
  h.apply({ type: "layer.add", args: { compId: "show", layer: solid("L_matted", 8, 1) } });
  h.apply({ type: "layer.update", args: { compId: "show", layerId: "L_matted", changes: { trackMatte: { layerId: "L_matte", mode: "alpha" } } } });
  h.apply({ type: "layer.add", args: { compId: "show", layer: { ...solid("L_sound", 0, 10), source: { kind: "audio", assetId: "music" } } } });
  return h;
};

/** A 3D scene for the 3D layer (scenes are plain data in the show). */
const withScene = (p: Project, colour: number): Project => ({ ...p, scenes3d: { s1: { id: "s1", name: "S", objectOrder: [], objects: {}, gravity: [0, -9.8, 0], colour } as never } });

const sigs = (p: Project) => {
  const f = frameSignatures(p, "show");
  return Array.from({ length: FRAMES }, (_, i) => f(i));
};
/** Frames (at 30 fps) whose signature differs between two versions. */
const changed = (a: Project, b: Project): number[] => {
  const x = sigs(a);
  const y = sigs(b);
  return x.flatMap((s, i) => (s === y[i] ? [] : [i]));
};
const span = (from: number, to: number) => Array.from({ length: (to - from) * FPS }, (_, i) => from * FPS + i);

describe("frame signatures", () => {
  it("are the same for the same show, also read back from its file", () => {
    const p = withScene(makeShow().project, 1);
    const copy = JSON.parse(JSON.stringify(p)) as Project;
    expect(changed(p, copy)).toEqual([]);
    expect(new Set(sigs(p)).size).toBe(FRAMES); // every frame its own (time is part of it)
  });

  it("change only where an edited layer is on, and go back with undo", () => {
    const h = makeShow();
    const before = h.project;
    h.apply({ type: "prop.set", args: { compId: "show", layerId: "L_solid", path: "transform.opacity", value: 50 } });
    expect(changed(before, h.project)).toEqual(span(2, 4));
    h.undo();
    expect(changed(before, h.project)).toEqual([]);
  });

  it("a layer added or moved changes only the frames it's on (or was on)", () => {
    const h = makeShow();
    const before = h.project;
    h.apply({ type: "layer.add", args: { compId: "show", layer: solid("L_extra", 3, 1) } });
    expect(changed(before, h.project)).toEqual(span(3, 4));
    const b2 = h.project;
    h.apply({ type: "layer.update", args: { compId: "show", layerId: "L_extra", changes: { startTime: secondsToTime(6), inPoint: secondsToTime(6), outPoint: secondsToTime(7) } } });
    expect(changed(b2, h.project)).toEqual([...span(3, 4), ...span(6, 7)]);
  });

  it("a nested scene's change shows only where the show plays that part of it", () => {
    const h = makeShow();
    const before = h.project;
    h.apply({ type: "prop.set", args: { compId: "inner", layerId: "L_innerSolid", path: "transform.opacity", value: 50 } });
    // The inner solid is 1–2 s into the nested scene, which starts at 5 s.
    expect(changed(before, h.project)).toEqual(span(6, 7));
  });

  it("a 3D scene's change shows where its layer is on", () => {
    const p = withScene(makeShow().project, 1);
    expect(changed(p, withScene(p, 2))).toEqual(span(7, 8));
  });

  it("a track matte's change shows where the matted layer is on", () => {
    const h = makeShow();
    const before = h.project;
    h.apply({ type: "prop.set", args: { compId: "show", layerId: "L_matte", path: "transform.opacity", value: 50 } });
    expect(changed(before, h.project)).toEqual(span(8, 9));
  });

  it("a parent's change shows wherever its children are, even when the parent itself isn't on", () => {
    const h = makeShow();
    h.apply({ type: "layer.add", args: { compId: "show", layer: { ...solid("L_parent", 0, 1), source: { kind: "null" } } } });
    h.apply({ type: "layer.update", args: { compId: "show", layerId: "L_solid", changes: { parentId: "L_parent" } } });
    const before = h.project;
    h.apply({ type: "prop.set", args: { compId: "show", layerId: "L_parent", path: "transform.opacity", value: 50 } });
    expect(changed(before, h.project)).toEqual([...span(0, 1), ...span(2, 4)]);
  });

  it("media change only the frames that use them; sounds and new imports change none", () => {
    const h = makeShow();
    const before = h.project;
    h.apply({ type: "asset.relink", args: { assetId: "photo", path: "C:/media/photo2.png" } });
    expect(changed(before, h.project)).toEqual(span(0, 10)); // the picture is on all through
    const b2 = h.project;
    h.apply({ type: "asset.relink", args: { assetId: "music", path: "C:/media/music2.wav" } });
    h.apply({ type: "asset.add", args: { asset: { id: "unused", kind: "image", name: "u.png", path: "C:/media/u.png", meta: { width: 1, height: 1 } } } });
    h.apply({ type: "layer.update", args: { compId: "show", layerId: "L_sound", changes: { startTime: secondsToTime(0.5) } } });
    expect(changed(b2, h.project)).toEqual([]);
  });

  it("projector settings change nothing; the building or the composition's size changes everything", () => {
    const h = makeShow();
    const before = h.project;
    h.apply({ type: "calibration.movePoint", args: { venueId: "venue1", projectorId: "p1", pointId: "c1", output: [3, 3] } });
    expect(changed(before, h.project)).toEqual([]);
    h.apply({ type: "region.update", args: { venueId: "venue1", regionId: "w1", changes: { name: "Big window", kind: "door" } } });
    expect(changed(before, h.project)).toEqual(span(0, 10));
    const b2 = h.project;
    h.apply({ type: "comp.update", args: { compId: "show", changes: { width: 800 } } });
    expect(changed(b2, h.project)).toEqual(span(0, 10));
  });

  it("every frame an edit affects (by the edit-by-edit invalidation) gets a new signature", () => {
    const edits = [
      { type: "prop.set", args: { compId: "show", layerId: "L_solid", path: "transform.opacity", value: 20 } },
      { type: "layer.update", args: { compId: "show", layerId: "L_solid", changes: { startTime: secondsToTime(1), inPoint: secondsToTime(1), outPoint: secondsToTime(3) } } },
      { type: "prop.set", args: { compId: "inner", layerId: "L_innerSolid", path: "transform.opacity", value: 20 } },
      { type: "layer.remove", args: { compId: "show", layerId: "L_nest" } },
      { type: "prop.set", args: { compId: "show", layerId: "L_matte", path: "transform.opacity", value: 20 } },
    ] as const;
    for (const e of edits) {
      const h = makeShow();
      const before = h.project;
      const tx = h.apply(e as never);
      const a = affectedByPatches(before, h.project, tx.patches, "show");
      const moved = new Set(changed(before, h.project));
      const affected = a.all ? span(0, 10) : a.ranges.flatMap(([s, t]) => span(0, 10).filter((f) => secondsToTime(f / FPS) >= s && secondsToTime(f / FPS) < t));
      // (The invalidation may cover more — it widens nested times by a flick for rounding, so a frame
      // exactly at a nested scene's edge can be "affected" without changing; a signature must never
      // stay the same where a frame really changed.)
      const edge = (f: number) => moved.has(f - 1) || moved.has(f + 1);
      for (const f of affected) if (!a.all) expect(moved.has(f) || edge(f), `${e.type} frame ${f}`).toBe(true);
      expect(moved.size).toBeGreaterThan(0);
    }
  });
});

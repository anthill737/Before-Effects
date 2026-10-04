/** Which kinds of content each frame draws (for keeping prepared frames an app update draws the same way). */
import { describe, expect, it } from "vitest";
import { contentAt, createRegistry, emptyProject, framesUsing, History, newComposition, newLayer, secondsToTime, staticProp } from "../src/index.ts";

const solid = (id: string, from: number, seconds: number) => newLayer({ id, name: id, source: { kind: "solid", color: staticProp([1, 1, 1, 1] as const), width: 10, height: 10 }, start: secondsToTime(from), duration: secondsToTime(seconds) });

describe("content kinds of frames", () => {
  it("finds 3D, nested scenes, mattes, adjustments and newer blend modes, frame by frame", () => {
    const h = new History(emptyProject("t"), createRegistry());
    h.apply([
      { type: "comp.add", args: { comp: newComposition({ id: "show", width: 100, height: 100, durationSeconds: 10 }) } },
      { type: "comp.add", args: { comp: newComposition({ id: "inner", width: 100, height: 100, durationSeconds: 4 }) } },
    ]);
    // The show: a picture throughout; a nested scene from 2 s (with a 3D layer from 1 s into it);
    // an adjustment layer 6–7 s; a picture in Overlay 8–9 s; a matted picture 9–10 s.
    h.apply({ type: "layer.add", args: { compId: "show", layer: solid("picture", 0, 10) } });
    h.apply({ type: "layer.add", args: { compId: "inner", layer: { ...solid("in3d", 1, 1), source: { kind: "scene3d", sceneId: "s" } } } });
    h.apply({ type: "layer.add", args: { compId: "show", layer: { ...solid("nest", 2, 4), source: { kind: "comp", compId: "inner" } } } });
    h.apply({ type: "layer.add", args: { compId: "show", layer: { ...solid("adjust", 6, 1), source: { kind: "adjustment" } } } });
    h.apply({ type: "layer.add", args: { compId: "show", layer: { ...solid("overlay", 8, 1), blendMode: "overlay" } } });
    h.apply({ type: "layer.add", args: { compId: "show", layer: solid("matte", 9, 1) } });
    h.apply({ type: "layer.add", args: { compId: "show", layer: solid("matted", 9, 1) } });
    h.apply({ type: "layer.update", args: { compId: "show", layerId: "matted", changes: { trackMatte: { layerId: "matte", mode: "alpha" } } } });
    const at = (s: number) => [...contentAt(h.project, "show", secondsToTime(s))].sort();
    expect(at(0.5)).toEqual(["2d"]);
    expect(at(2.5)).toEqual(["2d"]); // the nested scene's 3D layer starts 1 s into it
    expect(at(3.5)).toEqual(["2d", "3d"]);
    expect(at(6.5)).toEqual(["2d", "adjustment"]);
    expect(at(8.5)).toEqual(["2d", "blend-mode"]);
    expect(at(9.5)).toEqual(["2d", "track-matte"]);
    // At 30 fps: the 3D frames are 3–4 s (90–120); with the adjustment, 180–210.
    expect(framesUsing(h.project, "show", new Set(["3d"]))).toEqual([[90, 120]]);
    expect(framesUsing(h.project, "show", new Set(["3d", "adjustment"]))).toEqual([
      [90, 120],
      [180, 210],
    ]);
    expect(framesUsing(h.project, "show", new Set(["simulation"]))).toEqual([]);
  });
});

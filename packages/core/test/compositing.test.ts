/** Compositing in the evaluated scene: track mattes (the matte layer isn't drawn itself) and blend modes. */
import { describe, expect, it } from "vitest";
import { createRegistry, emptyProject, evaluateComp, History, newComposition, newLayer, RENDERED_BLEND_MODES, secondsToTime, staticProp } from "../src/index.ts";

const setup = () => {
  const h = new History(emptyProject("t"), createRegistry());
  h.apply({ type: "comp.add", args: { comp: newComposition({ id: "c", width: 400, height: 300, durationSeconds: 10 }) } });
  const solid = (id: string, color: [number, number, number, number], from = 0, seconds = 10) =>
    newLayer({ id, name: id, source: { kind: "solid", color: staticProp(color), width: 400, height: 300 }, start: secondsToTime(from), duration: secondsToTime(seconds) });
  // Top first: the shape, the picture shown through it, and a background.
  h.apply({ type: "layer.add", args: { compId: "c", layer: solid("background", [0, 0, 1, 1]) } });
  h.apply({ type: "layer.add", args: { compId: "c", layer: solid("picture", [1, 0, 0, 1]) } });
  h.apply({ type: "layer.add", args: { compId: "c", layer: solid("shape", [1, 1, 1, 1], 2, 3) } });
  return h;
};

describe("track mattes", () => {
  it("draws the matte layer only as the other layer's shape, not on its own", () => {
    const h = setup();
    expect(evaluateComp(h.project, "c", secondsToTime(3)).layers.map((l) => l.id)).toEqual(["background", "picture", "shape"]);
    h.apply({ type: "layer.update", args: { compId: "c", layerId: "picture", changes: { trackMatte: { layerId: "shape", mode: "alpha" } } } });
    const at3 = evaluateComp(h.project, "c", secondsToTime(3));
    expect(at3.layers.map((l) => l.id)).toEqual(["background", "picture"]);
    const pic = at3.layers.find((l) => l.id === "picture")!;
    expect(pic.trackMatte?.layer.id).toBe("shape");
    expect(pic.trackMatte?.active).toBe(true);
    // Outside the matte layer's time it shapes nothing: the matte is empty (an alpha matte hides the picture).
    expect(evaluateComp(h.project, "c", secondsToTime(8)).layers.find((l) => l.id === "picture")!.trackMatte?.active).toBe(false);
    // Clearing it draws the shape layer again.
    h.apply({ type: "layer.update", args: { compId: "c", layerId: "picture", changes: { trackMatte: null } } });
    expect(evaluateComp(h.project, "c", secondsToTime(3)).layers.map((l) => l.id)).toEqual(["background", "picture", "shape"]);
  });

  it("refuses a layer as its own matte, a missing one, and two layers shown through each other", () => {
    const h = setup();
    const set = (layerId: string, matte: string) => h.apply({ type: "layer.update", args: { compId: "c", layerId, changes: { trackMatte: { layerId: matte, mode: "luma" } } } });
    expect(() => set("picture", "picture")).toThrow(/itself/);
    expect(() => set("picture", "nope")).toThrow(/isn't in this scene/);
    set("picture", "shape");
    expect(() => set("shape", "picture")).toThrow(/each be shown through the other/);
    // Undo puts it back as it was.
    h.undo();
    expect(h.project.compositions.c!.layers.picture!.trackMatte).toBeUndefined();
  });
});

describe("blend modes", () => {
  it("draws every After Effects blend mode, and light falling on what's beneath (illuminate)", () => {
    expect([...RENDERED_BLEND_MODES].sort()).toEqual(
      ["normal", "add", "screen", "multiply", "overlay", "soft-light", "hard-light", "color-dodge", "color-burn", "darken", "lighten", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "illuminate"].sort(),
    );
  });
});

import { describe, expect, it } from "vitest";
import { createRegistry, emptyProject, evalProp, flameOutline, generatedLayerId, History, newComposition, newProjector, polygonPath, type Region, secondsToTime, torchFlames, type Venue } from "../src/index.ts";

const venue = (): Venue => {
  const regions: Record<string, Region> = {
    lamp: { id: "lamp", name: "Lantern", kind: "light", tags: [], path: polygonPath([[100, 100], [150, 100], [150, 190], [100, 190]]) },
  };
  const v: Venue = { id: "v1", name: "Test", kind: "flat", canvas: { width: 1000, height: 700 }, regionOrder: ["lamp"], regions, groups: {}, projectorOrder: [], projectors: {} };
  return { ...v, projectors: { p1: newProjector(v, { id: "p1" }) }, projectorOrder: ["p1"] };
};

describe("torch flames", () => {
  it("draws a tongue of flame: round base, pointed tip", () => {
    const f = flameOutline(100);
    const ys = f.map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(-100);
    expect(Math.max(...ys)).toBeCloseTo(0);
    const widest = Math.max(...f.map((p) => p[0]));
    expect(widest).toBeGreaterThan(10);
    expect(widest).toBeLessThan(30);
  });

  it("puts a flickering flame with a glow in each area, moving by itself (no keyframes)", () => {
    const history = new History(emptyProject("Test"), createRegistry());
    const v = venue();
    history.apply([
      { type: "venue.add", args: { venue: v } },
      { type: "comp.add", args: { comp: newComposition({ id: "main", width: 1000, height: 700, durationSeconds: 120, venueId: v.id }) } },
      { type: "recipe.apply", args: { instanceId: "T", recipeId: torchFlames.id, compId: "main", targets: [{ role: "lights", regionIds: ["lamp"] }], params: { seconds: 100 } } },
    ]);
    const layers = history.project.compositions.main!.layers;
    const roles = ["glow-0", "flame-0", "body-0", "core-0"];
    for (const r of roles) expect(layers[generatedLayerId("T", r)]).toBeDefined();
    const core = layers[generatedLayerId("T", "core-0")]!;
    expect(core.blendMode).toBe("add");
    expect(core.transform.scale.keyframes ?? []).toHaveLength(0);
    // The flame sits in the lantern and its size changes over time on its own.
    expect(core.transform.position.value[0]).toBeCloseTo(125);
    const sy = (s: number) => (evalProp(core.transform.scale, secondsToTime(s)) as readonly number[])[1]!;
    const samples = Array.from({ length: 40 }, (_, i) => sy(i * 0.07));
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(4);
    expect(sy(1.234)).toBe(sy(1.234));
    // Lasts as long as asked (an hour is fine: nothing is keyed).
    expect((core.outPoint - core.inPoint) / secondsToTime(1)).toBeCloseTo(100);
  });
});

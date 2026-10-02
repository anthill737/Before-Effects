import { describe, expect, it } from "vitest";
import {
  ASSISTANT_TOOLS,
  type AssistantContext,
  colourName,
  createRegistry,
  describeShow,
  effectCatalog,
  emptyProject,
  getRecipe,
  hexToRgba,
  History,
  newComposition,
  normalizeSettings,
  operationCatalog,
  polygonPath,
  type Region,
  resolveParts,
  rgbaToHex,
  type Venue,
} from "../src/index.ts";

const setup = () => {
  const regions: Record<string, Region> = {};
  ["w1", "w2", "w3"].forEach((id, i) => {
    regions[id] = { id, name: `Window ${i + 1}`, kind: "window", tags: [], path: polygonPath([[100 + i * 200, 100], [250 + i * 200, 100], [250 + i * 200, 300], [100 + i * 200, 300]]) };
  });
  regions.door = { id: "door", name: "Front door", kind: "door", tags: [], path: polygonPath([[400, 400], [500, 400], [500, 600], [400, 600]]) };
  const venue: Venue = {
    id: "v1",
    name: "House",
    kind: "flat",
    canvas: { width: 1000, height: 700 },
    regionOrder: Object.keys(regions),
    regions,
    groups: { g1: { id: "g1", name: "Upper windows", regionIds: ["w1", "w2"] } },
    projectorOrder: [],
    projectors: {},
  };
  const history = new History(emptyProject("Test"), createRegistry());
  history.apply([
    { type: "venue.add", args: { venue } },
    { type: "comp.add", args: { comp: newComposition({ id: "main", width: 1000, height: 700, durationSeconds: 10, venueId: "v1" }) } },
    { type: "binding.setRole", args: { venueId: "v1", role: "windows", regionIds: ["w1", "w2", "w3"] } },
  ]);
  const ctx: AssistantContext = { compId: "main", timeSeconds: 2, selectedRegionIds: ["w2", "w3"], selectedEffectId: null };
  return { history, ctx };
};

describe("assistant view and tools", () => {
  it("describes parts, selection and effects with ids the tools accept", () => {
    const { history, ctx } = setup();
    history.apply({ type: "recipe.apply", args: { instanceId: "r1", recipeId: "pulse", compId: "main", targets: [{ role: "windows" }], params: { color: [0, 0, 1, 1] } } });
    const d = describeShow(history.project, ctx);
    expect(d.parts.map((p) => p.id)).toEqual(["w1", "w2", "w3", "door"]);
    expect(d.parts[0]!.groups).toEqual(["Upper windows"]);
    expect(d.selected.parts.map((p) => p.name)).toEqual(["Window 2", "Window 3"]);
    expect(d.effects[0]).toMatchObject({ id: "r1", effect: "pulse", settings: { color: "#0000ff", bpm: 60 } });
    expect(d.effects[0]!.parts.map((p) => p.id)).toEqual(["w1", "w2", "w3"]);
    // Generated layers are summarised by their effect, not listed as separate layers.
    expect(d.other_layers).toEqual([]);
  });

  it("resolves selected parts, names, groups and kinds and reports unknown references", () => {
    const { history, ctx } = setup();
    const p = history.project;
    expect(resolveParts(p, ["selected"], ctx).ids).toEqual(["w2", "w3"]);
    expect(resolveParts(p, ["these"], ctx).ids).toEqual(["w2", "w3"]);
    expect(resolveParts(p, ["window 1", "front door"], ctx).ids).toEqual(["w1", "door"]);
    expect(resolveParts(p, ["upper windows"], ctx).ids).toEqual(["w1", "w2"]);
    expect(resolveParts(p, ["all windows"], ctx).ids).toEqual(["w1", "w2", "w3"]);
    expect(resolveParts(p, ["w3", "chimney"], ctx)).toEqual({ ids: ["w3"], unknown: ["chimney"] });
  });

  it("normalises settings: hex colours, ranges, choices, and explains problems", () => {
    const def = getRecipe("move-with-beat")!;
    const { params, problems } = normalizeSettings(def, { color: "#3070ff", strength: 140, which: "half", speed: 2 });
    expect(params.color).toEqual(hexToRgba("#3070ff"));
    expect(params.strength).toBe(100);
    expect(params.which).toBe("half");
    expect(problems.join(" ")).toMatch(/outside/);
    expect(problems.join(" ")).toMatch(/no setting "speed"/);
    expect(rgbaToHex([0.188, 0.439, 1, 1])).toBe("#3070ff");
    expect(colourName(hexToRgba("#2f6bff")!)).toBe("blue");
    expect(colourName([1, 0.82, 0.5, 1])).toBe("warm white");
    expect(colourName([1, 0.1, 0.1, 1])).toBe("red");
    expect(colourName([1, 1, 1, 1])).toBe("white");
  });

  it("catalogues every effect and operation with schemas for the model", () => {
    const effects = effectCatalog();
    expect(effects.find((e) => e.effect === "move-with-beat")?.settings.some((s) => s.key === "which")).toBe(true);
    const ops = operationCatalog(createRegistry());
    const update = ops.find((o) => o.type === "layer.update");
    expect(update?.args).toMatchObject({ type: "object" });
    expect(ASSISTANT_TOOLS.map((t) => t.name)).toContain("change_effect");
  });
});

describe("assistant undo", () => {
  it("groups one request's steps into one undo step", () => {
    const { history } = setup();
    const before = history.transactions().length;
    history.apply({ type: "recipe.apply", args: { instanceId: "r1", recipeId: "pulse", compId: "main", targets: [{ role: "windows" }] } }, { source: "assistant", group: "req1", label: "Assistant" });
    history.apply({ type: "recipe.update", args: { instanceId: "r1", params: { bpm: 30 } } }, { source: "assistant", group: "req1" });
    expect(history.transactions().length).toBe(before + 1);
    history.undo();
    expect(history.project.recipes.r1).toBeUndefined();
  });

  it("undoes an earlier assistant request while keeping later hand edits", () => {
    const { history } = setup();
    const tx = history.apply({ type: "recipe.apply", args: { instanceId: "r1", recipeId: "pulse", compId: "main", targets: [{ role: "windows" }] } }, { source: "assistant", group: "req1" });
    // The person keeps working: a separate effect of their own.
    history.apply({ type: "recipe.apply", args: { instanceId: "mine", recipeId: "edge-trace", compId: "main", targets: [{ role: "windows" }] } });
    history.revert([tx.id], "Undo assistant change");
    expect(history.project.recipes.r1).toBeUndefined();
    expect(history.project.recipes.mine).toBeDefined();
    expect(Object.keys(history.project.compositions.main!.layers).some((id) => id.startsWith("r1__"))).toBe(false);
    // The selective undo is itself undoable.
    history.undo();
    expect(history.project.recipes.r1).toBeDefined();
    expect(history.project.recipes.mine).toBeDefined();
  });

  it("refuses a selective undo when later work depends on it, changing nothing", () => {
    const { history } = setup();
    const tx = history.apply({ type: "recipe.apply", args: { instanceId: "r1", recipeId: "pulse", compId: "main", targets: [{ role: "windows" }] } }, { source: "assistant", group: "req1" });
    history.apply({ type: "recipe.update", args: { instanceId: "r1", params: { bpm: 90 } } });
    const p = history.project;
    expect(() => history.revert([tx.id])).toThrow(/builds on it/);
    expect(history.project).toBe(p);
  });
});

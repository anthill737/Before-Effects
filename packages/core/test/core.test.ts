import { describe, expect, it } from "vitest";
import {
  applyHomography,
  createRegistry,
  edgeTrace,
  emptyProject,
  evalKeyframes,
  evaluateComp,
  frameToTime,
  FLICKS_PER_SECOND,
  hashKeys,
  History,
  homographyResiduals,
  type Keyframe,
  newComposition,
  newLayer,
  newProjector,
  pcgHash,
  polygonPath,
  type Project,
  rand01,
  RATES,
  rate,
  secondsToTime,
  sequenceLightUp,
  solveHomography,
  staticProp,
  timeToFrame,
  type Venue,
  wiggle1,
  orderTargets,
  resolveTargets,
  overriddenParams,
  type Vec2,
  type Layer,
  type AnimProp,
  type Region,
  generatedLayerId,
  affectedByPatches,
} from "../src/index.ts";

describe("time", () => {
  it("represents every common frame rate exactly", () => {
    for (const r of Object.values(RATES)) {
      for (const f of [0, 1, 29, 1799, 107_892]) {
        const t = frameToTime(f, r);
        expect(Number.isInteger(t)).toBe(true);
        expect(timeToFrame(t, r)).toBe(f);
        expect(timeToFrame(t + 1, r)).toBe(f);
        if (f > 0) expect(timeToFrame(t - 1, r)).toBe(f - 1);
      }
    }
  });
  it("handles uncommon rates with BigInt rounding", () => {
    const r = rate(7, 1); // 705600000 / 7 = 100800000 — exact anyway
    expect(frameToTime(7, r)).toBe(FLICKS_PER_SECOND);
    const odd = rate(1000, 999);
    expect(timeToFrame(frameToTime(12345, odd), odd)).toBe(12345);
  });
});

describe("rng", () => {
  it("matches reference pcg_hash values (keep WGSL twin in sync)", () => {
    // Reference values computed from the canonical C implementation.
    expect(pcgHash(0)).toBe(129708002);
    expect(pcgHash(1)).toBe(2831084092);
    expect(pcgHash(12345)).toBe(pcgHash(12345));
  });
  it("is order independent and seed dependent", () => {
    const a = [5, 2, 9].map((k) => rand01(42, k));
    const b = [9, 2, 5].map((k) => rand01(42, k)).reverse();
    expect(a).toEqual(b);
    expect(rand01(42, 1)).not.toBe(rand01(43, 1));
    expect(hashKeys(1, 2, 3)).not.toBe(hashKeys(1, 3, 2));
    for (let i = 0; i < 1000; i++) {
      const v = rand01(7, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it("wiggle is continuous and deterministic", () => {
    const s = 9;
    const v1 = wiggle1(1.2345, 2, 50, s);
    expect(wiggle1(1.2345, 2, 50, s)).toBe(v1);
    expect(Math.abs(wiggle1(1.2346, 2, 50, s) - v1)).toBeLessThan(1);
  });
});

describe("keyframes", () => {
  const t = (s: number) => secondsToTime(s);
  const k = (sec: number, v: number, interp: "linear" | "bezier" | "hold" = "linear", ease?: { speed: number; influence: number }): Keyframe<number> => ({
    id: `k${sec}`,
    t: t(sec),
    v,
    in: interp === "hold" ? "linear" : interp,
    out: interp,
    ...(ease ? { easeIn: [ease], easeOut: [ease] } : {}),
  });

  it("interpolates linear, hold and clamps outside the range", () => {
    const p = { value: 0, keyframes: [k(0, 0), k(1, 100, "hold"), k(2, 50)] };
    expect(evalKeyframes(p, t(-1))).toBe(0);
    expect(evalKeyframes(p, t(0.5))).toBeCloseTo(50, 6);
    expect(evalKeyframes(p, t(1.5))).toBe(100);
    expect(evalKeyframes(p, t(3))).toBe(50);
  });

  it("easy ease starts and ends at zero speed and is symmetric", () => {
    const e = { speed: 0, influence: 1 / 3 };
    const p = { value: 0, keyframes: [k(0, 0, "bezier", e), k(1, 100, "bezier", e)] };
    expect(evalKeyframes(p, t(0.5))).toBeCloseTo(50, 4);
    expect(evalKeyframes(p, t(0.01))).toBeLessThan(1);
    expect(evalKeyframes(p, t(0.25)) + evalKeyframes(p, t(0.75))).toBeCloseTo(100, 4);
  });

  it("spatial paths keep constant speed with linear temporal interpolation", () => {
    const p: AnimProp<readonly number[]> = {
      value: [0, 0, 0],
      spatial: true,
      keyframes: [
        { id: "a", t: t(0), v: [0, 0, 0], in: "linear", out: "linear", tanOut: [100, 0, 0] },
        { id: "b", t: t(1), v: [100, 100, 0], in: "linear", out: "linear", tanIn: [0, -100, 0] },
      ],
    };
    // Fine sampling: each step's chord approximates arc length, so equal steps mean constant speed.
    const N = 200;
    const pts = Array.from({ length: N + 1 }, (_, i) => evalKeyframes(p, t(i / N)) as readonly number[]);
    const seg = pts.slice(1).map((q, i) => Math.hypot(q[0]! - pts[i]![0]!, q[1]! - pts[i]![1]!));
    const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
    for (const s of seg) expect(Math.abs(s - mean) / mean).toBeLessThan(0.03);
    expect(pts[N]).toEqual([100, 100, 0]);
  });
});

describe("homography", () => {
  it("solves an exact four-point corner pin and reports ~zero residual", () => {
    const src: Vec2[] = [[0, 0], [1920, 0], [1920, 1080], [0, 1080]];
    const dst: Vec2[] = [[100, 80], [1800, 40], [1880, 1050], [60, 1000]];
    const H = solveHomography(src, dst)!;
    expect(H).not.toBeNull();
    for (const r of homographyResiduals(H, src, dst)) expect(r).toBeLessThan(1e-6);
    const mid = applyHomography(H, [960, 540]);
    expect(mid[0]).toBeGreaterThan(60);
    expect(mid[0]).toBeLessThan(1880);
  });
  it("fits more points by least squares and exposes a misplaced point", () => {
    const src: Vec2[] = [[0, 0], [100, 0], [100, 100], [0, 100], [50, 50], [25, 75]];
    const dst = src.map(([x, y]) => [x * 2 + 10, y * 2 + 5] as Vec2);
    dst[4] = [dst[4]![0] + 12, dst[4]![1]];
    const H = solveHomography(src, dst)!;
    const res = homographyResiduals(H, src, dst);
    const worst = res.indexOf(Math.max(...res));
    expect(worst).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------

const makeVenue = (): Venue => {
  const windows: Array<[string, number, number]> = [
    ["w1", 100, 100], ["w2", 400, 100], ["w3", 700, 100],
    ["w4", 100, 400], ["w5", 400, 400], ["w6", 700, 400],
  ];
  const regions: Record<string, Region> = Object.fromEntries(
    windows.map(([id, x, y]) => [
      id,
      { id, name: `Window ${id.slice(1)}`, kind: "window" as const, tags: [], path: polygonPath([[x, y], [x + 150, y], [x + 150, y + 200], [x, y + 200]]) },
    ]),
  );
  regions.roof = { id: "roof", name: "Roofline", kind: "roofline" as const, tags: [], path: polygonPath([[50, 60], [500, 10], [950, 60]], false) };
  const v: Venue = {
    id: "venue1",
    name: "Test facade",
    kind: "flat",
    canvas: { width: 1000, height: 700 },
    regionOrder: Object.keys(regions),
    regions,
    groups: {},
    projectorOrder: [],
    projectors: {},
  };
  const proj = newProjector(v, { id: "p1" });
  return { ...v, projectors: { p1: proj }, projectorOrder: ["p1"] };
};

const makeProject = (): { history: History; compId: string } => {
  const registry = createRegistry();
  const history = new History(emptyProject("Test"), registry);
  const venue = makeVenue();
  const comp = newComposition({ id: "main", width: 1000, height: 700, durationSeconds: 10, venueId: venue.id });
  history.apply([
    { type: "venue.add", args: { venue } },
    { type: "comp.add", args: { comp } },
    { type: "binding.setRole", args: { venueId: venue.id, role: "windows", regionIds: ["w1", "w2", "w3", "w4", "w5", "w6"] } },
    { type: "binding.setRole", args: { venueId: venue.id, role: "roofline", regionIds: ["roof"] } },
  ]);
  return { history, compId: comp.id };
};

describe("operations and history", () => {
  it("undo/redo are exact inverses", () => {
    const { history, compId } = makeProject();
    const before = history.project;
    const layer = newLayer({ id: "L1", source: { kind: "solid", color: staticProp([1, 0, 0, 1] as const), width: 100, height: 100 }, duration: secondsToTime(5) });
    history.apply({ type: "layer.add", args: { compId, layer } });
    history.apply({ type: "prop.set", args: { compId, layerId: "L1", path: "transform.opacity", value: 40 } });
    expect(history.project.compositions[compId]!.layers.L1!.transform.opacity.value).toBe(40);
    history.undo();
    expect(history.project.compositions[compId]!.layers.L1!.transform.opacity.value).toBe(100);
    history.undo();
    expect(history.project).toEqual(before);
    history.redo();
    history.redo();
    expect(history.project.compositions[compId]!.layers.L1!.transform.opacity.value).toBe(40);
  });

  it("rejects invalid args and locked layers with plain-language errors", () => {
    const { history, compId } = makeProject();
    expect(() => history.apply({ type: "layer.update", args: { compId, layerId: "nope", changes: { name: "x" } } })).toThrow(/no longer exists/);
    const layer = { ...newLayer({ id: "L2", source: { kind: "adjustment" }, duration: 10 }), locked: true };
    history.apply({ type: "layer.add", args: { compId, layer } });
    expect(() => history.apply({ type: "prop.set", args: { compId, layerId: "L2", path: "transform.opacity", value: 1 } })).toThrow(/locked/);
  });

  it("coalesces a drag gesture into one undo step", () => {
    const { history, compId } = makeProject();
    history.apply({ type: "layer.add", args: { compId, layer: newLayer({ id: "L3", source: { kind: "adjustment" }, duration: 10 }) } });
    const n = history.transactions().length;
    for (let i = 0; i < 10; i++) history.apply({ type: "prop.set", args: { compId, layerId: "L3", path: "transform.opacity", value: i * 10 } }, { coalesceKey: "drag-op" });
    expect(history.transactions().length).toBe(n + 1);
    history.undo();
    expect(history.project.compositions[compId]!.layers.L3!.transform.opacity.value).toBe(100);
  });

  it("refuses parent cycles", () => {
    const { history, compId } = makeProject();
    for (const id of ["A", "B"]) history.apply({ type: "layer.add", args: { compId, layer: newLayer({ id, source: { kind: "null" }, duration: 10 }) } });
    history.apply({ type: "layer.update", args: { compId, layerId: "B", changes: { parentId: "A" } } });
    expect(() => history.apply({ type: "layer.update", args: { compId, layerId: "A", changes: { parentId: "B" } } })).toThrow(/follow itself/);
  });

  it("calibration lock blocks edits until unlocked", () => {
    const { history } = makeProject();
    history.apply({ type: "calibration.lock", args: { venueId: "venue1", projectorId: "p1", locked: true } });
    expect(() => history.apply({ type: "calibration.movePoint", args: { venueId: "venue1", projectorId: "p1", pointId: "c1", output: [5, 5] } })).toThrow(/locked/);
  });
});

describe("recipes", () => {
  it("edge trace generates an editable, deterministic shape layer", () => {
    const { history, compId } = makeProject();
    history.apply({ type: "recipe.apply", args: { instanceId: "r1", recipeId: edgeTrace.id, compId, targets: [{ role: "roofline" }, { role: "windows" }] } });
    const p1 = history.project;
    const layerId = generatedLayerId("r1", "trace");
    const layer = p1.compositions[compId]!.layers[layerId]!;
    expect(layer.source.kind).toBe("shape");
    if (layer.source.kind === "shape") expect(layer.source.contents.length).toBe(7);
    expect(layer.effects[0]!.type).toBe("glow");
    // Regenerating with identical params produces identical layers.
    history.apply({ type: "recipe.update", args: { instanceId: "r1", params: {} } });
    expect(history.project.compositions[compId]!.layers[layerId]).toEqual(layer);
  });

  it("changing simple controls keeps hand edits (overrides) and flags affected controls", () => {
    const { history, compId } = makeProject();
    history.apply({ type: "recipe.apply", args: { instanceId: "r2", recipeId: sequenceLightUp.id, compId, targets: [{ role: "windows" }] } });
    const lid = generatedLayerId("r2", "fills");
    // Person customises the glow radius by hand.
    history.apply({ type: "prop.set", args: { compId, layerId: lid, path: "effects.glow.params.radius", value: 77 } });
    expect(history.project.recipes.r2!.overrides[lid]).toContain("effects.glow.params.radius");
    expect(overriddenParams(sequenceLightUp, history.project.recipes.r2!)).toContain("glow");
    // Then changes the recipe's colour and glow amount via the simple controls.
    history.apply({ type: "recipe.update", args: { instanceId: "r2", params: { color: [1, 0, 0, 1], glow: 90 } } });
    const l = history.project.compositions[compId]!.layers[lid]!;
    expect(l.effects[0]!.params.radius!.value).toBe(77); // custom edit survived
    expect(l.effects[0]!.params.intensity!.value).toBeCloseTo(1.8); // simple control still applied elsewhere
    if (l.source.kind === "shape") expect(l.source.contents[0]!.fill!.color.value).toEqual([1, 0, 0, 1]);
    // Undo the recipe update restores the previous state exactly.
    history.undo();
    const back = history.project.compositions[compId]!.layers[lid]!;
    if (back.source.kind === "shape") expect(back.source.contents[0]!.fill!.color.value).not.toEqual([1, 0, 0, 1]);
    // Reset discards the custom edit.
    history.apply({ type: "recipe.resetOverrides", args: { instanceId: "r2" } });
    expect(history.project.compositions[compId]!.layers[lid]!.effects[0]!.params.radius!.value).not.toBe(77);
  });

  it("orders windows left-to-right row by row and random order is seed-stable", () => {
    const { history } = makeProject();
    const targets = resolveTargets(history.project, [{ role: "windows" }]);
    expect(orderTargets(targets, "left-right", 1).map((t) => t.region.id)).toEqual(["w1", "w4", "w2", "w5", "w3", "w6"]);
    expect(orderTargets(targets, "top-bottom", 1).map((t) => t.region.id)).toEqual(["w1", "w2", "w3", "w4", "w5", "w6"]);
    const r1 = orderTargets(targets, "random", 5).map((t) => t.region.id);
    expect(orderTargets(targets, "random", 5).map((t) => t.region.id)).toEqual(r1);
  });

  it("rebinding the role to another venue retargets the same show", () => {
    const { history, compId } = makeProject();
    history.apply({ type: "recipe.apply", args: { instanceId: "r3", recipeId: sequenceLightUp.id, compId, targets: [{ role: "windows" }] } });
    history.apply({ type: "binding.setRole", args: { venueId: "venue1", role: "windows", regionIds: ["w1", "w2"] } });
    history.apply({ type: "recipe.update", args: { instanceId: "r3", params: {} } });
    const l = history.project.compositions[compId]!.layers[generatedLayerId("r3", "fills")]!;
    if (l.source.kind === "shape") expect(l.source.contents.length).toBe(2);
  });
});

describe("evaluation", () => {
  it("is identical regardless of evaluation order (random access)", () => {
    const { history, compId } = makeProject();
    history.apply({ type: "recipe.apply", args: { instanceId: "r4", recipeId: edgeTrace.id, compId, targets: [{ role: "windows" }] } });
    const p: Project = history.project;
    const times = [0, 37, 3, 299, 150, 1].map((f) => frameToTime(f, RATES.fps30));
    const forward = [...times].sort((a, b) => a - b).map((t) => JSON.stringify(evaluateComp(p, compId, t)));
    const shuffled = times.map((t) => [t, JSON.stringify(evaluateComp(p, compId, t))] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    expect(shuffled).toEqual(forward);
  });

  it("resolves region masks through bindings and respects in/out points", () => {
    const { history, compId } = makeProject();
    const layer: Layer = {
      ...newLayer({ id: "S", source: { kind: "solid", color: staticProp([0, 0.5, 1, 1] as const), width: 1000, height: 700 }, start: secondsToTime(1), duration: secondsToTime(2) }),
      masks: [{ id: "m", name: "Windows", source: { kind: "region", ref: { role: "windows" } }, mode: "add", inverted: false, feather: staticProp(4), expansion: staticProp(0), opacity: staticProp(100) }],
    };
    history.apply({ type: "layer.add", args: { compId, layer } });
    expect(evaluateComp(history.project, compId, secondsToTime(0.5)).layers.length).toBe(0);
    const ev = evaluateComp(history.project, compId, secondsToTime(1.5));
    expect(ev.layers.length).toBe(1);
    expect(ev.layers[0]!.masks[0]!.paths.length).toBe(6);
    expect(ev.layers[0]!.masks[0]!.space).toBe("comp");
    expect(evaluateComp(history.project, compId, secondsToTime(3)).layers.length).toBe(0);
  });
});

describe("cache invalidation", () => {
  it("limits invalidation to the edited layer's time range", () => {
    const { history, compId } = makeProject();
    const a = newLayer({ id: "A", source: { kind: "adjustment" }, start: secondsToTime(2), duration: secondsToTime(3) });
    const b = newLayer({ id: "B", source: { kind: "adjustment" }, start: secondsToTime(6), duration: secondsToTime(2) });
    history.apply([{ type: "layer.add", args: { compId, layer: a } }, { type: "layer.add", args: { compId, layer: b } }]);
    const before = history.project;
    const tx = history.apply({ type: "prop.set", args: { compId, layerId: "A", path: "transform.opacity", value: 50 } });
    const r = affectedByPatches(before, history.project, tx.patches, compId);
    expect(r.all).toBe(false);
    expect(r.ranges).toEqual([[secondsToTime(2), secondsToTime(5)]]);
  });
  it("moving a layer invalidates both its old and new ranges; calibration invalidates nothing", () => {
    const { history, compId } = makeProject();
    history.apply({ type: "layer.add", args: { compId, layer: newLayer({ id: "A", source: { kind: "adjustment" }, start: 0, duration: secondsToTime(1) }) } });
    const before = history.project;
    const tx = history.apply({ type: "layer.update", args: { compId, layerId: "A", changes: { startTime: secondsToTime(4), inPoint: secondsToTime(4), outPoint: secondsToTime(5) } } });
    const r = affectedByPatches(before, history.project, tx.patches, compId);
    expect(r.ranges).toEqual([[0, secondsToTime(1)], [secondsToTime(4), secondsToTime(5)]]);
    const b2 = history.project;
    const cal = history.apply({ type: "calibration.movePoint", args: { venueId: "venue1", projectorId: "p1", pointId: "c1", output: [3, 3] } });
    expect(affectedByPatches(b2, history.project, cal.patches, compId)).toEqual({ all: false, ranges: [] });
  });
  it("region or comp-wide changes invalidate everything", () => {
    const { history, compId } = makeProject();
    const before = history.project;
    const tx = history.apply({ type: "region.update", args: { venueId: "venue1", regionId: "w1", changes: { name: "Renamed" } } });
    expect(affectedByPatches(before, history.project, tx.patches, compId).all).toBe(true);
  });
});

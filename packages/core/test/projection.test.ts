import { describe, expect, it } from "vitest";
import { arrangeProjectors, blendSetup, blendWeight, createRegistry, emptyProject, History, newProjector, type Projector, type Venue, venueBlend } from "../src/index.ts";

// A 2000×500 content canvas lit by two 1200×500 projectors side by side, overlapping by 400 px
// (content x 800..1200).
const canvas = { width: 2000, height: 500 };
const proj = (id: string, x0: number): Projector => {
  const base = newProjector({ canvas }, { id, name: id, width: 1200, height: 500 });
  const pt = (k: string, cx: number, cy: number, ox: number, oy: number) => ({ id: k, label: k, content: [cx, cy] as [number, number], output: [ox, oy] as [number, number] });
  return { ...base, calibration: { ...base.calibration, points: [pt("1", x0, 0, 0, 0), pt("2", x0 + 1200, 0, 1200, 0), pt("3", x0 + 1200, 500, 1200, 500), pt("4", x0, 500, 0, 500)] } };
};
const venue: Venue = { id: "v", name: "Wide wall", kind: "flat", canvas, regionOrder: [], regions: {}, groups: {}, projectorOrder: ["a", "b"], projectors: { a: proj("a", 0), b: proj("b", 800) } };

describe("edge blending", () => {
  const setup = blendSetup(venue);
  const w = (x: number, y: number, i: number) => blendWeight([x, y], i, setup, 2);

  it("shares the light in the overlap so it always adds up to the full amount", () => {
    for (const x of [810, 900, 1000, 1100, 1190])
      for (const y of [50, 250, 450]) {
        expect(w(x, y, 0) + w(x, y, 1)).toBeCloseTo(1, 9);
        expect(w(x, y, 0)).toBeGreaterThan(0);
        expect(w(x, y, 1)).toBeGreaterThan(0);
      }
  });

  it("gives each projector all of the light where it's alone, and fades across the overlap", () => {
    expect(w(400, 250, 0)).toBe(1);
    expect(w(1600, 250, 1)).toBe(1);
    expect(w(400, 250, 1)).toBe(0);
    // Projector a fades out toward its right edge (content x 1200) as b fades in.
    const a = [820, 900, 1000, 1100, 1180].map((x) => w(x, 250, 0));
    for (let i = 1; i < a.length; i++) expect(a[i]!).toBeLessThan(a[i - 1]!);
    // Symmetric overlap: half each in the middle.
    expect(w(1000, 250, 0)).toBeCloseTo(0.5, 9);
  });

  it("uses the curve: straight is linear, higher is a softer S", () => {
    const lin = blendWeight([900, 250], 1, setup, 1);
    const s = blendWeight([900, 250], 1, setup, 2);
    expect(lin).toBeCloseTo(100 / 400, 6);
    expect(s).toBeLessThan(lin);
  });

  it("can be turned off and shaped per venue, undoably", () => {
    expect(venueBlend(venue)).toEqual({ enabled: true, curve: 2 });
    const h = new History(emptyProject("t"), createRegistry());
    h.apply({ type: "venue.add", args: { venue, makeActive: true } });
    h.apply({ type: "venue.setBlend", args: { venueId: "v", enabled: false, curve: 1.5 } });
    expect(venueBlend(h.project.venues["v"]!)).toEqual({ enabled: false, curve: 1.5 });
    h.apply({ type: "projector.update", args: { venueId: "v", projectorId: "b", changes: { name: "Right", output: { width: 2400, height: 1000 } } } });
    const b = h.project.venues["v"]!.projectors["b"]!;
    expect(b.name).toBe("Right");
    // Alignment points scale with the new output size, so the mapping stays the same.
    expect(b.calibration.points[1]!.output).toEqual([2400, 0]);
    h.apply({ type: "projector.remove", args: { venueId: "v", projectorId: "a" } });
    expect(h.project.venues["v"]!.projectorOrder).toEqual(["b"]);
    h.undo();
    expect(h.project.venues["v"]!.projectorOrder).toEqual(["a", "b"]);
  });

  it("arranges projectors side by side with a shared overlap, each slice filling its frame", () => {
    const pts = arrangeProjectors(canvas, [{ width: 1200, height: 500 }, { width: 1200, height: 500 }], "side-by-side", 0.5);
    // Slices of 1333 px overlapping by half a slice: 0..1333 and 667..2000.
    expect(pts[0]![0]!.content[0]).toBe(0);
    expect(pts[1]![1]!.content[0]).toBeCloseTo(2000, 6);
    expect(pts[1]![0]!.content[0]).toBeCloseTo(666.67, 1);
    const v2: Venue = { ...venue, projectors: { a: { ...venue.projectors["a"]!, calibration: { ...venue.projectors["a"]!.calibration, points: pts[0]! } }, b: { ...venue.projectors["b"]!, calibration: { ...venue.projectors["b"]!.calibration, points: pts[1]! } } } };
    const s2 = blendSetup(v2);
    for (const x of [700, 1000, 1300]) expect(blendWeight([x, 250], 0, s2, 2) + blendWeight([x, 250], 1, s2, 2)).toBeCloseTo(1, 9);
    // Each projector lights exactly its slice: alone outside the overlap.
    expect(blendWeight([300, 250], 0, s2, 2)).toBe(1);
    expect(blendWeight([1700, 250], 1, s2, 2)).toBe(1);
    expect(blendWeight([1700, 250], 0, s2, 2)).toBe(0);
  });
});

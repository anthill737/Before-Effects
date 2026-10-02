import { describe, expect, it } from "vitest";
import { evalProp } from "../src/anim.ts";
import { DEFAULT_TIMING, partMotion } from "../src/parts3d.ts";
import { FLICKS_PER_SECOND } from "../src/time.ts";
import { eulerDegToQuat, placePoint, solidWithHoles } from "../src/world3d.ts";
import type { Vec3 } from "../src/model.ts";

const door = { x0: 2, x1: 3, y0: 0.5, y1: 2.6 };
const at = (s: number) => Math.round(s * FLICKS_PER_SECOND);

describe("moving parts", () => {
  it("swings a door about its hinge, into the house", () => {
    const m = partMotion({ kind: "swing", hinge: "left", direction: "in", angle: 90 }, DEFAULT_TIMING, door, 0.06, 0.25, "d");
    expect(m.pivot).toEqual([2, 1.55, 0]);
    const open = evalProp(m.rotation, at(DEFAULT_TIMING.start + DEFAULT_TIMING.move));
    const q = eulerDegToQuat(open as Vec3);
    // The hinge side stays put; the far edge ends up a door-width inside the house.
    const hinge = placePoint([2, 1.55, 0], [0, 0, 0], q, [1, 1, 1], m.pivot);
    const edge = placePoint([3, 1.55, 0], [0, 0, 0], q, [1, 1, 1], m.pivot);
    expect(hinge.map((v) => +v.toFixed(6))).toEqual([2, 1.55, 0]);
    expect(edge[0]).toBeCloseTo(2, 5);
    expect(edge[2]).toBeCloseTo(-1, 5);
    // And it closes again after the hold.
    expect(evalProp(m.rotation, at(10))).toEqual([0, 0, 0]);
    expect(evalProp(m.rotation, at(0))).toEqual([0, 0, 0]);
  });

  it("swings the other way for a right-hand hinge or outward", () => {
    const r = partMotion({ kind: "swing", hinge: "right", direction: "in", angle: 90 }, DEFAULT_TIMING, door, 0.06, 0.25, "d");
    const q = eulerDegToQuat(evalProp(r.rotation, at(3)) as Vec3);
    expect(placePoint([2, 1.55, 0], [0, 0, 0], q, [1, 1, 1], r.pivot)[2]).toBeCloseTo(-1, 5);
    const out = partMotion({ kind: "swing", hinge: "left", direction: "out", angle: 90 }, DEFAULT_TIMING, door, 0.06, 0.25, "d");
    const q2 = eulerDegToQuat(evalProp(out.rotation, at(3)) as Vec3);
    expect(placePoint([3, 1.55, 0], [0, 0, 0], q2, [1, 1, 1], out.pivot)[2]).toBeCloseTo(1, 5);
  });

  it("raises a garage door up behind the wall", () => {
    const g = { x0: -6, x1: -1, y0: 0.6, y1: 3.8 };
    const m = partMotion({ kind: "raise", style: "slide" }, { ...DEFAULT_TIMING, back: false }, g, 0.08, 0.25, "g");
    const up = evalProp(m.position, at(5));
    expect(up[1]).toBeCloseTo(3.2 * 0.98, 5);
    expect(up[2]).toBeLessThan(-0.25);
    expect(m.position.keyframes).toHaveLength(2);
  });

  it("tips an up-and-over garage door back about its top edge", () => {
    const g = { x0: -6, x1: -1, y0: 0.6, y1: 3.8 };
    const m = partMotion({ kind: "raise", style: "tilt" }, DEFAULT_TIMING, g, 0.08, 0.25, "g");
    const q = eulerDegToQuat(evalProp(m.rotation, at(3)) as Vec3);
    const bottom = placePoint([-3.5, 0.6, 0], [0, 0, 0], q, [1, 1, 1], m.pivot);
    expect(bottom[1]).toBeGreaterThan(3.4);
    expect(bottom[2]).toBeLessThan(-3);
  });
});

describe("solids with openings", () => {
  it("keeps openings inside as holes and cuts away openings on the edge", () => {
    const facade: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const window: [number, number][] = [[60, 10], [80, 10], [80, 30], [60, 30]];
    const garage: [number, number][] = [[10, 30], [40, 30], [40, 60], [10, 60]]; // its bottom is the facade's bottom
    const r = solidWithHoles(facade, [window, garage]);
    const area = r.reduce((a, p) => a + Math.abs(p.outline.reduce((s, q, i) => s + q[0] * p.outline[(i + 1) % p.outline.length]![1] - p.outline[(i + 1) % p.outline.length]![0] * q[1], 0) / 2), 0);
    const holes = r.flatMap((p) => p.holes);
    expect(holes).toHaveLength(1);
    expect(area).toBeCloseTo(100 * 60 - 30 * 30, 3);
  });
});

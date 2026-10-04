import { describe, expect, it } from "vitest";
import { frontIrradiance, type LightNow, pictureGain, pictureMix } from "../src/world3d.ts";

const white = [1, 1, 1] as const;
const sun = (position: [number, number, number], intensity: number): LightNow => ({ type: "directional", color: white, intensity, position, target: [0, 0, 0], angle: 35, softness: 0.4 });

describe("picture-faced surfaces show their picture exactly at rest", () => {
  it("a light straight on gives its full strength; at an angle, the cosine", () => {
    expect(frontIrradiance([sun([0, 0, 10], 2)], [0, 0, 0])).toEqual([2, 2, 2]);
    const e = frontIrradiance([sun([0, 10, 10], 2)], [0, 0, 0]);
    expect(e[0]).toBeCloseTo(2 * Math.SQRT1_2, 6);
    // From behind the wall: nothing lands on its front.
    expect(frontIrradiance([sun([0, 0, -10], 2)], [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("a soft fill lights a wall with the average of its sky and ground", () => {
    const fill: LightNow = { type: "ambient", color: [1, 1, 1], ground: [0.2, 0.2, 0.2], intensity: 1, position: [0, 0, 0], target: [0, 0, 0], angle: 35, softness: 0.4 };
    expect(frontIrradiance([fill], [0, 0, 0])[1]).toBeCloseTo(0.6, 6);
  });

  it("point lights fall off with distance; spots only light inside their cone", () => {
    const point: LightNow = { type: "point", color: white, intensity: 1, position: [0, 0, 5], target: [0, 0, 0], angle: 35, softness: 0.4 };
    expect(frontIrradiance([point], [0, 0, 0])[0]).toBeCloseTo(50 / 25, 6);
    const spotAway: LightNow = { ...point, type: "spot", target: [100, 0, 5], angle: 10 };
    expect(frontIrradiance([spotAway], [0, 0, 0])[0]).toBe(0);
    const spotOn: LightNow = { ...point, type: "spot", target: [0, 0, 0], angle: 30 };
    expect(frontIrradiance([spotOn], [0, 0, 0])[0]).toBeCloseTo(2, 6);
  });

  it("the gain undoes the lighting (surface shows a·E/π), per colour, within limits", () => {
    const e = frontIrradiance([sun([-4.6, 8, 9], 2), { type: "ambient", color: [0.9, 0.95, 1], ground: [0.1, 0.1, 0.1], intensity: 0.9, position: [0, 0, 0], target: [0, 0, 0], angle: 35, softness: 0.4 }], [0, 0, 0]);
    const g = pictureGain(e);
    for (let i = 0; i < 3; i++) expect((g[i]! * e[i]!) / Math.PI).toBeCloseTo(1, 6);
    // Warmer light: the gain cools the picture back to its own colours.
    const warm = pictureGain(frontIrradiance([{ ...sun([0, 0, 10], 3), color: [1, 0.8, 0.6] }], [0, 0, 0]));
    expect(warm[2]).toBeGreaterThan(warm[0]);
    // No light: left alone; overwhelming light: limited.
    expect(pictureGain([0, 0, 0])).toEqual([1, 1, 1]);
    expect(pictureGain([1e6, 1e6, 1e6])).toEqual([0.05, 0.05, 0.05]);
  });
});

describe("how a picture surface is made from its picture", () => {
  const gain = [2, 2.5, 3];
  it("by default: all shaded by the lights, evened out (exact at rest), no self-light", () => {
    expect(pictureMix({}, 0, gain)).toEqual({ lit: [2, 2.5, 3], self: 0 });
  });
  it("shading 0 is the picture itself whichever way it turns; in between, part of each", () => {
    expect(pictureMix({ shading: 0 }, 0, gain)).toEqual({ lit: [0, 0, 0], self: 1 });
    const m = pictureMix({ shading: 0.4 }, 0, gain);
    expect(m.self).toBeCloseTo(0.6, 9);
    expect(m.lit[0]).toBeCloseTo(0.8, 9);
    // Facing the audience at rest (light × gain / π = 1 for the lit part): still exactly the picture.
    expect(m.self + m.lit[0] / gain[0]!).toBeCloseTo(1, 9);
  });
  it("glow adds the picture shining by itself; not matching takes the lights as they fall", () => {
    expect(pictureMix({}, 0.5, gain).self).toBe(0.5);
    expect(pictureMix({ matchPicture: false }, 0, gain).lit).toEqual([1, 1, 1]);
    expect(pictureMix({ shading: 7 }, -1, gain)).toEqual({ lit: [2, 2.5, 3], self: 0 });
  });
});

describe("which lights even out the picture", () => {
  it("counts sun and fill lights as the picture's own lighting, and adds spot and point lights on top", async () => {
    const { balancesPicture, frontIrradiance, pictureGain } = await import("../src/world3d.ts");
    expect(balancesPicture({ type: "directional" })).toBe(true);
    expect(balancesPicture({ type: "ambient" })).toBe(true);
    expect(balancesPicture({ type: "spot" })).toBe(false);
    expect(balancesPicture({ type: "point" })).toBe(false);
    expect(balancesPicture({ type: "point", balance: true })).toBe(true);
    expect(balancesPicture({ type: "directional", balance: false })).toBe(false);
    // A wall lit by a sun and a passing lantern: evened out by the sun only, so the lantern brightens it.
    const sun = { type: "directional" as const, color: [1, 1, 1] as const, intensity: 3, position: [0, 5, 10] as [number, number, number], target: [0, 0, 0] as [number, number, number], angle: 30, softness: 0, balance: true };
    const lantern = { type: "point" as const, color: [1, 0.8, 0.5] as const, intensity: 2, position: [1, 2, 1.5] as [number, number, number], target: [0, 0, 0] as [number, number, number], angle: 30, softness: 0, balance: false };
    const at: [number, number, number] = [1, 2, 0];
    const gain = pictureGain(frontIrradiance([sun, lantern].filter((l) => l.balance), at));
    const shown = frontIrradiance([sun, lantern], at).map((e, i) => (e * gain[i]!) / Math.PI);
    expect(shown[0]).toBeGreaterThan(1.5); // brighter than the picture where the lantern shines
    const away = frontIrradiance([sun, lantern], [-14, 2, 0]).map((e, i) => (e * gain[i]!) / Math.PI);
    expect(away[0]).toBeLessThan(1.1); // and close to exact where it doesn't
  });
});

import { describe, expect, it } from "vitest";
import { frontIrradiance, type LightNow, pictureGain } from "../src/world3d.ts";

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

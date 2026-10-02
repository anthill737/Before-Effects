import { describe, expect, it } from "vitest";
import { type BitMask, fillPolygon } from "../src/houseDetect.ts";
import { consensusLine, fitRectsToPhoto, type Picture, removeDarkTop, squareBottom, straightBottomRuns } from "../src/houseRefine.ts";
import type { Vec2 } from "../src/model.ts";

const W = 480, H = 360;
/** A synthetic photo: a brick-coloured wall with shapes painted on it (and a little texture). */
const picture = (paint: (x: number, y: number) => [number, number, number] | null): Picture => {
  const data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const mortar = y % 9 === 0 ? 40 : 0;
      const c = paint(x, y) ?? [120 + mortar, 78 + mortar, 64 + mortar];
      data.set(c, (y * W + x) * 3);
    }
  return { width: W, height: H, channels: 3, data };
};
const inside = (q: readonly Vec2[], [x, y]: Vec2) => {
  let c = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i]!, [xj, yj] = q[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const mask = (fill: (x: number, y: number) => boolean): BitMask => {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = fill(x, y) ? 1 : 0;
  return { width: W, height: H, data };
};
const near = (a: readonly Vec2[], b: readonly Vec2[], tol: number) => a.every((p, i) => Math.hypot(p[0] - b[i]![0], p[1] - b[i]![1]) <= tol);

describe("fitting rectangular parts to the photo", () => {
  // Three white doors leaning with the camera's perspective (vertical edges converge upward).
  const lean = (x: number) => (x - 240) / 2400;
  const door = (x0: number, w: number): Vec2[] => {
    const y0 = 80, y1 = 300;
    return [[x0 + lean(x0) * 110, y0], [x0 + w + lean(x0 + w) * 110, y0], [x0 + w - lean(x0 + w) * 110, y1], [x0 - lean(x0) * 110, y1]];
  };
  const doors = [door(40, 90), door(200, 80), door(350, 90)];
  // A shadow falls diagonally across the middle door's upper left.
  const img = picture((x, y) => {
    const d = doors.find((q) => inside(q, [x, y]));
    if (!d) return null;
    return d === doors[1] && y < 200 && x < 200 + (200 - y) * 0.6 ? [120, 122, 128] : [235, 236, 238];
  });
  const boxOf = (q: readonly Vec2[], pad: number) => ({ x0: Math.min(...q.map((p) => p[0])) - pad, y0: 80 - pad, x1: Math.max(...q.map((p) => p[0])) + pad, y1: 300 + pad });

  it("finds each door's corners from a loose box, at the perspective lean, despite a shadow", () => {
    const fits = fitRectsToPhoto(img, doors.map((q, i) => ({ key: `d${i}`, kind: "door", box: boxOf(q, 10) })));
    doors.forEach((q, i) => expect(near(fits.get(`d${i}`)!, q, 3)).toBe(true));
  });
});

describe("the facade's bottom edge", () => {
  it("closes a notch between wall on both sides, but not the eave overhang at the end", () => {
    // Wall bottom at 300; a 20 px slot up to 200 at x 300–320; at the right end (x 440–470) only
    // an eave reaching down to 60.
    const m = mask((x, y) => (x >= 20 && x < 440 && y >= 40 && y <= 300 && !(x >= 300 && x < 320 && y > 200)) || (x >= 440 && x < 470 && y >= 40 && y <= 60));
    const r = squareBottom(m, 120, 2);
    expect(r.data[290 * W + 310]).toBe(1); // the slot is filled
    expect(r.data[200 * W + 455]).toBe(0); // nothing under the eave
  });

  it("straightens a run of wall along its bottom course, ignoring dips and notches", () => {
    const m = mask((x, y) => x >= 20 && x < 460 && y >= 40 && y <= (x > 60 && x < 120 ? 330 : x > 200 && x < 240 ? 250 : 300));
    const r = straightBottomRuns(m, [], 100, 60);
    expect(r.data[320 * W + 90]).toBe(0); // the dip into the foundation is gone
    expect(r.data[299 * W + 220]).toBe(1); // the notch is filled to the course
  });

  it("finds the line most points agree with", () => {
    const pts: Vec2[] = [];
    for (let x = 0; x < 200; x += 2) pts.push([x, x % 10 < 6 ? 50 + x * 0.05 : 120 - x * 0.3]); // 60% on the line, 40% stray
    const l = consensusLine(pts, 2)!;
    expect(Math.abs(l.d[1] / l.d[0] - 0.05)).toBeLessThan(0.01);
  });
});

describe("dark roof surfaces", () => {
  it("removes shingles joined to the top, keeps the gutter and the shaded soffit under it", () => {
    // Shingles (dark) 40–100, gutter (bright) 100–110, soffit (shaded, darkish) 110–130, wall below.
    const img = picture((_x, y) => (y < 100 ? [50, 50, 55] : y < 110 ? [210, 210, 212] : y < 130 ? [75, 72, 70] : null));
    const facade = mask((x, y) => x >= 20 && x < 460 && y >= 40 && y < 330);
    const roof = fillPolygon(mask(() => false), [[20, 40], [460, 40], [460, 130], [20, 130]]);
    const r = removeDarkTop(facade, img, roof, 0.31);
    expect(r.mask.data[70 * W + 200]).toBe(0);
    expect(r.mask.data[105 * W + 200]).toBe(1);
    expect(r.mask.data[120 * W + 200]).toBe(1);
  });
});

/** Checking projected outlines against the building's edges (verify.ts), and phone-movement detection. */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { GrayImage } from "../src/renderer/src/studio/align/autoMatch.ts";
import { readyCv } from "../src/renderer/src/studio/align/autoMatch.ts";
import { cameraMoved, verifyOutlines } from "../src/renderer/src/studio/align/verify.ts";

const W = 960, H = 540;
const img = (f: (x: number, y: number) => number): GrayImage => {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = Math.max(0, Math.min(255, Math.round(f(x, y))));
  return { width: W, height: H, data };
};
let seed = 5;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 4294967296 - 0.5) * 6;
};
type R = [number, number, number, number];
const windows: R[] = [
  [100, 100, 220, 260],
  [400, 120, 520, 280],
  [700, 300, 840, 460],
];
const inside = (x: number, y: number, r: R) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
// The house lit white: wall with texture, darker windows with frames.
const lit = img((x, y) => (windows.some((r) => inside(x, y, r)) ? 70 : 180) + 10 * Math.sin(x / 9) * Math.cos(y / 13) + noise());
const black = img(() => 12 + noise());
/** The projected outlines, drawn `d` pixels off the windows' real edges (and no outline for the blank area). */
const outlines = (d: [number, number], rects: R[]) =>
  img((x, y) => {
    const on = rects.some((r) => {
      const a: R = [r[0] + d[0], r[1] + d[1], r[2] + d[0], r[3] + d[1]];
      const nearV = (Math.abs(x - a[0]) <= 1 || Math.abs(x - a[2]) <= 1) && y >= a[1] && y <= a[3];
      const nearH = (Math.abs(y - a[1]) <= 1 || Math.abs(y - a[3]) <= 1) && x >= a[0] && x <= a[2];
      return nearV || nearH;
    });
    return 12 + (on ? 160 : 0) + noise();
  });
const poly = (r: R): Array<[number, number]> => [
  [r[0], r[1]],
  [r[2], r[1]],
  [r[2], r[3]],
  [r[0], r[3]],
];

describe("checking projected outlines against the building", () => {
  const req = createRequire(import.meta.url);
  const cvP = readyCv(req("@techstark/opencv-js"));

  it("measures how far each area's projected outline is from the real edges", async () => {
    const cv = await cvP;
    const r = verifyOutlines(cv, { lit, black, outlines: outlines([4, -3], windows), areas: windows.map((w, i) => ({ id: `w${i}`, name: `window ${i}`, cameraPolygon: poly(w) })) });
    for (const a of r.areas) {
      expect(a.status).toBe("off");
      // Within a pixel (edges are found to about that).
      expect(Math.abs(a.shift![0] + 4)).toBeLessThan(1);
      expect(Math.abs(a.shift![1] - 3)).toBeLessThan(1);
    }
    const ok = verifyOutlines(cv, { lit, black, outlines: outlines([0, 0], windows), areas: windows.map((w, i) => ({ id: `w${i}`, name: `window ${i}`, cameraPolygon: poly(w) })) });
    console.log("aligned case:", JSON.stringify(ok.areas.map((a) => [a.status, a.shift?.map((v) => v.toFixed(2))])));
    expect(ok.areas.every((a) => a.status === "aligned")).toBe(true);
  });

  it("says 'unverified' where the building shows no edges, or where several positions fit", async () => {
    const cv = await cvP;
    const blank: R = [300, 380, 420, 500]; // plain wall: no edges there
    const r = verifyOutlines(cv, { lit, black, outlines: outlines([0, 0], [blank]), areas: [{ id: "b", name: "blank", cameraPolygon: poly(blank) }] });
    expect(r.areas[0]!.status).toBe("unverified");
    // Regular stripes (like siding): many shifts fit as well as the right one.
    const stripes = img((x) => (Math.floor(x / 6) % 2 ? 60 : 190) + noise());
    const area: R = [300, 200, 600, 400];
    const s = verifyOutlines(cv, { lit: stripes, black, outlines: outlines([3, 0], [area]), areas: [{ id: "s", name: "siding", cameraPolygon: poly(area) }] });
    expect(s.areas[0]!.status).not.toBe("aligned");
  });

  it("notices when the phone moved, and not when only the projected light changed", async () => {
    const cv = await cvP;
    const shifted = img((x, y) => lit.data[Math.min(H - 1, Math.max(0, y + 3)) * W + Math.min(W - 1, Math.max(0, x - 5))]!);
    const moved = cameraMoved(cv, lit, shifted);
    expect(moved.verdict).toBe("moved");
    const same = cameraMoved(cv, lit, img((x, y) => lit.data[y * W + x]! * 0.85 + noise()));
    expect(same.verdict).toBe("still");
  });
});

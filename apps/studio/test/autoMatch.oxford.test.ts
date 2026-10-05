/**
 * Automatic matching on independent real photographs: the Oxford VGG affine-covariant benchmark
 * (Mikolajczyk et al. 2005) — "wall" (viewpoint change on a brick wall), "leuven" (lighting),
 * "graf" (viewpoint, painted wall), "boat" (zoom + rotation) — with their ground-truth homographies.
 * The images aren't in the repository: set OXFORD_DIR to a folder with the extracted sequences
 * (https://www.robots.ox.ac.uk/~vgg/research/affine/), otherwise this is skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type GrayImage, type MatchArea, matchViews, readyCv } from "../src/renderer/src/studio/align/autoMatch.ts";

const DIR = process.env.OXFORD_DIR ?? "";
const run = DIR && existsSync(join(DIR, "wall", "img1.ppm")) ? describe : describe.skip;

/** Binary PPM (P6) / PGM (P5) → greyscale. */
const readPnm = (file: string): GrayImage => {
  const b = readFileSync(file);
  let pos = 0;
  const token = () => {
    for (;;) {
      while (b[pos]! <= 32) pos++;
      if (b[pos] === 35) while (b[pos] !== 10) pos++;
      else break;
    }
    const s = pos;
    while (b[pos]! > 32) pos++;
    return b.toString("ascii", s, pos);
  };
  const magic = token();
  const width = Number(token()), height = Number(token());
  token();
  pos++;
  const data = new Uint8Array(width * height);
  if (magic === "P5") data.set(b.subarray(pos, pos + width * height));
  else for (let i = 0; i < width * height; i++) data[i] = (77 * b[pos + 3 * i]! + 150 * b[pos + 3 * i + 1]! + 29 * b[pos + 3 * i + 2]!) >> 8;
  return { width, height, data };
};
const readH = (file: string): number[] => readFileSync(file, "utf8").trim().split(/\s+/).map(Number);
const apply = (H: readonly number[], p: [number, number]): [number, number] => {
  const w = H[6]! * p[0] + H[7]! * p[1] + H[8]!;
  return [(H[0]! * p[0] + H[1]! * p[1] + H[2]!) / w, (H[3]! * p[0] + H[4]! * p[1] + H[5]!) / w];
};
const convexHull2 = (pts: Array<[number, number]>): Array<[number, number]> => {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lo: Array<[number, number]> = [], up: Array<[number, number]> = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of [...p].reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop();
    up.push(q);
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
};
const insideConvex = (q: [number, number], h: Array<[number, number]>) => h.every((a, i) => {
  const b = h[(i + 1) % h.length]!;
  return (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) >= 0;
});
const img = (seq: string, n: number) => readPnm(join(DIR, seq, `img${n}.${seq === "boat" ? "pgm" : "ppm"}`));
/** A 3×3 grid of rectangular "areas" over the middle of the first image (to exercise per-area matching). */
const gridAreas = (w: number, h: number): MatchArea[] => {
  const out: MatchArea[] = [];
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++) {
      const x0 = w * (0.2 + i * 0.22), y0 = h * (0.2 + j * 0.22), x1 = x0 + w * 0.14, y1 = y0 + h * 0.14;
      out.push({ id: `a${i}${j}`, name: `area ${i},${j}`, polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
    }
  return out;
};

run("automatic matching on real photographs (Oxford affine benchmark)", () => {
  const req = createRequire(import.meta.url);
  const cvP = readyCv(req("@techstark/opencv-js"));
  const rows: string[] = [];

  for (const seq of ["wall", "leuven", "graf", "boat"])
    it(`${seq}: finds the true homography where the views are matchable, and says so when not`, async () => {
      const cv = await cvP;
      const a = img(seq, 1);
      for (let k = 2; k <= 6; k++) {
        const b = img(seq, k);
        const gt = readH(join(DIR, seq, `H1to${k}p`));
        const areas = gridAreas(a.width, a.height);
        const r = matchViews(cv, a, [{ name: "view", image: b }], areas);
        // Error over the part of the first image that's visible in the second (a 20×20 grid).
        const visible: Array<[number, number]> = [];
        for (let j = 0; j < 20; j++)
          for (let i = 0; i < 20; i++) {
            const q: [number, number] = [((i + 0.5) / 20) * a.width, ((j + 0.5) / 20) * a.height];
            const t = apply(gt, q);
            if (t[0] >= 0 && t[1] >= 0 && t[0] < b.width && t[1] < b.height) visible.push(q);
          }
        const errAt = (c: [number, number]) => Math.hypot(apply(r.H!, c)[0] - apply(gt, c)[0], apply(r.H!, c)[1] - apply(gt, c)[1]);
        const err = r.H ? Math.max(...visible.map(errAt)) : Number.POSITIVE_INFINITY;
        // Where the answer is supported: inside the hull of the matched points.
        const support = [...r.pairs, ...r.validation].filter((p) => p.source === "feature").map((p) => p.photo as [number, number]);
        const hull = convexHull2(support);
        const supported = visible.filter((q) => hull.length >= 3 && insideConvex(q, hull));
        const errSupported = r.H && supported.length ? Math.max(...supported.map(errAt)) : Number.POSITIVE_INFINITY;
        // Area pairs (photo → camera from per-area matching) against the truth.
        const areaErr = r.pairs.filter((p) => p.source !== "feature").map((p) => Math.hypot(apply(gt, p.photo as [number, number])[0] - p.camera[0], apply(gt, p.photo as [number, number])[1] - p.camera[1]));
        const am = areaErr.length ? [...areaErr].sort((x, y) => x - y)[Math.floor(areaErr.length / 2)]! : null;
        rows.push(`${seq} 1→${k}: ${r.ok ? r.confidence : "FAILED"} · ${r.stats.inliers}/${r.stats.matches} matches · worst error where matched ${Number.isFinite(errSupported) ? errSupported.toFixed(1) : "—"} px (whole visible part ${Number.isFinite(err) ? err.toFixed(1) : "—"} px) · areas found ${r.areas.filter((x) => x.status === "matched").length}/9 (ambiguous ${r.areas.filter((x) => x.status === "ambiguous").length}), area points median error ${am == null ? "—" : am.toFixed(1)} px · ${r.ms} ms`);
        // Never a confident wrong answer: success must mean close to the truth.
        if (r.ok && r.confidence !== "low") expect(errSupported).toBeLessThan(15);
        if (r.ok && am !== null) expect(am).toBeLessThan(8);
      }
    }, 600_000);

  it("refuses unrelated pictures (no false success)", async () => {
    const cv = await cvP;
    const pairs: Array<[string, number, string, number]> = [
      ["wall", 1, "graf", 1],
      ["leuven", 1, "boat", 1],
      ["graf", 1, "boat", 3],
    ];
    for (const [s1, n1, s2, n2] of pairs) {
      const r = matchViews(cv, img(s1, n1), [{ name: "view", image: img(s2, n2) }], []);
      rows.push(`unrelated ${s1}/${n1} vs ${s2}/${n2}: ${r.ok ? `ok (${r.confidence})` : "refused"} · ${r.stats.inliers}/${r.stats.matches} — ${r.reason.slice(0, 80)}`);
      expect(r.ok && r.confidence !== "low").toBe(false);
    }
    console.log(`\n${rows.join("\n")}`);
  }, 600_000);
});

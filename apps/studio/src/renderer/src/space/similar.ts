/**
 * "Find similar": after one window is traced, look for other places in the photo that look like
 * it (normalised cross-correlation on a downscaled grayscale copy). Results are only suggestions:
 * shown dashed, each can be kept or dropped, and every accepted outline stays editable. This is
 * 2D pattern matching on a photo, not 3D reconstruction.
 */
import { type PathData, pathBounds, type Vec2 } from "@be/core";

const WORK_WIDTH = 320;

const grayscale = async (photo: Blob, w: number, h: number): Promise<Float32Array> => {
  const bmp = await createImageBitmap(photo, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
  return out;
};

const translate = (p: PathData, dx: number, dy: number): PathData => ({
  closed: p.closed,
  vertices: p.vertices.map((v) => ({ ...v, p: [v.p[0] + dx, v.p[1] + dy] as Vec2 })),
});

export interface Match {
  readonly path: PathData;
  readonly score: number;
}

export const findSimilar = async (
  photo: Blob,
  canvas: { width: number; height: number },
  template: PathData,
  existing: readonly PathData[],
  threshold = 0.6,
): Promise<Match[]> => {
  const k = WORK_WIDTH / canvas.width;
  const W = WORK_WIDTH;
  const H = Math.max(8, Math.round(canvas.height * k));
  const img = await grayscale(photo, W, H);
  const b = pathBounds([template]);
  const tx = Math.max(0, Math.round(b.x * k));
  const ty = Math.max(0, Math.round(b.y * k));
  const tw = Math.max(4, Math.round(b.w * k));
  const th = Math.max(4, Math.round(b.h * k));
  if (tx + tw > W || ty + th > H) return [];
  // Template statistics.
  const T = new Float32Array(tw * th);
  let tSum = 0;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) tSum += T[y * tw + x] = img[(ty + y) * W + tx + x]!;
  const tMean = tSum / T.length;
  let tVar = 0;
  for (let i = 0; i < T.length; i++) {
    T[i]! -= tMean;
    tVar += T[i]! * T[i]!;
  }
  if (tVar < 1e-3) return [];
  // Integral images for window sums and sums of squares.
  const I = new Float64Array((W + 1) * (H + 1));
  const I2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    let row2 = 0;
    for (let x = 0; x < W; x++) {
      const v = img[y * W + x]!;
      row += v;
      row2 += v * v;
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1]! + row;
      I2[(y + 1) * (W + 1) + x + 1] = I2[y * (W + 1) + x + 1]! + row2;
    }
  }
  const rect = (A: Float64Array, x: number, y: number) =>
    A[(y + th) * (W + 1) + x + tw]! - A[y * (W + 1) + x + tw]! - A[(y + th) * (W + 1) + x]! + A[y * (W + 1) + x]!;
  const n = tw * th;
  const scores: Array<{ x: number; y: number; s: number }> = [];
  for (let y = 0; y + th <= H; y++) {
    for (let x = 0; x + tw <= W; x++) {
      const sum = rect(I, x, y);
      const sq = rect(I2, x, y);
      const varW = sq - (sum * sum) / n;
      if (varW < 1e-3) continue;
      let cross = 0;
      for (let j = 0; j < th; j++) {
        const o = (y + j) * W + x;
        const to = j * tw;
        for (let i = 0; i < tw; i++) cross += img[o + i]! * T[to + i]!;
      }
      const s = cross / Math.sqrt(varW * tVar);
      if (s >= threshold) scores.push({ x, y, s });
    }
  }
  // Keep the best match in each neighbourhood, away from already traced regions.
  scores.sort((a, b2) => b2.s - a.s);
  const taken: Array<{ x: number; y: number }> = [];
  const existingBoxes = existing.map((p) => pathBounds([p]));
  const out: Match[] = [];
  for (const c of scores) {
    if (taken.some((t) => Math.abs(t.x - c.x) < tw * 0.7 && Math.abs(t.y - c.y) < th * 0.7)) continue;
    const cx = c.x / k;
    const cy = c.y / k;
    const overlaps = existingBoxes.some((e) => {
      const ix = Math.max(0, Math.min(e.x + e.w, cx + b.w) - Math.max(e.x, cx));
      const iy = Math.max(0, Math.min(e.y + e.h, cy + b.h) - Math.max(e.y, cy));
      return ix * iy > 0.3 * b.w * b.h;
    });
    taken.push(c);
    if (overlaps) continue;
    out.push({ path: translate(template, cx - b.x, cy - b.y), score: c.s });
    if (out.length >= 60) break;
  }
  return out;
};

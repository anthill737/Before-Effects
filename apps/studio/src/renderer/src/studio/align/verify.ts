/**
 * Closed-loop checks for auto-align (OpenCV.js; worker in the app, Node in tests).
 *
 * verifyOutlines: with the alignment applied, the house areas' outlines are projected and photographed.
 * Each area's projected outline is compared with the building's own edges in the picture of the house
 * lit white (Canny edges; chamfer matching on their distance transform — Barrow et al. 1977, Borgefors
 * 1988): the shift that best lays the projected lines onto real edges is how far that area is off.
 * This uses none of the points the alignment was fitted to. Areas whose outline isn't seen, or where
 * the building shows no matching edges, are reported unverified — never as aligned.
 *
 * cameraMoved: whether two pictures from the phone show the house from the same place (features on
 * the static building, robust homography; the projected light moving doesn't count).
 */
import type { Vec2 } from "@be/core";
import type { Cv, GrayImage } from "./autoMatch.ts";

const toMat = (cv: Cv, g: GrayImage) => {
  const m = new cv.Mat(g.height, g.width, cv.CV_8UC1);
  m.data.set(g.data);
  return m;
};

export interface OutlineCheckArea {
  readonly id: string;
  readonly name: string;
  /** Where the area's outline should appear in the camera picture (from the camera ↔ photo relation). */
  readonly cameraPolygon: readonly Vec2[];
}

export interface OutlineCheck {
  readonly id: string;
  readonly name: string;
  readonly status: "aligned" | "off" | "unverified";
  /** Camera-pixel shift from the projected outline to the building's edges (null when unverified). */
  readonly shift: Vec2 | null;
  /** Mean distance (camera px) from the projected outline to the nearest edge, as is and at the best shift. */
  readonly costNow: number;
  readonly costBest: number;
  /** Outline pixels seen. */
  readonly pixels: number;
  readonly note: string;
}

const distToSegment = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

export const verifyOutlines = (
  cv: Cv,
  o: { lit: GrayImage; black: GrayImage; outlines: GrayImage; areas: readonly OutlineCheckArea[]; maxShift?: number; band?: number },
): { areas: OutlineCheck[]; linePixels: number; edgePixels: number } => {
  const S = Math.round(o.maxShift ?? 14);
  const band = o.band ?? 14;
  const w = o.lit.width, h = o.lit.height;
  // Projected lines: brighter than with the projector black.
  const lines = new Uint8Array(w * h);
  let linePixels = 0;
  for (let i = 0; i < w * h; i++)
    if (o.outlines.data[i]! - o.black.data[i]! > 28) {
      lines[i] = 1;
      linePixels++;
    }
  // The building's edges inside the lit area (not the edge of the projector's picture), split by
  // orientation: oriented chamfer matching (Shotton et al. 2008) — a vertical outline is compared only
  // with vertical edges, a horizontal one with horizontal edges, so texture can't stand in for them.
  const lit = toMat(cv, o.lit);
  const blur = new cv.Mat();
  cv.GaussianBlur(lit, blur, new cv.Size(5, 5), 1.4);
  const edges = new cv.Mat();
  cv.Canny(blur, edges, 30, 90);
  const gx = new cv.Mat(), gy = new cv.Mat();
  cv.Sobel(blur, gx, cv.CV_32F, 1, 0, 3);
  cv.Sobel(blur, gy, cv.CV_32F, 0, 1, 3);
  const GX = gx.data32F as Float32Array, GY = gy.data32F as Float32Array;
  const litMask = new cv.Mat(h, w, cv.CV_8UC1);
  for (let i = 0; i < w * h; i++) litMask.data[i] = o.lit.data[i]! - o.black.data[i]! > 20 ? 255 : 0;
  const eroded = new cv.Mat();
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(11, 11));
  cv.erode(litMask, eroded, k);
  const vEdges = new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(255)); // inverted: 0 where an edge is
  const hEdges = new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(255));
  let edgePixels = 0;
  for (let i = 0; i < w * h; i++) {
    if (!eroded.data[i] || !edges.data[i]) continue;
    edgePixels++;
    const ax = Math.abs(GX[i]!), ay = Math.abs(GY[i]!);
    // Gradient across x: a vertical edge. Near-diagonal edges count for both.
    if (ax >= 0.5 * ay) vEdges.data[i] = 0;
    if (ay >= 0.5 * ax) hEdges.data[i] = 0;
  }
  const dtV = new cv.Mat(), dtH = new cv.Mat();
  cv.distanceTransform(vEdges, dtV, cv.DIST_L2, 3);
  cv.distanceTransform(hEdges, dtH, cv.DIST_L2, 3);
  const DV = dtV.data32F as Float32Array, DH = dtH.data32F as Float32Array;
  const cap = S + 4;
  const dist = (D: Float32Array, x: number, y: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return cap;
    return Math.min(cap, D[yi * w + xi]!);
  };
  const out: OutlineCheck[] = [];
  for (const a of o.areas) {
    const poly = a.cameraPolygon;
    const base = { id: a.id, name: a.name };
    if (poly.length < 3) {
      out.push({ ...base, status: "unverified", shift: null, costNow: cap, costBest: cap, pixels: 0, note: "Outside the camera picture." });
      continue;
    }
    const cx = poly.reduce((t, p) => t + p[0], 0) / poly.length, cy = poly.reduce((t, p) => t + p[1], 0) / poly.length;
    // This area's projected line pixels, each with the outline segment it belongs to: its orientation
    // (vertical → tells x, horizontal → tells y) and side (left/right, top/bottom of the area).
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - band)), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs) + band));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - band)), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys) + band));
    type P = { x: number; y: number; vertical: boolean; side: number };
    const pts: P[] = [];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (!lines[y * w + x]) continue;
        let d = Infinity, seg = 0;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const dd = distToSegment([x, y], poly[j]!, poly[i]!);
          if (dd < d) {
            d = dd;
            seg = i;
          }
        }
        if (d > band) continue;
        const A = poly[(seg + poly.length - 1) % poly.length]!, B = poly[seg]!;
        const vertical = Math.abs(B[1] - A[1]) > Math.abs(B[0] - A[0]);
        const mid: Vec2 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
        pts.push({ x, y, vertical, side: vertical ? Math.sign(mid[0] - cx) : Math.sign(mid[1] - cy) });
      }
    const step = Math.max(1, Math.ceil(pts.length / 2000));
    const sample = pts.filter((_, i) => i % step === 0);
    if (sample.length < 40) {
      out.push({ ...base, status: "unverified", shift: null, costNow: cap, costBest: cap, pixels: pts.length, note: "Its projected outline isn't visible to the camera (hidden, too dark, or outside the picture)." });
      continue;
    }
    // Truncated (robust) chamfer: stretches of outline with no edge behind them (section lines, sky)
    // count the same at any shift instead of swamping the rest.
    const TAU = 3;
    const costOf = (ps: P[], dx: number, dy: number) => ps.reduce((t, p) => t + Math.min(TAU, dist(p.vertical ? DV : DH, p.x + dx, p.y + dy)), 0) / Math.max(1, ps.length);
    const onEdge = (ps: P[], dx: number, dy: number) => ps.filter((p) => dist(p.vertical ? DV : DH, p.x + dx, p.y + dy) <= 1.5).length / Math.max(1, ps.length);
    const search = (ps: P[], fix?: { dx?: number; dy?: number }) => {
      let best = { dx: 0, dy: 0, c: Infinity };
      const grid = new Map<string, number>();
      for (let dy = -S; dy <= S; dy++)
        for (let dx = -S; dx <= S; dx++) {
          if (fix?.dx !== undefined && dx !== fix.dx) continue;
          if (fix?.dy !== undefined && dy !== fix.dy) continue;
          const c = costOf(ps, dx, dy);
          grid.set(`${dx},${dy}`, c);
          if (c < best.c) best = { dx, dy, c };
        }
      return { best, grid };
    };
    const { best, grid } = search(sample);
    const g = (dx: number, dy: number) => grid.get(`${dx},${dy}`) ?? costOf(sample, dx, dy);
    const sub = (m: number, c0: number, p: number) => (Math.abs(m - 2 * c0 + p) > 1e-6 ? (0.5 * (m - p)) / (m - 2 * c0 + p) : 0);
    const fx = best.dx + Math.max(-0.5, Math.min(0.5, sub(g(best.dx - 1, best.dy), best.c, g(best.dx + 1, best.dy))));
    const fy = best.dy + Math.max(-0.5, Math.min(0.5, sub(g(best.dx, best.dy - 1), best.c, g(best.dx, best.dy + 1))));
    // Opposite sides must agree: left and right edges on the x shift, top and bottom on the y shift.
    // (Window frames have several parallel edges; one side alone can lock onto the wrong one.)
    const sideShift = (vertical: boolean, side: number) => {
      const ps = sample.filter((p) => p.vertical === vertical && p.side === side);
      if (ps.length < 15) return null;
      const r = search(ps, vertical ? { dy: best.dy } : { dx: best.dx }).best;
      return vertical ? r.dx : r.dy;
    };
    const L = sideShift(true, -1), Rr = sideShift(true, 1), T = sideShift(false, -1), Bt = sideShift(false, 1);
    const disagree = (L !== null && Rr !== null && Math.abs(L - Rr) > 1.5) || (T !== null && Bt !== null && Math.abs(T - Bt) > 1.5);
    const xChecked = L !== null && Rr !== null, yChecked = T !== null && Bt !== null;
    let second = Infinity;
    for (const [key, c] of grid) {
      const [dx, dy] = key.split(",").map(Number);
      if (Math.hypot(dx! - best.dx, dy! - best.dy) > 4) second = Math.min(second, c);
    }
    const costNow = g(0, 0);
    const mag = Math.hypot(fx, fy);
    let status: OutlineCheck["status"];
    let note: string;
    const support = onEdge(sample, best.dx, best.dy);
    if (support < 0.25) {
      status = "unverified";
      note = "The building shows no clear edges along most of this area's outline — can't confirm it from the picture.";
    } else if (disagree) {
      status = "unverified";
      note = "Its sides point to different corrections (several parallel edges, e.g. a frame) — can't tell which is right.";
    } else if (second < best.c * 1.1 && mag > 1.5) {
      status = "unverified";
      note = "Several positions fit the building's edges about equally well — can't tell which is right.";
    } else if (mag <= 1.5) {
      status = "aligned";
      note = "The projected outline lies on the building's edges.";
    } else if ((Math.abs(fx) > 1.5 && !xChecked) || (Math.abs(fy) > 1.5 && !yChecked)) {
      // A correction needs both opposite sides seen agreeing; one side alone isn't enough to act on.
      status = "unverified";
      note = `Looks ${mag.toFixed(1)} camera px off, but only one side of it could be checked — not corrected automatically.`;
    } else {
      status = "off";
      note = `The projected outline is ${mag.toFixed(1)} camera px from the building's edges (both sides agree).`;
    }
    out.push({ ...base, status, shift: status === "unverified" ? null : [fx, fy], costNow, costBest: best.c, pixels: pts.length, note });
  }
  for (const m of [lit, blur, edges, gx, gy, litMask, eroded, k, vEdges, hEdges, dtV, dtH]) m.delete();
  return { areas: out, linePixels, edgePixels };
};

/** Whether the phone moved between two pictures of the house: features on the building, robust homography. */
export const cameraMoved = (cv: Cv, before: GrayImage, after: GrayImage): { verdict: "still" | "moved" | "unknown"; shiftPx: number | null; matches: number; note: string } => {
  const size = 1200;
  const prep = (g: GrayImage) => {
    const m = toMat(cv, g);
    const s = Math.min(1, size / Math.max(g.width, g.height));
    const r = new cv.Mat();
    cv.resize(m, r, new cv.Size(Math.round(g.width * s), Math.round(g.height * s)), 0, 0, cv.INTER_AREA);
    const e = new cv.Mat();
    const c = new cv.CLAHE(2.5, new cv.Size(8, 8));
    c.apply(r, e);
    c.delete();
    m.delete();
    r.delete();
    const det = new cv.AKAZE();
    const kps = new cv.KeyPointVector(), desc = new cv.Mat(), none = new cv.Mat();
    det.detectAndCompute(e, none, kps, desc);
    const pts: Vec2[] = [];
    for (let i = 0; i < kps.size(); i++) pts.push([kps.get(i).pt.x / s, kps.get(i).pt.y / s]);
    det.delete();
    kps.delete();
    none.delete();
    e.delete();
    return { pts, desc };
  };
  const a = prep(before), b = prep(after);
  const src: number[] = [], dst: number[] = [];
  if (a.desc.rows >= 2 && b.desc.rows >= 2) {
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    const mm = new cv.DMatchVectorVector();
    bf.knnMatch(a.desc, b.desc, mm, 2);
    for (let i = 0; i < mm.size(); i++) {
      const v = mm.get(i);
      if (v.size() < 2) continue;
      const m0 = v.get(0), m1 = v.get(1);
      if (m0.distance < 0.75 * m1.distance) {
        src.push(...a.pts[m0.queryIdx]!);
        dst.push(...b.pts[m0.trainIdx]!);
      }
    }
    mm.delete();
    bf.delete();
  }
  a.desc.delete();
  b.desc.delete();
  const n = src.length / 2;
  if (n < 15) return { verdict: "unknown", shiftPx: null, matches: n, note: "Too little detail in the pictures to tell whether the phone moved." };
  const s = cv.matFromArray(n, 1, cv.CV_32FC2, src), d = cv.matFromArray(n, 1, cv.CV_32FC2, dst), mask = new cv.Mat();
  const H = cv.findHomography(s, d, cv.USAC_MAGSAC, 2, mask, 5000, 0.999);
  s.delete();
  d.delete();
  const flags = mask.rows ? Array.from(mask.data as Uint8Array) : [];
  const inl = flags.filter(Boolean).length;
  mask.delete();
  H?.delete?.();
  if (inl < 12) return { verdict: "moved", shiftPx: null, matches: inl, note: "The pictures don't line up — the phone was moved (or something big changed in view)." };
  // How far the building's features moved, measured where they are (no extrapolation to the corners).
  const moves = flags.flatMap((f, i) => (f ? [Math.hypot(dst[i * 2]! - src[i * 2]!, dst[i * 2 + 1]! - src[i * 2 + 1]!)] : [])).sort((a, b) => a - b);
  const shift = moves[Math.floor(moves.length / 2)]!;
  return shift > 1.5 ? { verdict: "moved", shiftPx: shift, matches: inl, note: `The phone's view moved by about ${shift.toFixed(0)} px since the points were matched.` } : { verdict: "still", shiftPx: shift, matches: inl, note: "The phone hasn't moved." };
};

/**
 * Check the alignment by projecting the house photo through it. Dividing the camera picture of that by
 * the picture of the house lit white leaves only where the projected photo landed (the building's own
 * colours cancel). Where aligned, the projected texture sits on the building's own texture; per area,
 * the shift between the two (masked template matching on image structure, small search, a second
 * nearly-as-good position means ambiguous) is how far that area is off. Uses none of the fitted points.
 */
export const verifyProjectedPhoto = (
  cv: Cv,
  o: { lit: GrayImage; black: GrayImage; projected: GrayImage; areas: readonly OutlineCheckArea[]; maxShift?: number },
): { areas: OutlineCheck[] } => {
  const S = Math.round(o.maxShift ?? 10);
  const w = o.lit.width, h = o.lit.height;
  const ratio = new cv.Mat(h, w, cv.CV_8UC1);
  const lit = new cv.Mat(h, w, cv.CV_8UC1);
  for (let i = 0; i < w * h; i++) {
    const L = o.lit.data[i]! - o.black.data[i]!;
    const V = o.projected.data[i]! - o.black.data[i]!;
    ratio.data[i] = L >= 20 ? Math.max(0, Math.min(255, Math.round((255 * V) / L))) : 0;
    lit.data[i] = Math.max(0, L);
  }
  const sR = structureOf(cv, ratio), sL = structureOf(cv, lit);
  const out: OutlineCheck[] = [];
  for (const a of o.areas) {
    const base = { id: a.id, name: a.name };
    const poly = a.cameraPolygon;
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const bx0 = Math.floor(Math.min(...xs)), by0 = Math.floor(Math.min(...ys)), bx1 = Math.ceil(Math.max(...xs)), by1 = Math.ceil(Math.max(...ys));
    if (poly.length < 3 || bx0 - S < 0 || by0 - S < 0 || bx1 + S >= w || by1 + S >= h || bx1 - bx0 < 10 || by1 - by0 < 10) {
      out.push({ ...base, status: "unverified", shift: null, costNow: 0, costBest: 0, pixels: 0, note: "Outside the camera picture (or too small in it)." });
      continue;
    }
    const mask = cv.Mat.zeros(by1 - by0, bx1 - bx0, cv.CV_8UC1);
    const pm = cv.matFromArray(poly.length, 1, cv.CV_32SC2, poly.flatMap((p) => [Math.round(p[0] - bx0), Math.round(p[1] - by0)]));
    const mv = new cv.MatVector();
    mv.push_back(pm);
    cv.fillPoly(mask, mv, new cv.Scalar(255));
    mv.delete();
    pm.delete();
    // Only where the projector lights it (else the ratio means nothing).
    let litPx = 0;
    for (let y = 0; y < mask.rows; y++)
      for (let x = 0; x < mask.cols; x++) {
        const k = y * mask.cols + x;
        if (!mask.data[k]) continue;
        const i = (by0 + y) * w + bx0 + x;
        if (o.lit.data[i]! - o.black.data[i]! < 20) mask.data[k] = 0;
        else litPx++;
      }
    if (litPx < 200) {
      mask.delete();
      out.push({ ...base, status: "unverified", shift: null, costNow: 0, costBest: 0, pixels: litPx, note: "Not lit by the projector where the camera can see it." });
      continue;
    }
    const tplBox = sR.roi(new cv.Rect(bx0, by0, bx1 - bx0, by1 - by0));
    const tpl = new cv.Mat();
    tplBox.copyTo(tpl, mask);
    tplBox.delete();
    const win = sL.roi(new cv.Rect(bx0 - S, by0 - S, bx1 - bx0 + 2 * S, by1 - by0 + 2 * S));
    const res = new cv.Mat();
    try {
      cv.matchTemplate(win, tpl, res, cv.TM_CCOEFF_NORMED, mask);
    } catch {
      cv.matchTemplate(win, tpl, res, cv.TM_CCOEFF_NORMED);
    }
    const mm = cv.minMaxLoc(res);
    const peak = mm.maxVal as number;
    const at = mm.maxLoc as { x: number; y: number };
    const val = (x: number, y: number) => (x >= 0 && y >= 0 && x < res.cols && y < res.rows ? (res.floatAt(y, x) as number) : peak);
    // Confirming needs a clear peak in both directions: along a plain column or a long edge the match
    // is flat one way, and a small "best" shift there means nothing.
    let secondX = -1, secondY = -1;
    for (let x = 0; x < res.cols; x++) if (Math.abs(x - at.x) > 3) secondX = Math.max(secondX, res.floatAt(at.y, x) as number);
    for (let y = 0; y < res.rows; y++) if (Math.abs(y - at.y) > 3) secondY = Math.max(secondY, res.floatAt(y, at.x) as number);
    const flatX = secondX > peak - 0.06, flatY = secondY > peak - 0.06;
    const sub = (m: number, c: number, p: number) => (Math.abs(m - 2 * c + p) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (m - p)) / (m - 2 * c + p))) : 0);
    const fx = at.x - S + sub(val(at.x - 1, at.y), peak, val(at.x + 1, at.y));
    const fy = at.y - S + sub(val(at.x, at.y - 1), peak, val(at.x, at.y + 1));
    const now = val(S, S);
    for (const m of [mask, tpl, win, res]) m.delete();
    const mag = Math.hypot(fx, fy);
    let status: OutlineCheck["status"];
    let note: string;
    if (peak < 0.35) {
      status = "unverified";
      note = "The projected picture doesn't resemble the building here (different from the photo, or too little detail) — can't confirm it.";
    } else if (flatX || flatY) {
      status = "unverified";
      note = `Too little detail ${flatX && flatY ? "" : flatX ? "across it " : "along it "}to tell its position from the picture (plain or repeating surface).`;
    } else if (mag <= 1.5) {
      status = "aligned";
      note = "The projected picture lies on the building's own detail.";
    } else {
      status = "off";
      note = `The projected picture is ${mag.toFixed(1)} camera px from the building's own detail.`;
    }
    out.push({ ...base, status, shift: status === "unverified" ? null : [fx, fy], costNow: now, costBest: peak, pixels: litPx, note });
  }
  sR.delete();
  sL.delete();
  ratio.delete();
  lit.delete();
  return { areas: out };
};

/** Gradient magnitude, smoothed (structure, not brightness). */
const structureOf = (cv: Cv, m: Cv) => {
  const f = new cv.Mat(), gx = new cv.Mat(), gy = new cv.Mat(), mag = new cv.Mat(), out = new cv.Mat();
  m.convertTo(f, cv.CV_32F);
  cv.Sobel(f, gx, cv.CV_32F, 1, 0, 3);
  cv.Sobel(f, gy, cv.CV_32F, 0, 1, 3);
  cv.magnitude(gx, gy, mag);
  cv.GaussianBlur(mag, out, new cv.Size(5, 5), 1.2);
  for (const x of [f, gx, gy, mag]) x.delete();
  return out;
};

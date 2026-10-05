/**
 * Automatic matching of the phone's view to the house photo (OpenCV.js; runs in a worker in the app
 * and in Node in tests).
 *
 *  1. Global: local features — AKAZE (Alcantarilla et al. 2013) and ORB (Rublee et al. 2011) — on
 *     contrast-equalised (CLAHE) images, matched both ways with Lowe's ratio test (2004), then a robust
 *     homography (MAGSAC++, Barath et al. 2020, OpenCV USAC). Several camera views are tried (the house
 *     lit white by the projector, and with the projector black) and the best kept.
 *  2. Per house area: the photo, warped by that homography, is compared with the camera picture
 *     around each area on image structure (gradient magnitude, robust to day/night lighting): template
 *     matching inside a small search window gives the area's shift — a second peak nearly as good
 *     means it's ambiguous (repeated windows) and is reported, not used — then ECC (Evangelidis &
 *     Psarakis 2008) refines it to an affine correction. Areas that stand out or sit back get their
 *     own correction from this.
 *  3. Pairs (photo ↔ camera) for the calibration, with a held-out share for checking it.
 */
import type { Vec2 } from "@be/core";

// biome-ignore lint/suspicious/noExplicitAny: OpenCV.js has no types
export type Cv = any;

export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface MatchArea {
  readonly id: string;
  readonly name: string;
  /** Outline in photo (venue canvas) pixels. */
  readonly polygon: readonly Vec2[];
}

export interface AreaMatch {
  readonly id: string;
  readonly name: string;
  readonly status: "matched" | "ambiguous" | "weak" | "outside";
  /** Template-match score (−1…1) and the runner-up's, for ambiguity. */
  readonly score: number;
  readonly second: number;
  /** Camera-pixel shift found around the global homography's prediction. */
  readonly shift: Vec2 | null;
  /** Affine (2×3, camera pixels) applied after the global homography for this area. */
  readonly affine: readonly number[] | null;
  readonly note: string;
}

export interface MatchPair {
  readonly camera: Vec2;
  readonly photo: Vec2;
  /** "feature": a global feature match; otherwise the area it was placed in. */
  readonly source: string;
}

export interface MatchResult {
  readonly ok: boolean;
  readonly confidence: "high" | "medium" | "low" | "none";
  readonly reason: string;
  /** Photo → camera homography (row-major 3×3), when found. */
  readonly H: readonly number[] | null;
  readonly view: string | null;
  readonly stats: { readonly photoFeatures: number; readonly cameraFeatures: number; readonly matches: number; readonly inliers: number; readonly inlierShare: number; readonly coverage: number; readonly medianErrorPx: number | null };
  readonly areas: readonly AreaMatch[];
  /** For fitting the calibration. */
  readonly pairs: readonly MatchPair[];
  /** Held out from fitting, to measure it. */
  readonly validation: readonly MatchPair[];
  readonly ms: number;
}

// ---------------------------------------------------------------------------------------------

const toMat = (cv: Cv, g: GrayImage) => {
  const m = new cv.Mat(g.height, g.width, cv.CV_8UC1);
  m.data.set(g.data);
  return m;
};

const resized = (cv: Cv, m: Cv, maxDim: number): { mat: Cv; scale: number } => {
  const s = Math.min(1, maxDim / Math.max(m.cols, m.rows));
  const out = new cv.Mat();
  if (s < 1) cv.resize(m, out, new cv.Size(Math.round(m.cols * s), Math.round(m.rows * s)), 0, 0, cv.INTER_AREA);
  else m.copyTo(out);
  return { mat: out, scale: s };
};

const equalized = (cv: Cv, m: Cv) => {
  const out = new cv.Mat();
  const c = new cv.CLAHE(2.5, new cv.Size(8, 8));
  c.apply(m, out);
  c.delete();
  return out;
};

/** Gradient magnitude, smoothed: compares structure (edges) rather than brightness. */
const structure = (cv: Cv, m: Cv) => {
  const gx = new cv.Mat(), gy = new cv.Mat(), mag = new cv.Mat(), out = new cv.Mat();
  const f = new cv.Mat();
  m.convertTo(f, cv.CV_32F);
  cv.Sobel(f, gx, cv.CV_32F, 1, 0, 3);
  cv.Sobel(f, gy, cv.CV_32F, 0, 1, 3);
  cv.magnitude(gx, gy, mag);
  cv.GaussianBlur(mag, out, new cv.Size(5, 5), 1.2);
  for (const x of [gx, gy, mag, f]) x.delete();
  return out;
};

interface Features {
  readonly pts: Vec2[];
  readonly desc: Cv;
}
const detect = (cv: Cv, m: Cv, kind: "akaze" | "orb", mask?: Cv): Features => {
  const det = kind === "akaze" ? new cv.AKAZE() : new cv.ORB(5000);
  if (kind === "akaze") {
    try {
      det.setThreshold(0.0005);
    } catch {
      // older builds: the default threshold
    }
  }
  const kps = new cv.KeyPointVector();
  const desc = new cv.Mat();
  const noMask = new cv.Mat();
  det.detectAndCompute(m, mask ?? noMask, kps, desc);
  const pts: Vec2[] = [];
  for (let i = 0; i < kps.size(); i++) {
    const k = kps.get(i);
    pts.push([k.pt.x, k.pt.y]);
  }
  kps.delete();
  det.delete();
  noMask.delete();
  return { pts, desc };
};

/** Mutual nearest neighbours passing the ratio test. */
const matchFeatures = (cv: Cv, a: Features, b: Features, ratio = 0.8): Array<[number, number]> => {
  if (a.desc.rows < 2 || b.desc.rows < 2) return [];
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const best = (q: Cv, t: Cv) => {
    const mm = new cv.DMatchVectorVector();
    bf.knnMatch(q, t, mm, 2);
    const out = new Map<number, number>();
    for (let i = 0; i < mm.size(); i++) {
      const v = mm.get(i);
      if (v.size() < 2) continue;
      const m0 = v.get(0), m1 = v.get(1);
      if (m0.distance < ratio * m1.distance) out.set(m0.queryIdx, m0.trainIdx);
    }
    mm.delete();
    return out;
  };
  const ab = best(a.desc, b.desc);
  const ba = best(b.desc, a.desc);
  bf.delete();
  const out: Array<[number, number]> = [];
  for (const [i, j] of ab) if (ba.get(j) === i) out.push([i, j]);
  return out;
};

const homography = (cv: Cv, src: Vec2[], dst: Vec2[], thresh: number): { H: number[]; inliers: boolean[] } | null => {
  if (src.length < 8) return null;
  const s = cv.matFromArray(src.length, 1, cv.CV_32FC2, src.flat());
  const d = cv.matFromArray(dst.length, 1, cv.CV_32FC2, dst.flat());
  const mask = new cv.Mat();
  let H: Cv;
  try {
    H = cv.findHomography(s, d, cv.USAC_MAGSAC, thresh, mask, 10000, 0.999);
  } catch {
    H = cv.findHomography(s, d, cv.RANSAC, thresh, mask, 5000, 0.995);
  }
  s.delete();
  d.delete();
  if (!H || H.empty() || H.rows !== 3) {
    mask.delete();
    H?.delete?.();
    return null;
  }
  const h = Array.from(H.data64F as Float64Array);
  const inliers = Array.from(mask.data as Uint8Array, (v) => v !== 0);
  H.delete();
  mask.delete();
  return { H: h, inliers };
};

const applyH = (H: readonly number[], p: Vec2): Vec2 => {
  const w = H[6]! * p[0] + H[7]! * p[1] + H[8]!;
  return [(H[0]! * p[0] + H[1]! * p[1] + H[2]!) / w, (H[3]! * p[0] + H[4]! * p[1] + H[5]!) / w];
};

const hullArea = (pts: Vec2[]): number => {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return 0;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Vec2[] = [], up: Vec2[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of [...p].reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop();
    up.push(q);
  }
  const h = [...lo.slice(0, -1), ...up.slice(0, -1)];
  let a = 0;
  for (let i = 0, j = h.length - 1; i < h.length; j = i++) a += (h[j]![0] + h[i]![0]) * (h[j]![1] - h[i]![1]);
  return Math.abs(a / 2);
};

const inside = (p: Vec2, poly: readonly Vec2[]) => {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) r = !r;
  }
  return r;
};

/** A homography that doesn't fold or blow up over the region it's used on. */
const plausible = (H: readonly number[], box: { x0: number; y0: number; x1: number; y1: number }): boolean => {
  const c = [applyH(H, [box.x0, box.y0]), applyH(H, [box.x1, box.y0]), applyH(H, [box.x1, box.y1]), applyH(H, [box.x0, box.y1])];
  if (c.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i]!, b = c[(i + 1) % 4]!, d = c[(i + 2) % 4]!;
    const z = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (sign === 0) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) return false;
  }
  const area = hullArea(c);
  const src = (box.x1 - box.x0) * (box.y1 - box.y0);
  return area > src * 0.01 && area < src * 100;
};

let seedState = 1;
const rand = () => {
  seedState = (seedState * 1664525 + 1013904223) >>> 0;
  return seedState / 4294967296;
};

export interface MatchOptions {
  /** Longest side the images are reduced to for features. */
  readonly featureSize?: number;
  /** Search radius around each area's predicted place, as a share of the camera picture's width. */
  readonly searchShare?: number;
  /** Share of feature matches held out for checking (0–0.5). */
  readonly holdOut?: number;
}

/**
 * Match the camera's views (e.g. house lit white, projector black) to the house photo.
 * `photo` and `views` are greyscale; areas are in photo pixels.
 */
export const matchViews = (cv: Cv, photo: GrayImage, views: ReadonlyArray<{ name: string; image: GrayImage }>, areas: readonly MatchArea[], o: MatchOptions = {}): MatchResult => {
  const t0 = Date.now();
  seedState = 7;
  const size = o.featureSize ?? 1400;
  const photoMat = toMat(cv, photo);
  const pr = resized(cv, photoMat, size);
  const pEq = equalized(cv, pr.mat);
  const pFeat = { akaze: detect(cv, pEq, "akaze"), orb: detect(cv, pEq, "orb") };
  const housebox = areas.length
    ? areas.reduce((b, a) => ({ x0: Math.min(b.x0, ...a.polygon.map((p) => p[0])), y0: Math.min(b.y0, ...a.polygon.map((p) => p[1])), x1: Math.max(b.x1, ...a.polygon.map((p) => p[0])), y1: Math.max(b.y1, ...a.polygon.map((p) => p[1])) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
    : { x0: 0, y0: 0, x1: photo.width, y1: photo.height };
  const boxArea = Math.max(1, (housebox.x1 - housebox.x0) * (housebox.y1 - housebox.y0));

  type Cand = { view: string; image: GrayImage; H: number[]; src: Vec2[]; dst: Vec2[]; inl: boolean[]; feats: number; matches: number; coverage: number; score: number; med: number };
  let best: Cand | null = null;
  let camFeatCount = 0;
  for (const v of views) {
    const camMat = toMat(cv, v.image);
    const cr = resized(cv, camMat, size);
    const cEq = equalized(cv, cr.mat);
    const cFeat = { akaze: detect(cv, cEq, "akaze"), orb: detect(cv, cEq, "orb") };
    const src: Vec2[] = [], dst: Vec2[] = [];
    for (const k of ["akaze", "orb"] as const) {
      for (const [i, j] of matchFeatures(cv, pFeat[k], cFeat[k])) {
        const a = pFeat[k].pts[i]!, b = cFeat[k].pts[j]!;
        src.push([a[0] / pr.scale, a[1] / pr.scale]);
        dst.push([b[0] / cr.scale, b[1] / cr.scale]);
      }
    }
    const feats = cFeat.akaze.pts.length + cFeat.orb.pts.length;
    camFeatCount = Math.max(camFeatCount, feats);
    const thresh = 0.006 * Math.hypot(v.image.width, v.image.height);
    const h = homography(cv, src, dst, thresh);
    if (h && plausible(h.H, housebox)) {
      const ins = src.filter((_, i) => h.inliers[i]);
      const coverage = hullArea(ins) / boxArea;
      const errs = src.map((p, i) => (h.inliers[i] ? Math.hypot(applyH(h.H, p)[0] - dst[i]![0], applyH(h.H, p)[1] - dst[i]![1]) : -1)).filter((e) => e >= 0).sort((a, b) => a - b);
      const n = ins.length;
      const score = n * Math.min(1, coverage * 2);
      if (!best || score > best.score) best = { view: v.name, image: v.image, H: h.H, src, dst, inl: h.inliers, feats, matches: src.length, coverage, score, med: errs[Math.floor(errs.length / 2)] ?? 0 };
    }
    for (const m of [camMat, cr.mat, cEq, cFeat.akaze.desc, cFeat.orb.desc]) m.delete();
  }
  const photoFeatures = pFeat.akaze.pts.length + pFeat.orb.pts.length;
  for (const m of [photoMat, pr.mat, pEq, pFeat.akaze.desc, pFeat.orb.desc]) m.delete();

  const fail = (reason: string, stats?: Partial<MatchResult["stats"]>): MatchResult => ({
    ok: false,
    confidence: "none",
    reason,
    H: best?.H ?? null,
    view: best?.view ?? null,
    stats: { photoFeatures, cameraFeatures: camFeatCount, matches: best?.matches ?? 0, inliers: 0, inlierShare: 0, coverage: 0, medianErrorPx: null, ...stats },
    areas: [],
    pairs: [],
    validation: [],
    ms: Date.now() - t0,
  });
  if (!best) return fail("The camera picture and the house photo have no consistent matches — the view may show a different part of the house, or look too different from the photo (e.g. decorations, sheets, darkness).");
  const inliers = best.inl.filter(Boolean).length;
  const inlierShare = inliers / Math.max(1, best.matches);
  const stats = { photoFeatures, cameraFeatures: camFeatCount, matches: best.matches, inliers, inlierShare, coverage: best.coverage, medianErrorPx: best.med };
  // Too few, too clustered, or too inconsistent: not trustworthy.
  if (inliers < 20 || best.coverage < 0.08 || inlierShare < 0.06)
    return fail(`Too few consistent matches (${inliers} of ${best.matches}, covering ${Math.round(best.coverage * 100)}% of the house) to trust — mark points by hand.`, stats);
  const confidence: MatchResult["confidence"] = inliers >= 60 && best.coverage >= 0.3 && inlierShare >= 0.15 ? "high" : inliers >= 30 && best.coverage >= 0.15 ? "medium" : "low";

  // ---- per area ----------------------------------------------------------------------------
  const cam = best.image;
  const camMat = toMat(cv, cam);
  const camStruct = structure(cv, camMat);
  const photoMat2 = toMat(cv, photo);
  const Hm = cv.matFromArray(3, 3, cv.CV_64F, best.H);
  const warped = new cv.Mat();
  cv.warpPerspective(photoMat2, warped, Hm, new cv.Size(cam.width, cam.height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
  const warpedStruct = structure(cv, warped);
  // Where the warped photo has content at all (outside it, the template is empty).
  const R = Math.max(10, Math.round((o.searchShare ?? 0.03) * cam.width));
  const areaMatches: AreaMatch[] = [];
  const areaPairs: MatchPair[] = [];
  const areaChecks: MatchPair[] = [];
  for (const a of areas) {
    if (a.polygon.length < 3) continue;
    const pc = a.polygon.map((q) => applyH(best!.H, q));
    const xs = pc.map((p) => p[0]), ys = pc.map((p) => p[1]);
    const m = Math.max(6, 0.15 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
    const bx0 = Math.floor(Math.min(...xs) - m), by0 = Math.floor(Math.min(...ys) - m), bx1 = Math.ceil(Math.max(...xs) + m), by1 = Math.ceil(Math.max(...ys) + m);
    const base = { id: a.id, name: a.name };
    if (bx0 - R < 0 || by0 - R < 0 || bx1 + R >= cam.width || by1 + R >= cam.height || bx1 - bx0 < 12 || by1 - by0 < 12) {
      areaMatches.push({ ...base, status: "outside", score: 0, second: 0, shift: null, affine: null, note: "Outside the camera picture (or too small in it)." });
      continue;
    }
    // Only the area itself counts: around a recessed door or a column, the wall moves differently.
    const tplBox = warpedStruct.roi(new cv.Rect(bx0, by0, bx1 - bx0, by1 - by0));
    const mask = cv.Mat.zeros(by1 - by0, bx1 - bx0, cv.CV_8UC1);
    const polyMat = cv.matFromArray(pc.length, 1, cv.CV_32SC2, pc.flatMap((p) => [Math.round(p[0] - bx0), Math.round(p[1] - by0)]));
    const polys = new cv.MatVector();
    polys.push_back(polyMat);
    cv.fillPoly(mask, polys, new cv.Scalar(255));
    polys.delete();
    polyMat.delete();
    const tpl = new cv.Mat();
    tplBox.copyTo(tpl, mask);
    tplBox.delete();
    const win = camStruct.roi(new cv.Rect(bx0 - R, by0 - R, bx1 - bx0 + 2 * R, by1 - by0 + 2 * R));
    const res = new cv.Mat();
    try {
      cv.matchTemplate(win, tpl, res, cv.TM_CCOEFF_NORMED, mask);
    } catch {
      cv.matchTemplate(win, tpl, res, cv.TM_CCOEFF_NORMED);
    }
    mask.delete();
    const mm = cv.minMaxLoc(res);
    const peak = mm.maxVal as number;
    const at = mm.maxLoc as { x: number; y: number };
    // Runner-up outside the peak's neighbourhood: a near-equal second peak means repeated features.
    const sup = Math.max(3, Math.min(Math.floor(R / 2), Math.round(0.1 * Math.min(bx1 - bx0, by1 - by0))));
    let second = -1;
    for (let y = 0; y < res.rows; y++)
      for (let x = 0; x < res.cols; x++) {
        if (Math.abs(x - at.x) <= sup && Math.abs(y - at.y) <= sup) continue;
        const v = res.floatAt(y, x) as number;
        if (v > second) second = v;
      }
    // Sub-pixel: a parabola through the peak's neighbours in x and in y.
    const val = (x: number, y: number) => (x >= 0 && y >= 0 && x < res.cols && y < res.rows ? (res.floatAt(y, x) as number) : peak);
    const sub = (m: number, c: number, p: number) => (Math.abs(m - 2 * c + p) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (m - p)) / (m - 2 * c + p))) : 0);
    const fx = sub(val(at.x - 1, at.y), peak, val(at.x + 1, at.y));
    const fy = sub(val(at.x, at.y - 1), peak, val(at.x, at.y + 1));
    res.delete();
    const shift: Vec2 = [at.x - R + fx, at.y - R + fy];
    let status: AreaMatch["status"] = "matched";
    let note = "Found.";
    if (peak < 0.3) {
      status = "weak";
      note = "Not recognisable in the camera picture (too dark, covered, or different from the photo).";
    } else if (second > peak - 0.06) {
      status = "ambiguous";
      note = "Looks like a neighbouring feature too (repeated windows?) — not used automatically.";
    }
    // (ECC refinement isn't used: its mask applies to the camera picture, not the template, so the
    // wall around a recessed or proud area would bias it; the masked match above doesn't.)
    const affine: number[] | null = null;
    tpl.delete();
    win.delete();
    areaMatches.push({ ...base, status, score: peak, second, shift: status === "matched" ? shift : null, affine, note });
    if (status !== "matched") continue;
    // Pairs inside the area: four points around its middle and its centre (held out).
    const cx = a.polygon.reduce((t, p) => t + p[0], 0) / a.polygon.length;
    const cy = a.polygon.reduce((t, p) => t + p[1], 0) / a.polygon.length;
    const toCam = (q: Vec2): Vec2 => {
      const p = applyH(best!.H, q);
      // The area's correction, relative to its box's corner.
      const lx = p[0] - bx0, ly = p[1] - by0;
      if (affine) return [bx0 + affine[0]! * lx + affine[1]! * ly + affine[2]!, by0 + affine[3]! * lx + affine[4]! * ly + affine[5]!];
      return [p[0] + shift[0], p[1] + shift[1]];
    };
    const pts = a.polygon.map((q) => [cx + 0.6 * (q[0] - cx), cy + 0.6 * (q[1] - cy)] as Vec2).filter((q) => inside(q, a.polygon));
    // Up to 5 spread points from the shrunken outline.
    const pick = pts.length <= 5 ? pts : [0, 1, 2, 3, 4].map((k) => pts[Math.floor((k * pts.length) / 5)]!);
    for (const q of pick) areaPairs.push({ photo: q, camera: toCam(q), source: a.id });
    if (inside([cx, cy], a.polygon)) areaChecks.push({ photo: [cx, cy], camera: toCam([cx, cy]), source: a.id });
  }
  for (const m of [camMat, camStruct, photoMat2, Hm, warped, warpedStruct]) m.delete();

  // ---- feature pairs, split into fitting and checking ------------------------------------------
  const feat: MatchPair[] = [];
  best.src.forEach((p, i) => {
    if (best!.inl[i]) feat.push({ photo: p, camera: best!.dst[i]!, source: "feature" });
  });
  // Spread out: at most one per grid cell (dense clusters would dominate the fit).
  const cell = Math.max(photo.width, photo.height) / 40;
  const seen = new Set<string>();
  const spread = feat.filter((f) => {
    const k = `${Math.floor(f.photo[0] / cell)},${Math.floor(f.photo[1] / cell)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const hold = o.holdOut ?? 0.25;
  const fitF: MatchPair[] = [], checkF: MatchPair[] = [];
  for (const f of spread) (rand() < hold ? checkF : fitF).push(f);
  const matchedAreas = areaMatches.filter((a) => a.status === "matched").length;
  // Re-estimate the overall homography from the feature matches and the (more precise) area matches.
  let H = best.H;
  if (areaPairs.length >= 8) {
    const all = [...feat, ...areaPairs, ...areaPairs];
    const s = cv.matFromArray(all.length, 1, cv.CV_32FC2, all.flatMap((p) => [p.photo[0], p.photo[1]]));
    const d = cv.matFromArray(all.length, 1, cv.CV_32FC2, all.flatMap((p) => [p.camera[0], p.camera[1]]));
    const Hr = cv.findHomography(s, d, 0);
    if (Hr && !Hr.empty() && Hr.rows === 3) {
      const h = Array.from(Hr.data64F as Float64Array);
      if (plausible(h, housebox)) H = h;
    }
    Hr?.delete?.();
    s.delete();
    d.delete();
  }
  // Much more (or less) detail in the camera than in the photo: the photo's own precision limits the result.
  const c0 = applyH(H, [(housebox.x0 + housebox.x1) / 2, (housebox.y0 + housebox.y1) / 2]);
  const c1 = applyH(H, [(housebox.x0 + housebox.x1) / 2 + 10, (housebox.y0 + housebox.y1) / 2]);
  const zoom = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) / 10;
  const conf: MatchResult["confidence"] = (zoom > 2 || zoom < 0.33) && confidence === "high" ? "medium" : confidence;
  return {
    ok: true,
    confidence: conf,
    reason: `${inliers} consistent matches (${Math.round(inlierShare * 100)}% of ${best.matches}) covering ${Math.round(best.coverage * 100)}% of the house; ${matchedAreas} of ${areaMatches.length} areas found.${conf !== confidence ? ` The camera sees the house at ${zoom.toFixed(1)}× the photo's detail, which limits precision.` : ""}`,
    H,
    view: best.view,
    stats,
    areas: areaMatches,
    pairs: [...fitF.slice(0, 220), ...areaPairs],
    validation: [...checkF.slice(0, 80), ...areaChecks],
    ms: Date.now() - t0,
  };
};

/**
 * OpenCV.js, ready to use. The module object has a `then` of its own (Emscripten), so it must never be
 * returned from an async function or awaited as-is (promises would follow its `then` forever): wait
 * for the runtime explicitly, then drop `then`.
 */
export const readyCv = (mod: unknown): Promise<Cv> =>
  new Promise((resolve) => {
    let done = false;
    // biome-ignore lint/suspicious/noExplicitAny: OpenCV.js
    const finish = (m: any) => {
      if (done) return;
      done = true;
      if (typeof m.then === "function") delete m.then;
      resolve(m);
    };
    // biome-ignore lint/suspicious/noExplicitAny: OpenCV.js
    const watch = (m: any) => {
      if (m.Mat) return finish(m);
      m.onRuntimeInitialized = () => finish(m);
      // Some builds finish starting before the callback is attached: watch for it too.
      const t = setInterval(() => {
        if (m.Mat) {
          clearInterval(t);
          finish(m);
        }
      }, 50);
    };
    // biome-ignore lint/suspicious/noExplicitAny: OpenCV.js
    const cv: any = (mod as { default?: unknown }).default ?? mod;
    // A promise of the module (some builds): take its value through then, never by awaiting it.
    if (cv instanceof Promise) cv.then((m: unknown) => watch(m));
    else watch(cv);
  });

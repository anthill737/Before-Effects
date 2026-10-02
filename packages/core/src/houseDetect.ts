/**
 * Automatic house setup, the model-free half: turning raw detections (an open-vocabulary detector,
 * one text prompt per part) and traced masks (a segmentation model) into proposed areas — which
 * detections to trust, which overlap, which are uncertain, and the outlines to propose. The models
 * run elsewhere (a background process); everything here is plain geometry so it can be tested.
 */
import type { RegionKind, Vec2 } from "./model.ts";

export interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export type DetectLabel = "house" | "garage door" | "door" | "window" | "roof" | "column" | "brick pillar" | "vent" | "lamp" | "steps";

export interface RawDetection {
  readonly label: DetectLabel;
  readonly score: number;
  readonly box: Box;
}

interface LabelRule {
  readonly label: DetectLabel;
  readonly kind: RegionKind | null;
  /** Below this the detection is ignored. */
  readonly min: number;
  /** Below this (but above min) it's proposed and flagged as uncertain. */
  readonly sure: number;
}

/** What the detector is asked to find, and how far to trust it (tuned on house photos). */
export const DETECT_LABELS: readonly LabelRule[] = [
  { label: "house", kind: null, min: 0.25, sure: 0.5 },
  { label: "garage door", kind: "garage", min: 0.3, sure: 0.5 },
  { label: "door", kind: "door", min: 0.3, sure: 0.5 },
  { label: "window", kind: "window", min: 0.3, sure: 0.5 },
  { label: "roof", kind: "roof", min: 0.3, sure: 0.5 },
  { label: "column", kind: "column", min: 0.3, sure: 0.45 },
  // Brick and stone pillars are often missed as "columns".
  { label: "brick pillar", kind: "column", min: 0.3, sure: 0.45 },
  { label: "vent", kind: "vent", min: 0.25, sure: 0.4 },
  { label: "lamp", kind: "light", min: 0.3, sure: 0.58 },
  // Not an area of its own: porches and steps become part of the facade.
  { label: "steps", kind: null, min: 0.3, sure: 0.5 },
];

const RULE = Object.fromEntries(DETECT_LABELS.map((r) => [r.label, r])) as Record<DetectLabel, LabelRule>;

export const boxArea = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const interArea = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
export const boxIou = (a: Box, b: Box) => {
  const i = interArea(a, b);
  return i / Math.max(1e-9, boxArea(a) + boxArea(b) - i);
};
/** How much of `a` lies inside `b` (0..1). */
export const containedIn = (a: Box, b: Box) => interArea(a, b) / Math.max(1e-9, boxArea(a));
const aspect = (b: Box) => (b.x1 - b.x0) / Math.max(1e-9, b.y1 - b.y0);
const centre = (b: Box): Vec2 => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
const expand = (b: Box, f: number): Box => {
  const dx = (b.x1 - b.x0) * f, dy = (b.y1 - b.y0) * f;
  return { x0: b.x0 - dx, y0: b.y0 - dy, x1: b.x1 + dx, y1: b.y1 + dy };
};
export const boxCorners = (b: Box): Vec2[] => [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
export const pointsBox = (pts: readonly Vec2[]): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
};

export interface Candidate {
  readonly key: string;
  readonly kind: RegionKind;
  readonly label: DetectLabel;
  readonly score: number;
  readonly box: Box;
  readonly uncertain?: string;
}

const pct = (s: number) => `${Math.round(s * 100)}%`;

/**
 * Pick the detections to propose: the main house (largest confident "house"), parts on it, one
 * box per part (overlaps and duplicates removed), conflicting labels settled by shape, doubtful
 * ones flagged with the reason.
 */
export const selectCandidates = (dets: readonly RawDetection[], image: { width: number; height: number }) => {
  const imageBox: Box = { x0: 0, y0: 0, x1: image.width, y1: image.height };
  const imageArea = image.width * image.height;
  const houses = dets.filter((d) => d.label === "house" && d.score >= RULE.house.min);
  const best = houses.sort((a, b) => b.score * Math.pow(boxArea(b.box) / imageArea, 0.25) - a.score * Math.pow(boxArea(a.box) / imageArea, 0.25))[0];
  const house = best ? { box: best.box, score: best.score } : null;
  const onHouse = house?.box ?? imageBox;
  const houseArea = boxArea(house?.box ?? imageBox);
  const notes: string[] = [];
  if (!house) notes.push("No whole house was recognised, so everything found in the photo is proposed.");

  type Work = { label: DetectLabel; kind: RegionKind; score: number; box: Box; uncertain?: string };
  // Keep parts on the main house that aren't house-sized.
  // Porches and steps on the house (they join the facade rather than being areas of their own).
  const extras = dets
    .filter((d) => d.label === "steps" && d.score >= RULE.steps.min && boxIou(d.box, onHouse) > 0 && containedIn(d.box, expand(onHouse, 0.05)) > 0.6)
    .sort((a, b) => b.score - a.score)
    .filter((d, i, all) => !all.slice(0, i).some((o) => containedIn(d.box, o.box) > 0.6))
    .map((d) => ({ label: d.label, score: d.score, box: d.box }));
  let work: Work[] = dets
    .filter((d) => d.label !== "house" && RULE[d.label].kind !== null && d.score >= RULE[d.label].min)
    .filter((d) => {
      const [cx, cy] = centre(d.box);
      return cx >= onHouse.x0 && cx <= onHouse.x1 && cy >= onHouse.y0 && cy <= onHouse.y1;
    })
    .filter((d) => boxArea(d.box) <= houseArea * (d.label === "roof" ? 0.85 : 0.5))
    .map((d) => ({ label: d.label, kind: RULE[d.label].kind!, score: d.score, box: d.box }));

  // One box per part within each label: overlapping duplicates go, and a box that holds smaller
  // ones of the same label (a window and its panes) is kept as the whole.
  const dedupe = (list: Work[]): Work[] => {
    const kept: Work[] = [];
    for (const d of [...list].sort((a, b) => b.score - a.score)) {
      if (kept.some((k) => boxIou(k.box, d.box) > (d.label === "roof" ? 0.4 : 0.5))) continue;
      kept.push(d);
    }
    return kept.filter((s) => !kept.some((b) => b !== s && boxArea(b.box) > boxArea(s.box) && containedIn(s.box, b.box) > 0.8 && b.score >= 0.6 * s.score && s.label !== "roof"));
  };
  const byKind = new Map<RegionKind, Work[]>();
  for (const d of work) byKind.set(d.kind, [...(byKind.get(d.kind) ?? []), d]);
  work = [...byKind.values()].flatMap(dedupe);
  // Columns are tall and narrow; a wide box found as a "pillar" is a stretch of wall.
  work = work.filter((d) => d.kind !== "column" || (d.box.y1 - d.box.y0) / Math.max(1, d.box.x1 - d.box.x0) >= 2);

  // Doors and garage doors are often found by both prompts: the shape decides.
  const isWide = (b: Box) => aspect(b) >= 1.1;
  const doorish = work.filter((d) => d.kind === "door" || d.kind === "garage");
  const drop = new Set<Work>();
  for (const a of doorish)
    for (const b of doorish) {
      if (a === b || a.kind === b.kind || drop.has(a) || drop.has(b)) continue;
      if (boxIou(a.box, b.box) > 0.4 || containedIn(a.box, b.box) > 0.7 || containedIn(b.box, a.box) > 0.7) {
        const keep = [a, b].find((d) => (d.kind === "garage") === isWide(d.box)) ?? (a.score >= b.score ? a : b);
        drop.add(keep === a ? b : a);
      }
    }
  work = work
    .filter((d) => !drop.has(d))
    .map((d) => {
      if (d.kind === "garage" && aspect(d.box) < 0.9) return { ...d, kind: "door" as const, uncertain: "found as a garage door but shaped like a door" };
      if (d.kind === "door" && aspect(d.box) > 1.4) return { ...d, kind: "garage" as const, uncertain: "found as a door but shaped like a garage door" };
      return d;
    });

  // Windows and doors in the same place: keep the more confident one.
  const winDoor = new Set<Work>();
  for (const w of work.filter((d) => d.kind === "window"))
    for (const o of work.filter((d) => d.kind === "door")) if (boxIou(w.box, o.box) > 0.5) winDoor.add(w.score >= o.score ? o : w);
  work = work.filter((d) => !winDoor.has(d));

  // Small parts inside a door or garage door (glass, panels, handles) aren't separate areas.
  const openings = work.filter((d) => d.kind === "door" || d.kind === "garage");
  work = work.filter((d) => d.kind === "door" || d.kind === "garage" || d.kind === "roof" || !openings.some((o) => containedIn(d.box, o.box) > 0.6));
  // Lights and vents are small and not inside windows.
  work = work.filter((d) => !((d.kind === "light" || d.kind === "vent") && work.some((o) => o.kind === "window" && containedIn(d.box, o.box) > 0.5)));
  work = work.filter((d) => !(d.kind === "light" && boxArea(d.box) > houseArea * 0.03));

  // Wall lights sit beside doors, around their height; something found well above every opening
  // (an ornament, a reflection) is more likely a decoration.
  const doorTops = work.filter((d) => d.kind === "door" || d.kind === "garage").map((d) => d.box.y0 - 0.25 * (d.box.y1 - d.box.y0));
  const lightsFrom = doorTops.length ? Math.min(...doorTops) : -Infinity;
  const candidates: Candidate[] = work.map((d, i) => {
    const reasons: string[] = [];
    if (d.kind === "light" && centre(d.box)[1] < lightsFrom) reasons.push("high on the wall — may be a decoration, not a light");
    if (d.score < RULE[d.label].sure) reasons.push(`low confidence (${pct(d.score)})`);
    if (d.uncertain) reasons.push(d.uncertain);
    if (d.kind === "column" && 1 / aspect(d.box) < 2.5) reasons.push("not shaped like a column");
    return { key: `p${i + 1}`, kind: d.kind, label: d.label, score: d.score, box: d.box, ...(reasons.length ? { uncertain: reasons.join("; ") } : {}) };
  });
  return { house, candidates, extras, notes };
};

// ——— Masks → outlines ———

/** A binary mask (1 = inside) at image resolution. */
export interface BitMask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Keep only the mask inside a box. */
export const clipMask = (m: BitMask, b: Box): BitMask => {
  const out = new Uint8Array(m.width * m.height);
  const x0 = Math.max(0, Math.floor(b.x0)), x1 = Math.min(m.width, Math.ceil(b.x1));
  const y0 = Math.max(0, Math.floor(b.y0)), y1 = Math.min(m.height, Math.ceil(b.y1));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[y * m.width + x] = m.data[y * m.width + x]!;
  return { width: m.width, height: m.height, data: out };
};

/** The largest 4-connected piece of the mask. */
export const largestComponent = (m: BitMask): BitMask => {
  const { width: w, height: h, data } = m;
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = 0, bestSize = 0, next = 0;
  for (let i = 0; i < w * h; i++) {
    if (!data[i] || label[i]) continue;
    next++;
    let size = 0, sp = 0;
    stack[sp++] = i;
    label[i] = next;
    while (sp) {
      const p = stack[--sp]!;
      size++;
      const x = p % w, y = (p - x) / w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && data[q] && !label[q]) {
        label[q] = next;
        stack[sp++] = q;
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  const out = new Uint8Array(w * h);
  if (best) for (let i = 0; i < w * h; i++) out[i] = label[i] === best ? 1 : 0;
  return { width: w, height: h, data: out };
};

/** Grow (r > 0) or shrink (r < 0) the mask by |r| pixels (square neighbourhood). */
export const growMask = (m: BitMask, r: number): BitMask => {
  const n = Math.abs(Math.round(r));
  if (!n) return m;
  const grow = r > 0;
  const { width: w, height: h } = m;
  const pass = (src: Uint8Array, len: number, count: number, idx: (line: number, i: number) => number) => {
    const out = new Uint8Array(w * h);
    const pre = new Int32Array(len + 1);
    for (let line = 0; line < count; line++) {
      for (let i = 0; i < len; i++) pre[i + 1] = pre[i]! + src[idx(line, i)]!;
      for (let i = 0; i < len; i++) {
        const a = Math.max(0, i - n), b = Math.min(len, i + n + 1);
        const sum = pre[b]! - pre[a]!;
        // Outside the image counts as empty when shrinking (so edges shrink too).
        out[idx(line, i)] = grow ? (sum > 0 ? 1 : 0) : sum === 2 * n + 1 ? 1 : 0;
      }
    }
    return out;
  };
  const rows = pass(m.data, w, h, (y, x) => y * w + x);
  return { width: w, height: h, data: pass(rows, h, w, (x, y) => y * w + x) };
};

/** Close small gaps and notches: grow, then shrink back. */
export const closeMask = (m: BitMask, r: number): BitMask => growMask(growMask(m, r), -r);

/** Add a filled box to the mask. */
export const fillBox = (m: BitMask, b: Box): BitMask => {
  const data = new Uint8Array(m.data);
  const x0 = Math.max(0, Math.floor(b.x0)), x1 = Math.min(m.width, Math.ceil(b.x1));
  const y0 = Math.max(0, Math.floor(b.y0)), y1 = Math.min(m.height, Math.ceil(b.y1));
  for (let y = y0; y < y1; y++) data.fill(1, y * m.width + x0, y * m.width + x1);
  return { width: m.width, height: m.height, data };
};

export const maskArea = (m: BitMask) => {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i]!;
  return n;
};

/** The outer boundary of the (single-piece) mask, clockwise in image coordinates, one point per boundary pixel. */
export const traceOutline = (m: BitMask): Vec2[] => {
  const { width: w, height: h, data } = m;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] === 1;
  let start = -1;
  for (let i = 0; i < w * h; i++) if (data[i]) {
    start = i;
    break;
  }
  if (start < 0) return [];
  // Moore-neighbour tracing, clockwise on screen, from the top-left pixel (its west side is outside).
  const dirs: Vec2[] = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const dirIndex = (dx: number, dy: number) => dirs.findIndex((d) => d[0] === dx && d[1] === dy);
  const sx = start % w, sy = (start - sx) / w;
  const out: Vec2[] = [[sx, sy]];
  let x = sx, y = sy, back = 0, first = -1;
  for (let guard = 0; guard < w * h * 2; guard++) {
    let d = -1;
    for (let k = 1; k <= 8; k++) {
      const c = (back + k) % 8;
      if (at(x + dirs[c]![0], y + dirs[c]![1])) {
        d = c;
        break;
      }
    }
    if (d < 0) break; // a single pixel
    // Back at the start, leaving the way we first left: the outline is closed (Jacob's criterion).
    if (x === sx && y === sy) {
      if (first === d) break;
      if (first < 0) first = d;
    }
    // The neighbour checked just before (outside), seen from the new pixel, is where the next search starts.
    const prev = (d + 7) % 8;
    back = dirIndex(dirs[prev]![0] - dirs[d]![0], dirs[prev]![1] - dirs[d]![1]);
    x += dirs[d]![0];
    y += dirs[d]![1];
    if (!(x === sx && y === sy)) out.push([x, y]);
  }
  return out;
};

const perpDist = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
};

const dp = (pts: readonly Vec2[], eps: number): Vec2[] => {
  if (pts.length < 3) return [...pts];
  let idx = 0, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i]!, pts[0]!, pts[pts.length - 1]!);
    if (d > dmax) {
      dmax = d;
      idx = i;
    }
  }
  if (dmax <= eps) return [pts[0]!, pts[pts.length - 1]!];
  return [...dp(pts.slice(0, idx + 1), eps).slice(0, -1), ...dp(pts.slice(idx), eps)];
};

/** Fewer points within `eps` pixels of the original (Douglas–Peucker). */
export const simplify = (pts: readonly Vec2[], eps: number, closed: boolean): Vec2[] => {
  if (!closed) return dp(pts, eps);
  if (pts.length < 4) return [...pts];
  // Split a closed outline at its two farthest-apart points and simplify each half.
  let far = 0, fd = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i]![0] - pts[0]![0], pts[i]![1] - pts[0]![1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const a = dp(pts.slice(0, far + 1), eps);
  const b = dp([...pts.slice(far), pts[0]!], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
};

/** Four corners of a roughly rectangular outline (seen in perspective): the extremes along the diagonals. */
export const fitQuad = (pts: readonly Vec2[]): Vec2[] => {
  const pick = (f: (p: Vec2) => number) => pts.reduce((best, p) => (f(p) > f(best) ? p : best), pts[0]!);
  return [pick((p) => -(p[0] + p[1])), pick((p) => p[0] - p[1]), pick((p) => p[0] + p[1]), pick((p) => p[1] - p[0])];
};

/** The top edge of the mask across a box, left to right (the roofline of a house silhouette). */
export const topContour = (m: BitMask, b: Box, step = 2): Vec2[] => {
  const out: Vec2[] = [];
  const x0 = Math.max(0, Math.floor(b.x0)), x1 = Math.min(m.width - 1, Math.ceil(b.x1));
  const y0 = Math.max(0, Math.floor(b.y0)), y1 = Math.min(m.height - 1, Math.ceil(b.y1));
  for (let x = x0; x <= x1; x += step) {
    for (let y = y0; y <= y1; y++) if (m.data[y * m.width + x]) {
      out.push([x, y]);
      break;
    }
  }
  return out;
};

const insidePolygon = (pts: readonly Vec2[], [x, y]: Vec2) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const distToPolygon = (pts: readonly Vec2[], p: Vec2) => {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
};

export const polygonArea = (pts: readonly Vec2[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

// ——— Proposals ———

export interface HouseProposal {
  readonly key: string;
  readonly kind: RegionKind;
  readonly name: string;
  readonly points: readonly Vec2[];
  readonly closed: boolean;
  readonly score: number;
  /** Why it may be wrong (missing when the detection is confident and the outline agrees). */
  readonly uncertain?: string;
  /** How the outline was made: the detector's box, traced from the photo, or four corners fitted to the traced shape. */
  readonly outline: "box" | "traced" | "corners";
  /** Openings are cut out of the facade (the facade proposal's key). */
  readonly cutFrom?: string;
}

export interface HouseDetection {
  readonly image: { readonly width: number; readonly height: number };
  readonly house: { readonly box: Box; readonly score: number } | null;
  readonly proposals: readonly HouseProposal[];
  readonly notes: readonly string[];
  readonly device: "gpu" | "cpu";
  readonly seconds: number;
  readonly models: readonly string[];
}

/** A traced shape for a candidate (from the segmentation model), in image pixels. */
export interface TracedShape {
  readonly outline: readonly Vec2[];
  /** Four corners already fitted to the photo (doors, garage doors), used as they are. */
  readonly corners?: readonly Vec2[];
  /** The segmentation model's own confidence (0..1). */
  readonly quality: number;
}

const RECT_KINDS: ReadonlySet<RegionKind> = new Set(["window", "door", "garage", "vent", "column"]);
const OPENINGS: ReadonlySet<RegionKind> = new Set(["window", "door", "garage"]);
const NAMES: Partial<Record<RegionKind, [string, string]>> = {
  window: ["Window", "Window"],
  door: ["Front door", "Door"],
  garage: ["Garage door", "Garage door"],
  roof: ["Roof", "Roof"],
  column: ["Column", "Column"],
  vent: ["Vent", "Vent"],
  light: ["Light", "Light"],
};

/**
 * The proposals: each part with the best outline available (traced and squared up when the traced
 * shape agrees with the detector's box, otherwise the box), the facade (the house silhouette, with
 * the openings cut out) and the roofline.
 */
export const buildProposals = (input: {
  readonly house: { readonly box: Box; readonly score: number } | null;
  readonly candidates: readonly Candidate[];
  readonly shapes: Readonly<Record<string, TracedShape | undefined>>;
  readonly silhouette?: TracedShape;
  readonly roofline?: readonly Vec2[];
  /** Simplification tolerance in image pixels. */
  readonly tolerance?: number;
}): HouseProposal[] => {
  const tol = input.tolerance ?? 2.5;
  const out: HouseProposal[] = [];
  const sil = input.silhouette;
  const silOk = !!sil && sil.outline.length >= 3 && !!input.house && boxIou(pointsBox(sil.outline), input.house.box) >= 0.6;
  const facadeKey = "facade";
  const sorted = [...input.candidates].sort((a, b) => a.box.x0 - b.box.x0);
  const count = new Map<RegionKind, number>();
  // A roof is only worth proposing with its own traced shape (its detected box is too rough).
  const usable = sorted.filter((c) => c.kind !== "roof" || (input.shapes[c.key]?.outline.length ?? 0) >= 4);
  for (const c of usable) count.set(c.kind, (count.get(c.kind) ?? 0) + 1);
  const seen = new Map<RegionKind, number>();
  for (const c of usable) {
    const n = (seen.get(c.kind) ?? 0) + 1;
    seen.set(c.kind, n);
    const [one, many] = NAMES[c.kind] ?? ["Part", "Part"];
    const name = (count.get(c.kind) ?? 1) === 1 ? one : `${many} ${n}`;
    const s = input.shapes[c.key];
    // A traced shape is used when it fits the detection: closely for parts that fill their box,
    // loosely for roofs (whose boxes are rough and whose shapes are triangles and slopes).
    const agrees =
      !!s &&
      s.outline.length >= 4 &&
      (c.kind === "roof" ? true : boxIou(pointsBox(s.outline), c.box) >= (c.kind === "light" ? 0.6 : 0.75));
    let points: Vec2[], outline: HouseProposal["outline"];
    const reasons = c.uncertain ? [c.uncertain] : [];
    // The house box can take in a neighbour's house; the traced silhouette can't.
    if (silOk && !insidePolygon(sil!.outline, centre(c.box)) && distToPolygon(sil!.outline, centre(c.box)) > 0.03 * (input.house!.box.x1 - input.house!.box.x0)) reasons.push("may not be part of this house");
    if (s?.corners?.length === 4 && RECT_KINDS.has(c.kind)) {
      // Corners already fitted to the photo's edges.
      points = [...s.corners];
      outline = "corners";
    } else if (agrees && RECT_KINDS.has(c.kind)) {
      points = s.corners?.length === 4 ? [...s.corners] : fitQuadRobust(s.outline);
      outline = "corners";
      // A fitted quad that lost most of the shape's area isn't a good fit.
      if (Math.abs(polygonArea(points)) < 0.75 * Math.abs(polygonArea(s.outline))) {
        points = simplify(s.outline, tol, true);
        outline = "traced";
      }
    } else if (agrees) {
      points = simplify(s.outline, tol, true);
      outline = "traced";
    } else {
      points = boxCorners(c.box);
      outline = "box";
      if (c.kind === "roof" || c.kind === "light") reasons.push("outline is the detector's box — reshape it to fit");
    }
    out.push({ key: c.key, kind: c.kind, name, points, closed: true, score: c.score, outline, ...(reasons.length ? { uncertain: reasons.join("; ") } : {}), ...(OPENINGS.has(c.kind) ? { cutFrom: facadeKey } : {}) });
  }
  if (input.house || silOk) {
    const reasons: string[] = [];
    if (!silOk) reasons.push("outline is the detector's box — reshape it to fit the house");
    if (input.house && input.house.score < RULE.house.sure) reasons.push(`low confidence (${pct(input.house.score)})`);
    out.unshift({
      key: facadeKey,
      kind: "wall",
      name: "Facade",
      points: silOk ? simplify(sil!.outline, tol * 1.5, true) : boxCorners(input.house!.box),
      closed: true,
      score: input.house?.score ?? sil?.quality ?? 0,
      outline: silOk ? "traced" : "box",
      ...(reasons.length ? { uncertain: reasons.join("; ") } : {}),
    });
  } else {
    for (let i = 0; i < out.length; i++) if (out[i]!.cutFrom) {
      const { cutFrom: _, ...rest } = out[i]!;
      out[i] = rest;
    }
  }
  if (input.roofline && input.roofline.length >= 2) {
    out.push({ key: "roofline", kind: "roofline", name: "Roofline", points: simplify(input.roofline, tol * 1.5, false), closed: false, score: input.house?.score ?? 0, outline: "traced", ...(silOk ? {} : { uncertain: "traced from a rough house outline" }) });
  }
  return out;
};

/** A straight line through points (total least squares): a point on it and its direction. */
const fitLine = (pts: readonly Vec2[]): { p: Vec2; d: Vec2 } => {
  const n = pts.length;
  const mx = pts.reduce((a, q) => a + q[0], 0) / n, my = pts.reduce((a, q) => a + q[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(a), Math.sin(a)] };
};
const lineDist = (l: { p: Vec2; d: Vec2 }, q: Vec2) => Math.abs((q[0] - l.p[0]) * l.d[1] - (q[1] - l.p[1]) * l.d[0]);
const meet = (a: { p: Vec2; d: Vec2 }, b: { p: Vec2; d: Vec2 }): Vec2 | null => {
  const den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / den;
  return [a.p[0] + a.d[0] * t, a.p[1] + a.d[1] * t];
};

/**
 * Four corners of a roughly four-sided outline, robust to bumps: each side is a straight line
 * through the middle of that side (its ends and stray points left out), and the corners are where
 * neighbouring sides meet. Falls back to the extreme points when the outline isn't four-sided.
 */
export const fitQuadRobust = (pts: readonly Vec2[]): Vec2[] => {
  const init = fitQuad(pts);
  const n = pts.length;
  const idx = init.map((c) => pts.findIndex((p) => p[0] === c[0] && p[1] === c[1]));
  if (n < 24 || idx.some((i) => i < 0)) return init;
  const lens = idx.map((a, s) => (idx[(s + 1) % 4]! - a + n) % n);
  // The corners must come around the outline in order (top-left, top-right, bottom-right, bottom-left).
  if (lens.some((l) => l < 4) || lens.reduce((a, b) => a + b, 0) !== n) return init;
  const lines = idx.map((a, s) => {
    const side: Vec2[] = [];
    for (let k = Math.floor(lens[s]! * 0.2); k <= Math.ceil(lens[s]! * 0.8); k++) side.push(pts[(a + k) % n]!);
    // Fit, drop the farthest quarter, refit — a few rounds, so a spill can't tilt the side.
    let keep = side;
    let line = fitLine(keep);
    for (let round = 0; round < 3 && keep.length > 8; round++) {
      const res = keep.map((q) => lineDist(line, q));
      const cut = [...res].sort((x, y) => x - y)[Math.floor(res.length * 0.75)]!;
      keep = keep.filter((_, i) => res[i]! <= cut);
      line = fitLine(keep);
    }
    return line;
  });
  const box = pointsBox(pts);
  const tol = 0.2 * Math.hypot(box.x1 - box.x0, box.y1 - box.y0);
  return init.map((c, i) => {
    const m = meet(lines[(i + 3) % 4]!, lines[i]!);
    return m && Math.hypot(m[0] - c[0], m[1] - c[1]) <= tol ? m : c;
  });
};

/** Add a filled polygon to the mask (even-odd, scanline). */
export const fillPolygon = (m: BitMask, pts: readonly Vec2[]): BitMask => {
  const data = new Uint8Array(m.data);
  if (pts.length < 3) return { width: m.width, height: m.height, data };
  const ys = pts.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(m.height - 1, Math.ceil(Math.max(...ys))); y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      if (a[1] > yc !== b[1] > yc) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.round(xs[k]!)), x1 = Math.min(m.width, Math.round(xs[k + 1]!));
      if (x1 > x0) data.fill(1, y * m.width + x0, y * m.width + x1);
    }
  }
  return { width: m.width, height: m.height, data };
};

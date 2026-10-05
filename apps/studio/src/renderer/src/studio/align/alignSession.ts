/**
 * Camera-assisted projector alignment: the workflow (UI and agent API share it).
 *
 *   connect the phone → check the view → project and capture the patterns → mark a few matching
 *   points (photo ↔ camera) → solve → review → apply (undoable) → check / realign.
 *
 * The maths is in core autoAlign.ts. The alignment applies after the show's frames are made (the
 * projector output warps them), so changing it never needs the show prepared again.
 */
import {
  type AlignSolution,
  type AreaReport,
  areaReports,
  type CameraToPhoto,
  type Correspondence,
  decodeStripes,
  estimateLens,
  fitCameraToPhoto,
  flattenPath,
  type Gray8,
  type Lens,
  calibrationMapping,
  mapCameraToPhoto,
  mapPhotoToCamera,
  mat3Invert,
  type PatternPlan,
  planPatterns,
  projectorPxPerPhotoPx,
  type Projector,
  type ReferencePair,
  shiftAreaCalibration,
  referenceProblems,
  solveAlignment,
  solveHomography,
  type Vec2,
  type Venue,
} from "@be/core";
import { create } from "zustand";
import type { PhoneStatus, TestPattern } from "../../../../shared/api.ts";
import { venuePhoto } from "../../space/actions.ts";
import { useStudio } from "../store.ts";
import type { MatchResult } from "./autoMatch.ts";
import type { OutlineCheck } from "./verify.ts";

export type AlignPhase = "setup" | "capturing" | "points" | "review" | "applied";

export interface ViewCheck {
  readonly litShare: number;
  /** Sides of the camera picture the projected light runs off. */
  readonly cutOff: string[];
  readonly ok: boolean;
  readonly message: string;
}

export interface DecodeSummary {
  readonly correspondences: number;
  readonly litShare: number;
  readonly decodedShare: number;
  readonly resolutionPx: number;
  readonly lensCorrected: boolean;
  readonly warnings: string[];
}

export interface AlignEstimate {
  readonly confidence: "high" | "medium" | "low";
  /** Typical error of the reference points (leave-one-out), projector pixels; null with too few points. */
  readonly referenceErrorPx: number | null;
  /** How closely the measured projector blocks fit the final mapping, projector pixels (median, 95%). */
  readonly fitPx: { readonly median: number; readonly p95: number };
  /** Share of the projector's picture measured by the camera. */
  readonly measuredShare: number;
  readonly method: string;
  readonly areas: readonly AreaReport[];
  readonly needsAttention: readonly string[];
  readonly summary: string;
}

/** A reference pair, with where it came from: "feature", an area id, or "hand:<area>". */
export type AutoPair = ReferencePair & { readonly source?: string };

export interface MatchSummary {
  readonly ok: boolean;
  readonly confidence: MatchResult["confidence"];
  readonly reason: string;
  readonly view: string | null;
  readonly stats: MatchResult["stats"];
  readonly areas: ReadonlyArray<{ id: string; name: string; status: string; note: string }>;
  readonly pairs: number;
  readonly ms: number;
}

export interface VerifyArea {
  readonly id: string;
  readonly name: string;
  readonly status: OutlineCheck["status"];
  /** How far the projected outline is from the building's edges, projector pixels (null: unverified). */
  readonly offPx: number | null;
  readonly shiftPx: Vec2 | null;
  readonly note: string;
}

export interface VerifyRound {
  readonly round: number;
  readonly areas: readonly VerifyArea[];
  readonly at: number;
}

export interface CheckResult {
  readonly at: number;
  /** How far the current alignment is from what the camera measures now, projector pixels. */
  readonly medianPx: number;
  readonly p95Px: number;
  readonly areas: ReadonlyArray<{ id: string; name: string; offPx: number | null }>;
  readonly verdict: "aligned" | "moved" | "phone-moved" | "unknown";
  readonly message: string;
}

interface AlignState {
  readonly open: boolean;
  readonly venueId: string | null;
  readonly projectorId: string | null;
  readonly phase: AlignPhase;
  /** What it's doing now (null: idle). */
  readonly busy: string | null;
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly qrSvg: string | null;
  /** QR code for "Trust this computer" (install the local authority on the phone once). */
  readonly trustQrSvg: string | null;
  readonly phone: PhoneStatus | null;
  readonly preview: { readonly url: string; readonly width: number; readonly height: number } | null;
  /** Pattern brightness 0–255 (lower if the house is very close or the camera overexposes). */
  readonly level: number;
  readonly view: ViewCheck | null;
  /** The camera's picture of the house lit white (for marking points and reviewing). */
  readonly cameraImage: { readonly url: string; readonly width: number; readonly height: number; readonly path: string } | null;
  readonly decode: DecodeSummary | null;
  readonly pairs: readonly ReferencePair[];
  readonly estimate: AlignEstimate | null;
  readonly check: CheckResult | null;
  /** The alignment version saved before applying (to restore). */
  readonly previousVersion: number | null;
  readonly error: string | null;
  readonly notes: readonly string[];
  /** auto: points from automatic matching; manual: marked by hand. */
  readonly mode: "auto" | "manual";
  readonly match: MatchSummary | null;
  /** Rounds of checking the projected outlines against the building (latest last). */
  readonly verification: readonly VerifyRound[] | null;
  /** What the automatic run is doing, or why it stopped. */
  readonly autoStep: string | null;
}

const initial: AlignState = {
  open: false,
  venueId: null,
  projectorId: null,
  phase: "setup",
  busy: null,
  progress: null,
  qrSvg: null,
  trustQrSvg: null,
  phone: null,
  preview: null,
  level: 200,
  view: null,
  cameraImage: null,
  decode: null,
  pairs: [],
  estimate: null,
  check: null,
  previousVersion: null,
  error: null,
  notes: [],
  mode: "manual",
  match: null,
  verification: null,
  autoStep: null,
};

export const useAlign = create<AlignState>(() => initial);
const set = (p: Partial<AlignState>) => useAlign.setState(p);

// Heavy data kept outside the store.
let frames: Gray8[] = [];
let plan: PatternPlan | null = null;
let corr: Correspondence[] = [];
let lens: Lens | null = null;
let model: CameraToPhoto | null = null;
let solution: AlignSolution | null = null;
/** Held-out automatic matches: never fitted, used to measure the camera ↔ photo relation. */
let validation: AutoPair[] = [];
let cancelled = false;
let offs: Array<() => void> = [];

const SESSION_KEY = (projectorId: string) => `be.align.${projectorId}`;

// ---------------------------------------------------------------------------------------------
// Where we are

const place = (): { venue: Venue; projector: Projector } => {
  const s = useAlign.getState();
  const project = useStudio.getState().project;
  const venue = project && s.venueId ? project.venues[s.venueId] : undefined;
  const projector = venue && s.projectorId ? venue.projectors[s.projectorId] : undefined;
  if (!venue || !projector) throw new Error("Choose a projector first (Projector view, right panel).");
  return { venue, projector };
};

const areasOf = (venue: Venue) =>
  Object.values(venue.regions)
    .filter((r) => r.path.closed)
    .map((r) => ({ id: r.id, name: r.name, polygon: flattenPath(r.path, 8) }));

const note = (t: string) => set({ notes: [...useAlign.getState().notes.slice(-30), `${new Date().toLocaleTimeString()} ${t}`] });

// ---------------------------------------------------------------------------------------------
// Opening and the phone

/** Open the alignment for a projector (UI: the "Auto-align with phone" button). */
export const openAlign = async (venueId: string, projectorId: string): Promise<void> => {
  const s = useAlign.getState();
  if (s.projectorId !== projectorId) {
    resetSession();
    // Points marked last time for this projector (valid while the phone hasn't moved).
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY(projectorId)) ?? "null") as { pairs: ReferencePair[]; lens: Lens | null } | null;
      if (saved?.pairs?.length) set({ pairs: saved.pairs });
      if (saved?.lens) lens = saved.lens;
    } catch {
      // nothing saved
    }
  }
  set({ open: true, venueId, projectorId, error: null });
  if (!offs.length) {
    offs.push(window.be.phone.onStatus((phone) => set({ phone })));
    offs.push(
      window.be.phone.onPreview((f) => {
        const old = useAlign.getState().preview?.url;
        const url = URL.createObjectURL(new Blob([f.jpeg as BlobPart], { type: "image/jpeg" }));
        set({ preview: { url, width: f.width, height: f.height } });
        if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
      }),
    );
  }
  await connectPhone();
};

export const closeAlign = (): void => {
  set({ open: false });
};

const resetSession = () => {
  frames = [];
  plan = null;
  corr = [];
  lens = null;
  model = null;
  solution = null;
  validation = [];
  const k = useAlign.getState();
  set({ ...initial, open: k.open, qrSvg: k.qrSvg, trustQrSvg: k.trustQrSvg, phone: k.phone, preview: k.preview });
};

export const connectPhone = async (): Promise<{ url: string | null; qrSvg: string }> => {
  try {
    const r = await window.be.phone.start();
    set({ qrSvg: r.qrSvg, trustQrSvg: r.trustQrSvg, phone: r.status });
    return { url: r.status.url, qrSvg: r.qrSvg };
  } catch (e) {
    set({ error: plain(e) });
    throw e;
  }
};

export const disconnectPhone = async (): Promise<void> => {
  await window.be.phone.stop();
};

const plain = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

// ---------------------------------------------------------------------------------------------
// The projector output

/** Make sure the projector's output window is open on its display (patterns are shown there). */
const ensureOutput = async (venue: Venue, projector: Projector): Promise<void> => {
  const outs = await window.be.windows.outputs();
  if (outs.some((o) => o.projectorId === projector.id && o.open)) return;
  const displays = await window.be.displays.list();
  const saved = displays.find((d) => String(d.id) === projector.output.displayId);
  const target = saved ?? displays.find((d) => !d.primary);
  if (!target) throw new Error("Only this screen is connected. Connect the projector and press Win+P → Extend, then try again.");
  await window.be.windows.openOutput({ venueId: venue.id, projectorId: projector.id, displayId: target.id, pattern: "align:black" });
  // Give the window a moment to start.
  await sleep(800);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Show a pattern and wait until the output reports it's on screen. */
const show = async (projectorId: string, pattern: TestPattern): Promise<void> => {
  const t0 = Date.now();
  await window.be.windows.setOutputPattern(projectorId, pattern);
  for (;;) {
    const o = (await window.be.windows.outputs()).find((x) => x.projectorId === projectorId);
    if (!o?.open) throw new Error("The projector output closed.");
    if (o.patternShown && o.patternShown.pattern === pattern && o.patternShown.at >= t0 - 5) return;
    if (Date.now() - t0 > 4000) throw new Error("The projector output didn't show the pattern (is its window still open?).");
    await sleep(25);
  }
};

const patternName = (p: PatternPlan["patterns"][number], level: number, block: number): TestPattern =>
  p.kind === "black" ? "align:black" : p.kind === "white" ? `align:white:${level}` : `align:${p.axis}:${p.bit}:${p.inverse ? 1 : 0}:${block}:${level}`;

/** JPEG → greyscale pixels. */
const toGray = async (jpeg: Uint8Array): Promise<Gray8> => {
  const bmp = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const out = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (77 * d[i]! + 150 * d[i + 1]! + 29 * d[i + 2]!) >> 8;
  return { width: c.width, height: c.height, data: out };
};

const guard = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  if (useAlign.getState().busy) throw new Error(`Busy: ${useAlign.getState().busy}`);
  cancelled = false;
  set({ busy: label, error: null, progress: null });
  try {
    return await fn();
  } catch (e) {
    set({ error: plain(e) });
    throw e;
  } finally {
    set({ busy: null, progress: null });
  }
};

/** Stop the capture in progress (the projector goes back to the show). */
export const cancelAlign = (): void => {
  cancelled = true;
};
const checkCancel = () => {
  if (cancelled) throw new Error("Cancelled.");
};

// ---------------------------------------------------------------------------------------------
// Steps

/** Project white and black and see whether the camera sees the whole lit area. */
export const checkView = (): Promise<ViewCheck> =>
  guard("Checking what the camera sees", async () => {
    const { venue, projector } = place();
    if (!useAlign.getState().phone?.connected) throw new Error("Connect the phone first (scan the QR code with it).");
    await ensureOutput(venue, projector);
    const level = useAlign.getState().level;
    try {
      await show(projector.id, "align:black");
      const k = await toGray((await window.be.phone.capture({ settleMs: 350 })).jpeg);
      checkCancel();
      await show(projector.id, `align:white:${level}`);
      const w = await toGray((await window.be.phone.capture({ settleMs: 500 })).jpeg);
      const view = viewFrom(k, w);
      set({ view });
      note(view.message);
      return view;
    } finally {
      await window.be.windows.setOutputPattern(projector.id, "none").catch(() => {});
    }
  });

const viewFrom = (black: Gray8, white: Gray8): ViewCheck => {
  const n = black.width * black.height;
  let lit = 0;
  const edge = { left: 0, right: 0, top: 0, bottom: 0 };
  const w = black.width, h = black.height;
  for (let i = 0; i < n; i++) {
    if (white.data[i]! - black.data[i]! < 24) continue;
    lit++;
    const x = i % w, y = (i - x) / w;
    if (x < 2) edge.left++;
    if (x >= w - 2) edge.right++;
    if (y < 2) edge.top++;
    if (y >= h - 2) edge.bottom++;
  }
  const litShare = lit / n;
  const cutOff = (Object.entries(edge) as Array<[string, number]>).filter(([k, v]) => v / (k === "left" || k === "right" ? 2 * h : 2 * w) > 0.03).map(([k]) => k);
  // Saturation: most lit pixels at the top of the range means the camera can't tell stripes apart well.
  let sat = 0;
  for (let i = 0; i < n; i++) if (white.data[i]! >= 250) sat++;
  const ok = litShare > 0.03 && cutOff.length === 0;
  const message =
    litShare <= 0.03
      ? "The camera doesn't see the projected light. Is the projector on and showing this output, and the phone facing the house?"
      : cutOff.length
        ? `The projected picture runs out of the camera's view on the ${cutOff.join(" and ")}. Move the phone back or turn it so the whole lit area is in view (areas outside can't be measured).`
        : sat > lit * 0.3
          ? "The whole lit area is in view, but much of it is overexposed — lower the pattern brightness."
          : `The whole lit area is in view (${Math.round(litShare * 100)}% of the camera picture).`;
  return { litShare, cutOff, ok, message };
};

/** Project the patterns and capture each one, then decode where the projector's pixels land. */
export const capturePatterns = (o: { keepPhase?: boolean } = {}): Promise<DecodeSummary> =>
  guard("Capturing the patterns", async () => {
    const { venue, projector } = place();
    if (!useAlign.getState().phone?.connected) throw new Error("Connect the phone first (scan the QR code with it).");
    await ensureOutput(venue, projector);
    const level = useAlign.getState().level;
    const p = planPatterns(projector.output.width, projector.output.height, 4);
    const out: Gray8[] = [];
    const phaseBefore = useAlign.getState().phase;
    set({ ...(o.keepPhase ? {} : { phase: "capturing" as const }), progress: { done: 0, total: p.patterns.length } });
    let white: Uint8Array | null = null;
    let whitePath = "";
    try {
      // Let the camera settle its exposure on the lit house, then hold it for the whole sequence.
      await show(projector.id, `align:white:${level}`);
      await sleep(1500);
      await window.be.phone.lock(true);
      await sleep(400);
      for (let i = 0; i < p.patterns.length; i++) {
        checkCancel();
        const pat = p.patterns[i]!;
        await show(projector.id, patternName(pat, level, p.block));
        const cap = await window.be.phone.capture({ settleMs: 300 });
        const g = await toGray(cap.jpeg);
        if (out.length && (g.width !== out[0]!.width || g.height !== out[0]!.height)) throw new Error("The phone's camera changed size during the capture (did it rotate?). Keep it still and try again.");
        out.push(g);
        if (pat.kind === "white") {
          white = cap.jpeg;
          whitePath = cap.path;
        }
        set({ progress: { done: i + 1, total: p.patterns.length } });
      }
    } finally {
      await window.be.phone.lock(false).catch(() => {});
      await window.be.windows.setOutputPattern(projector.id, "none").catch(() => {});
    }
    set({ busy: "Working out where the projector's pixels land" });
    await sleep(30);
    const d = decodeStripes(p, out);
    frames = out;
    plan = p;
    corr = d.correspondences;
    const le = estimateLens(corr, { width: out[0]!.width, height: out[0]!.height });
    lens = le.lens;
    const warnings: string[] = [];
    const sides = Object.entries(d.litAtEdge).filter(([, v]) => v > 0.03).map(([k]) => k);
    if (sides.length) warnings.push(`The projected picture runs out of the camera's view on the ${sides.join(" and ")}; areas there aren't measured.`);
    if (Math.max(d.resolution.x, d.resolution.y) > 16) warnings.push(`The camera could only tell ${Math.max(d.resolution.x, d.resolution.y)}-pixel stripes apart (far away, out of focus or moving?) — precision is limited.`);
    if (d.decodedShare < 0.3) warnings.push("Much of the lit area couldn't be read (reflections, very dark or very bright surfaces, or movement during the capture).");
    const summary: DecodeSummary = {
      correspondences: corr.length,
      litShare: d.litShare,
      decodedShare: d.decodedShare,
      resolutionPx: Math.max(d.resolution.x, d.resolution.y),
      lensCorrected: lens.lambda !== 0,
      warnings,
    };
    if (corr.length < 200) throw new Error("Too little of the projected patterns could be read to align. Check that the phone sees the lit house, is in focus and doesn't move, then try again.");
    if (white) {
      const old = useAlign.getState().cameraImage?.url;
      if (old) URL.revokeObjectURL(old);
      set({ cameraImage: { url: URL.createObjectURL(new Blob([white as BlobPart], { type: "image/jpeg" })), width: out[0]!.width, height: out[0]!.height, path: whitePath } });
    }
    set({ decode: summary, phase: o.keepPhase ? phaseBefore : "points" });
    note(`Captured ${p.patterns.length} patterns: ${corr.length} measured spots, ${Math.round(d.decodedShare * 100)}% of the lit area read${lens.lambda ? ", lens distortion corrected" : ""}.`);
    return summary;
  });

// ---------------------------------------------------------------------------------------------
// Reference points (camera ↔ house photo)

export const setPairs = (pairs: readonly ReferencePair[]): void => {
  set({ pairs: [...pairs], estimate: null });
  const id = useAlign.getState().projectorId;
  if (id) {
    try {
      localStorage.setItem(SESSION_KEY(id), JSON.stringify({ pairs, lens }));
    } catch {
      // a convenience
    }
  }
};

/** What's missing before solving (empty when it can solve). */
export const pointProblems = (): string[] => {
  const s = useAlign.getState();
  const out: string[] = [];
  if (!corr.length) out.push("Capture the patterns first.");
  try {
    const { venue } = place();
    out.push(...referenceProblems(s.pairs, venue.canvas));
  } catch (e) {
    out.push(plain(e));
  }
  return out;
};

/** Fit everything and estimate how good it is (nothing is applied yet). */
export const solve = (): Promise<AlignEstimate> =>
  guard("Calculating the alignment", async () => {
    const { venue, projector } = place();
    const problems = pointProblems();
    if (problems.length) throw new Error(problems.join(" "));
    const s = useAlign.getState();
    const areas = areasOf(venue);
    const g = fitCameraToPhoto(s.pairs, lens, areas, { photo: venue.canvas, ...(s.pairs.length > 40 ? { smoothing: 1 } : {}) });
    if (!g) throw new Error("The marked points don't fit together (check that each pair marks the same spot in both pictures).");
    const opts = { output: projector.output, canvas: venue.canvas };
    const sol = solveAlignment(corr, g, opts);
    if (!sol) throw new Error("Couldn't fit an alignment from what the camera measured. Recapture with the whole lit house in view.");
    model = g;
    solution = sol;
    const est = estimateOf(sol, g, areasOf(venue), opts);
    set({ estimate: est, phase: "review" });
    note(est.summary);
    return est;
  });

const estimateOf = (sol: AlignSolution, g: CameraToPhoto, areas: ReturnType<typeof areasOf>, opts: { output: { width: number; height: number }; canvas: { width: number; height: number } }): AlignEstimate => {
  const scale = projectorPxPerPhotoPx(sol.H, opts.canvas);
  const loo = g.looError.filter((x): x is number => x != null).map((x) => x * scale);
  // Automatic points: measured on the held-out matches (never fitted); hand-marked: leave-one-out.
  const held = validation.map((v) => {
    const q = mapCameraToPhoto(g, v.camera);
    return Math.hypot(q[0] - v.photo[0], q[1] - v.photo[1]) * scale;
  });
  const errs = held.length >= 8 ? held : loo;
  const sorted = [...errs].sort((a, b) => a - b);
  const referenceErrorPx = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
  const referenceP95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)]! : null;
  // Per area, from held-out matches inside it (else the house-wide figure).
  let measured: Record<string, number | null> | undefined;
  if (held.length >= 8) {
    measured = {};
    for (const a of areas) {
      const mine = validation.flatMap((v, i) => (v.source === a.id || inside(v.photo, a.polygon) ? [held[i]!] : [])).sort((x, y) => x - y);
      measured[a.id] = mine.length ? mine[Math.floor(mine.length / 2)]! : referenceErrorPx;
    }
  }
  const reps0 = areaReports(areas, sol, g, opts, measured);
  // An area automatic matching couldn't place (ambiguous, too weak) and with no evidence of its own is
  // not vouched for by the house-wide figure: it needs a look (and the smallest fix: one point, or a nudge).
  const ms = useAlign.getState().match;
  const reps = reps0.map((r) => {
    const m = ms?.areas.find((a) => a.id === r.id);
    const own = validation.some((v) => v.source === r.id) || g.pairs.some((p) => (p as AutoPair).source === `hand:${r.id}`);
    if (!m || m.status === "matched" || m.status === "outside" || own || r.status === "not-covered") return r;
    return { ...r, status: "check" as const, errorPx: null, note: `${m.note} Mark one point on it, or nudge it.` };
  });
  const needsAttention = reps.filter((r) => r.status === "check").map((r) => `${r.name}: ${r.note}`);
  const worstPoint = g.looError.map((e, i) => ({ e: (e ?? 0) * scale, i })).sort((a, b) => b.e - a.e)[0];
  let confidence: AlignEstimate["confidence"] = "low";
  if (referenceErrorPx !== null && referenceErrorPx <= 3 && (referenceP95 ?? 99) <= 8 && sol.fit.p95 <= 3 && g.pairs.length >= 6) confidence = "high";
  else if (referenceErrorPx !== null && referenceErrorPx <= 8 && g.pairs.length >= 5) confidence = "medium";
  const parts = [
    `${confidence[0]!.toUpperCase()}${confidence.slice(1)} confidence.`,
    referenceErrorPx === null
      ? "With 4 points the error can't be estimated — add 2 or more to check them against each other."
      : held.length >= 8
        ? `Checked on ${held.length} held-out matches (not used for fitting): typically ${referenceErrorPx.toFixed(1)} projector pixels off (95%: ${referenceP95!.toFixed(1)}).`
        : `Reference points agree to about ${referenceErrorPx.toFixed(1)} projector pixels.`,
    !held.length && worstPoint && worstPoint.e > 3 * Math.max(1, referenceErrorPx ?? 1) ? `Point ${worstPoint.i + 1} disagrees most (${worstPoint.e.toFixed(0)} px) — check it's on the same spot in both pictures.` : "",
    `${Math.round(sol.fit.meshCoverage * 100)}% of the projector's picture was measured.`,
    needsAttention.length ? `${needsAttention.length} area${needsAttention.length === 1 ? "" : "s"} to check by eye.` : "",
  ].filter(Boolean);
  return { confidence, referenceErrorPx, fitPx: { median: sol.fit.median, p95: sol.fit.p95 }, measuredShare: sol.fit.meshCoverage, method: g.method, areas: reps, needsAttention, summary: parts.join(" ") };
};

/** The house areas drawn on the camera picture as the solution sees them (for reviewing). */
export const areasOnCamera = (): Array<{ id: string; name: string; points: Vec2[] }> => {
  if (!model) return [];
  const { venue } = place();
  return areasOf(venue).flatMap((a) => {
    const pts = a.polygon.map((q) => mapPhotoToCamera(model!, q)).filter((p): p is Vec2 => !!p);
    return pts.length >= 3 ? [{ id: a.id, name: a.name, points: pts }] : [];
  });
};

// ---------------------------------------------------------------------------------------------
// Apply, undo, verify, check, realign

/** Apply the solved alignment (one undo step; the previous one is saved as a version too). */
export const applyAlignment = (): number | null => {
  const { venue, projector } = place();
  if (!solution) throw new Error("Solve the alignment first.");
  if (projector.calibration.locked) throw new Error("This projector's alignment is locked. Unlock it (Projector view, right panel) to apply.");
  const previous = projector.calibration.version;
  const tx = useStudio.getState().apply(
    [
      { type: "calibration.save", args: { venueId: venue.id, projectorId: projector.id, note: "Before auto-align", savedAt: new Date().toISOString() } },
      { type: "calibration.setPoints", args: { venueId: venue.id, projectorId: projector.id, mode: "mesh", points: solution.calibration.points.map((p) => ({ ...p, content: [p.content[0], p.content[1]], output: [p.output[0], p.output[1]] })), mesh: { cols: solution.calibration.mesh!.cols, rows: solution.calibration.mesh!.rows, offsets: solution.calibration.mesh!.offsets.map((o) => [o[0], o[1]]) } } },
    ],
    { label: `Auto-align ${projector.name}` },
  );
  if (!tx) throw new Error("The alignment couldn't be applied (see the message shown).");
  set({ previousVersion: previous, phase: "applied" });
  note(`Applied to ${projector.name}. The previous alignment is kept (Undo, or Restore previous).`);
  return previous;
};

/** Go back to the alignment from before the last apply. */
export const restorePrevious = (): void => {
  const { venue, projector } = place();
  const v = useAlign.getState().previousVersion;
  const snap = v === null ? projector.calibrationHistory.at(-1) : projector.calibrationHistory.find((c) => c.version === v);
  if (!snap) throw new Error("There's no earlier alignment saved for this projector.");
  useStudio.getState().apply({ type: "calibration.restore", args: { venueId: venue.id, projectorId: projector.id, version: snap.version } }, { label: `Restore ${projector.name}'s previous alignment` });
  note("Restored the previous alignment.");
};

/** Project the house-area outlines through the current alignment (to look at on the building). */
export const projectOutlines = async (on: boolean): Promise<void> => {
  const { venue, projector } = place();
  await ensureOutput(venue, projector);
  await window.be.windows.setOutputPattern(projector.id, on ? "outlines" : "none");
};

/** A camera picture of the outlines on the house, with where they should be (the review overlay). */
export const verify = (): Promise<{ path: string; width: number; height: number; areasOnCamera: ReturnType<typeof areasOnCamera> }> =>
  guard("Photographing the outlines on the house", async () => {
    const { venue, projector } = place();
    await ensureOutput(venue, projector);
    await show(projector.id, "outlines");
    const cap = await window.be.phone.capture({ settleMs: 500 });
    const old = useAlign.getState().cameraImage?.url;
    if (old) URL.revokeObjectURL(old);
    set({ cameraImage: { url: URL.createObjectURL(new Blob([cap.jpeg as BlobPart], { type: "image/jpeg" })), width: cap.width, height: cap.height, path: cap.path } });
    return { path: cap.path, width: cap.width, height: cap.height, areasOnCamera: areasOnCamera() };
  });

/**
 * Measure again and compare with the alignment in use (needs the phone where it was when the points
 * were marked). Reports how far each area has drifted, e.g. after the projector was knocked.
 */
export const checkAlignment = async (): Promise<CheckResult> => {
  if (!model && useAlign.getState().pairs.length < 4) {
    const r: CheckResult = { at: Date.now(), medianPx: Number.NaN, p95Px: Number.NaN, areas: [], verdict: "unknown", message: "Mark the reference points (or realign) first: checking compares against the camera's view of the house." };
    set({ check: r });
    return r;
  }
  // First: is the phone where it was? If not, its relation to the house photo is stale.
  if (frames.length >= 2) {
    const m = await phoneMoved();
    if (m.verdict === "moved") {
      model = null;
      const r: CheckResult = { at: Date.now(), medianPx: Number.NaN, p95Px: Number.NaN, areas: [], verdict: "phone-moved", message: `${m.note} Its earlier matches no longer apply — Realign matches the house again automatically.` };
      set({ check: r });
      note(r.message);
      return r;
    }
  }
  await capturePatterns({ keepPhase: true });
  const { venue, projector } = place();
  // After reopening: the points marked last time (the phone must still be where it was).
  if (!model) model = fitCameraToPhoto(useAlign.getState().pairs, lens, areasOf(venue), { photo: venue.canvas });
  if (!model) throw new Error("The saved reference points don't fit together; mark them again.");
  const cal = projector.calibration;
  const H = solveHomography(
    cal.points.map((p) => p.content),
    cal.points.map((p) => p.output),
  );
  const used = calibrationMapping(projector, venue.regions);
  if (!H || !used) throw new Error("The current alignment is degenerate.");
  const scale = projectorPxPerPhotoPx(H, venue.canvas);
  const errs: number[] = [];
  const byArea = new Map<string, number[]>();
  const areas = areasOf(venue);
  for (const c of corr) {
    // Where the camera sees this projector block land, in the photo — and where the alignment in use puts it.
    const qSeen = mapCameraToPhoto(model, c.camera);
    const qUsed = used.toContent(c.projector);
    const e = Math.hypot(qSeen[0] - qUsed[0], qSeen[1] - qUsed[1]) * scale;
    errs.push(e);
    const a = areas.find((x) => inside(qSeen, x.polygon));
    if (a) (byArea.get(a.id) ?? byArea.set(a.id, []).get(a.id)!).push(e);
  }
  errs.sort((a, b) => a - b);
  const med = errs[Math.floor(errs.length / 2)] ?? Number.NaN;
  const p95 = errs[Math.floor(errs.length * 0.95)] ?? Number.NaN;
  const verdict: CheckResult["verdict"] = !Number.isFinite(med) ? "unknown" : med <= 3 && p95 <= 8 ? "aligned" : "moved";
  const r: CheckResult = {
    at: Date.now(),
    medianPx: med,
    p95Px: p95,
    areas: areas.map((a) => {
      const xs = (byArea.get(a.id) ?? []).sort((x, y) => x - y);
      return { id: a.id, name: a.name, offPx: xs.length ? xs[Math.floor(xs.length / 2)]! : null };
    }),
    verdict,
    message: verdict === "aligned" ? `Still aligned (typically ${med.toFixed(1)} px off).` : verdict === "moved" ? `The picture has moved about ${med.toFixed(0)} projector pixels from the alignment in use — Realign.` : "Couldn't measure.",
  };
  set({ check: r });
  note(r.message);
  return r;
};

/** Capture again and solve with the points already marked (the phone must not have moved). */
export const realign = async (): Promise<AlignEstimate> => {
  // Everything measured again: the house matched afresh (no stale points), solved, applied, verified.
  model = null;
  const r = await autoAlign();
  if (r.stoppedAt) throw new Error(r.stoppedAt);
  return useAlign.getState().estimate!;
};

/** The camera's lens distortion found in the last capture (null before one). */
export const currentLens = (): Lens | null => lens;

const inside = (p: Vec2, poly: readonly Vec2[]) => {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) r = !r;
  }
  return r;
};

/** Camera position of a projector pixel (from the measured spots), for diagnostics. */
export const cameraOfProjector = (p: Vec2): Vec2 | null => {
  let best: Correspondence | null = null;
  let bd = Infinity;
  for (const c of corr) {
    const d = (c.projector[0] - p[0]) ** 2 + (c.projector[1] - p[1]) ** 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best ? best.camera : null;
};

/** For the agent API: the current state without the heavy parts. */
export const alignSnapshot = () => {
  const s = useAlign.getState();
  return {
    projectorId: s.projectorId,
    phase: s.phase,
    busy: s.busy,
    progress: s.progress,
    phone: s.phone,
    view: s.view,
    decode: s.decode,
    referencePoints: s.pairs,
    estimate: s.estimate,
    check: s.check,
    previousVersion: s.previousVersion,
    cameraImage: s.cameraImage ? { path: s.cameraImage.path, width: s.cameraImage.width, height: s.cameraImage.height } : null,
    error: s.error,
    mode: s.mode,
    match: s.match,
    verification: s.verification,
    autoStep: s.autoStep,
    notes: s.notes.slice(-10),
  };
};

// =============================================================================================
// Fully automatic: match, solve, apply, verify and refine (and the per-area fallbacks)

let worker: Worker | null = null;
let nextReq = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** Computer vision in a worker (OpenCV.js is loaded there the first time). */
const vision = <T>(type: "match" | "moved" | "verify" | "verifyPhoto", args: unknown[], transfer: Transferable[] = []): Promise<T> => {
  if (!worker) {
    worker = new Worker(new URL("./alignWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.error) w.reject(new Error(e.data.error));
      else w.resolve(e.data.result);
    };
  }
  const id = nextReq++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, type, args }, transfer);
  });
};

/** The house photo, greyscale, at the venue canvas's size (the coordinates the house areas use). */
const photoGray = async (venue: Venue): Promise<Gray8> => {
  const project = useStudio.getState().project!;
  // The file's bytes (a page may not fetch blob: URLs under its content policy).
  const blob = await venuePhoto(project);
  if (!blob) throw new Error("This show has no house photo to match the camera to.");
  const bmp = await createImageBitmap(blob);
  const w = Math.round(venue.canvas.width), h = Math.round(venue.canvas.height);
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (77 * d[i]! + 150 * d[i + 1]! + 29 * d[i + 2]!) >> 8;
  return { width: w, height: h, data: out };
};

const copyGray = (g: Gray8): Gray8 => ({ width: g.width, height: g.height, data: g.data.slice() });

/** Match the camera's view to the house photo automatically (needs a capture). */
export const autoMatch = (): Promise<MatchSummary> =>
  guard("Matching the camera's view to the house photo", async () => {
    const { venue } = place();
    if (frames.length < 2) throw new Error("Capture the patterns first.");
    const photo = await photoGray(venue);
    const black = frames[0]!, white = frames[1]!;
    // The projector's light alone (the house as the projector lights it, without other light).
    const diff: Gray8 = { width: white.width, height: white.height, data: white.data.map((v, i) => Math.max(0, v - black.data[i]!)) };
    const views = [
      { name: "lit by the projector", image: copyGray(white) },
      { name: "projector off", image: copyGray(black) },
      { name: "projector light only", image: diff },
    ];
    const r = await vision<MatchResult>("match", [photo, views, areasOf(venue)], [photo.data.buffer, ...views.map((v) => v.image.data.buffer)]);
    validation = [...r.validation];
    const summary: MatchSummary = {
      ok: r.ok,
      confidence: r.confidence,
      reason: r.reason,
      view: r.view,
      stats: r.stats,
      areas: r.areas.map((a) => ({ id: a.id, name: a.name, status: a.status, note: a.note })),
      pairs: r.pairs.length,
      ms: r.ms,
    };
    set({ match: summary });
    note(r.ok ? `Matched automatically (${r.confidence}): ${r.reason}` : `Automatic matching failed: ${r.reason}`);
    if (r.ok && r.confidence !== "low") {
      // The automatic pairs replace earlier ones; points marked by hand on single areas are kept.
      const manual = useAlign.getState().pairs.filter((p) => (p as AutoPair).source?.startsWith("hand:"));
      setPairs([...r.pairs.map((p) => ({ camera: p.camera, photo: p.photo, source: p.source })), ...manual]);
      set({ mode: "auto" });
    }
    return summary;
  });

/** Camera → projector, linearised near a camera point (from the measured spots around it). */
const cameraToProjectorJacobian = (c: Vec2): [number, number, number, number] | null => {
  const near = [...corr].sort((a, b) => (a.camera[0] - c[0]) ** 2 + (a.camera[1] - c[1]) ** 2 - ((b.camera[0] - c[0]) ** 2 + (b.camera[1] - c[1]) ** 2)).slice(0, 40);
  if (near.length < 8) return null;
  // Least squares p = A c + t.
  const mx = near.reduce((s, x) => s + x.camera[0], 0) / near.length, my = near.reduce((s, x) => s + x.camera[1], 0) / near.length;
  const px = near.reduce((s, x) => s + x.projector[0], 0) / near.length, py = near.reduce((s, x) => s + x.projector[1], 0) / near.length;
  let sxx = 0, sxy = 0, syy = 0, axx = 0, axy = 0, ayx = 0, ayy = 0;
  for (const n of near) {
    const dx = n.camera[0] - mx, dy = n.camera[1] - my, ex = n.projector[0] - px, ey = n.projector[1] - py;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    axx += ex * dx;
    axy += ex * dy;
    ayx += ey * dx;
    ayy += ey * dy;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-9) return null;
  return [(axx * syy - axy * sxy) / det, (axy * sxx - axx * sxy) / det, (ayx * syy - ayy * sxy) / det, (ayy * sxx - ayx * sxy) / det];
};

/**
 * Project the house-area outlines, photograph them and measure each area against the building's
 * edges; correct areas that are measurably off; repeat (at most `rounds` times) until everything
 * measurable is aligned or a correction stops helping. Points used for fitting play no part.
 */
export const verifyAndRefine = (rounds = 3): Promise<VerifyRound[]> =>
  guard("Checking the alignment on the building", async () => {
    const { venue, projector } = place();
    if (!model) throw new Error("Solve the alignment first.");
    await ensureOutput(venue, projector);
    const level = useAlign.getState().level;
    const history: VerifyRound[] = [];
    let previous: Map<string, number> | null = null;
    for (let round = 1; round <= rounds; round++) {
      checkCancel();
      set({ busy: `Checking the alignment on the building (round ${round})` });
      let lit: Gray8, black: Gray8, lines: Gray8;
      try {
        await show(projector.id, `align:white:${level}`);
        await sleep(900);
        await window.be.phone.lock(true);
        lit = await toGray((await window.be.phone.capture({ settleMs: 350 })).jpeg);
        await show(projector.id, "align:black");
        black = await toGray((await window.be.phone.capture({ settleMs: 350 })).jpeg);
        // The house photo projected through the alignment (its texture vs the building's own).
        await show(projector.id, "photo");
        const cap = await window.be.phone.capture({ settleMs: 450 });
        lines = await toGray(cap.jpeg);
        const old = useAlign.getState().cameraImage?.url;
        if (old) URL.revokeObjectURL(old);
        set({ cameraImage: { url: URL.createObjectURL(new Blob([cap.jpeg as BlobPart], { type: "image/jpeg" })), width: cap.width, height: cap.height, path: cap.path } });
      } finally {
        await window.be.phone.lock(false).catch(() => {});
        await window.be.windows.setOutputPattern(projector.id, "none").catch(() => {});
      }
      const areas = areasOnCamera().map((a) => ({ id: a.id, name: a.name, cameraPolygon: a.points }));
      const v = await vision<{ areas: OutlineCheck[] }>("verifyPhoto", [{ lit, black, projected: lines, areas }], [lit.data.buffer, black.data.buffer, lines.data.buffer]);
      // Camera-pixel shifts → projector pixels (local linearisation of where the projector's pixels land).
      const areaResults: VerifyArea[] = v.areas.map((a) => {
        const cam = areas.find((x) => x.id === a.id)?.cameraPolygon ?? [];
        const c: Vec2 = cam.length ? [cam.reduce((t, p) => t + p[0], 0) / cam.length, cam.reduce((t, p) => t + p[1], 0) / cam.length] : [0, 0];
        const J = a.shift ? cameraToProjectorJacobian(c) : null;
        const shiftPx: Vec2 | null = a.shift && J ? [J[0] * a.shift[0] + J[1] * a.shift[1], J[2] * a.shift[0] + J[3] * a.shift[1]] : null;
        return { id: a.id, name: a.name, status: a.status, offPx: shiftPx ? Math.hypot(shiftPx[0], shiftPx[1]) : null, shiftPx, note: a.note };
      });
      const r: VerifyRound = { round, areas: areaResults, at: Date.now() };
      history.push(r);
      set({ verification: [...history] });
      const fix = areaResults.filter((a) => a.status === "off" && a.shiftPx && a.offPx! >= 1);
      // Stop: everything measurable is aligned; or the last correction didn't help.
      if (!fix.length) break;
      if (previous && fix.every((a) => (previous!.get(a.id) ?? Infinity) <= a.offPx! + 0.2)) {
        note("A correction didn't improve the measured fit; stopping.");
        break;
      }
      if (round === rounds) break;
      previous = new Map(fix.map((a) => [a.id, a.offPx!]));
      // Correct each area by what was measured, one undoable step — on top of the alignment as it is
      // now (earlier rounds' corrections included).
      const now = place().projector;
      let cur: Projector = now;
      for (const a of fix) {
        const next = shiftAreaCalibration(cur, venue.regions, a.id, a.shiftPx!);
        if (next) cur = { ...cur, calibration: { ...cur.calibration, ...next } };
      }
      if (cur !== now) {
        const m = cur.calibration.mesh!;
        const tx = useStudio.getState().apply(
          { type: "calibration.setPoints", args: { venueId: venue.id, projectorId: projector.id, mode: "mesh", points: cur.calibration.points.map((p) => ({ ...p, content: [p.content[0], p.content[1]], output: [p.output[0], p.output[1]] })), mesh: { cols: m.cols, rows: m.rows, offsets: m.offsets.map((o) => [o[0], o[1]]), labels: [...(m.labels ?? [])], surfaces: [...(m.surfaces ?? [])], base: (m.base ?? []).map((o) => [o[0], o[1]]) } } },
          { label: `Refine ${projector.name} (measured on the building)`, coalesceKey: `refine-${projector.id}` },
        );
        if (!tx) break;
        note(`Round ${round}: corrected ${fix.map((a) => `${a.name} ${a.offPx!.toFixed(1)} px`).join(", ")}.`);
      }
    }
    return history;
  });

/**
 * The fully automatic run: capture, match, solve, apply, verify and refine. Stops (and says why) at
 * the first step that needs the person: the phone not connected, matching not confident (mark points),
 * or nothing measurable.
 */
export const autoAlign = async (): Promise<{ stoppedAt: string | null; estimate: AlignEstimate | null; verification: VerifyRound[] }> => {
  set({ autoStep: "capturing" });
  try {
    await capturePatterns({ keepPhase: true });
    set({ autoStep: "matching" });
    const m = await autoMatch();
    if (!m.ok || m.confidence === "low") {
      set({ phase: "points", autoStep: "needs points" });
      return { stoppedAt: `Automatic matching wasn't confident enough (${m.reason}). Mark a few matching points.`, estimate: null, verification: [] };
    }
    set({ autoStep: "solving" });
    const est = await solve();
    set({ autoStep: "applying" });
    applyAlignment();
    set({ autoStep: "verifying" });
    const v = await verifyAndRefine(3);
    set({ autoStep: null, phase: "applied" });
    return { stoppedAt: null, estimate: useAlign.getState().estimate ?? est, verification: v };
  } catch (e) {
    set({ autoStep: `stopped: ${plain(e)}` });
    throw e;
  }
};

/** Nudge one area's projection by (dx, dy) projector pixels — one undoable step per area (repeated nudges merge). */
export const nudgeArea = (areaId: string, dx: number, dy: number): void => {
  const { venue, projector } = place();
  if (projector.calibration.locked) throw new Error("This projector's alignment is locked. Unlock it to touch it up.");
  const next = shiftAreaCalibration(projector, venue.regions, areaId, [dx, dy]);
  if (!next) throw new Error("That area can't be moved on its own (no outline, or outside the projector's picture).");
  const m = next.mesh!;
  const name = venue.regions[areaId]?.name ?? "area";
  useStudio.getState().apply(
    { type: "calibration.setPoints", args: { venueId: venue.id, projectorId: projector.id, mode: "mesh", points: next.points.map((p) => ({ ...p, content: [p.content[0], p.content[1]], output: [p.output[0], p.output[1]] })), mesh: { cols: m.cols, rows: m.rows, offsets: m.offsets.map((o) => [o[0], o[1]]), labels: [...(m.labels ?? [])], surfaces: [...(m.surfaces ?? [])], base: (m.base ?? []).map((o) => [o[0], o[1]]) } } },
    { label: `Touch up ${name}`, coalesceKey: `nudge-${projector.id}-${areaId}` },
  );
};

/**
 * The smallest fix for one area that couldn't be matched: one spot marked on the photo and the camera
 * picture inside it. It joins the automatic points and the alignment is recalculated.
 */
export const addAreaPoint = async (areaId: string, photo: Vec2, camera: Vec2): Promise<AlignEstimate> => {
  const s = useAlign.getState();
  setPairs([...s.pairs, { photo, camera, source: `hand:${areaId}` } as AutoPair]);
  return solve();
};

/** Did the phone move since the house was matched? (Compares a fresh picture with the one matched.) */
export const phoneMoved = async (): Promise<{ verdict: "still" | "moved" | "unknown"; shiftPx: number | null; note: string }> => {
  const { venue, projector } = place();
  if (frames.length < 2) return { verdict: "unknown", shiftPx: null, note: "Nothing captured yet to compare with." };
  await ensureOutput(venue, projector);
  const level = useAlign.getState().level;
  let now: Gray8;
  try {
    await show(projector.id, `align:white:${level}`);
    now = await toGray((await window.be.phone.capture({ settleMs: 600 })).jpeg);
  } finally {
    await window.be.windows.setOutputPattern(projector.id, "none").catch(() => {});
  }
  const before = copyGray(frames[1]!);
  return vision("moved", [before, now], [before.data.buffer, now.data.buffer]);
};

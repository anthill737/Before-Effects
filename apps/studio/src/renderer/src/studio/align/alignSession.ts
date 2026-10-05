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
  mapCameraToPhoto,
  mapOutputToContent,
  mapPhotoToCamera,
  mat3Invert,
  type PatternPlan,
  planPatterns,
  projectorPxPerPhotoPx,
  type Projector,
  type ReferencePair,
  referenceProblems,
  solveAlignment,
  solveHomography,
  type Vec2,
  type Venue,
} from "@be/core";
import { create } from "zustand";
import type { PhoneStatus, TestPattern } from "../../../../shared/api.ts";
import { useStudio } from "../store.ts";

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

export interface CheckResult {
  readonly at: number;
  /** How far the current alignment is from what the camera measures now, projector pixels. */
  readonly medianPx: number;
  readonly p95Px: number;
  readonly areas: ReadonlyArray<{ id: string; name: string; offPx: number | null }>;
  readonly verdict: "aligned" | "moved" | "unknown";
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
}

const initial: AlignState = {
  open: false,
  venueId: null,
  projectorId: null,
  phase: "setup",
  busy: null,
  progress: null,
  qrSvg: null,
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
  set({ ...initial, open: useAlign.getState().open, qrSvg: useAlign.getState().qrSvg, phone: useAlign.getState().phone, preview: useAlign.getState().preview });
};

export const connectPhone = async (): Promise<{ url: string | null; qrSvg: string }> => {
  try {
    const r = await window.be.phone.start();
    set({ qrSvg: r.qrSvg, phone: r.status });
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
    const g = fitCameraToPhoto(s.pairs, lens, areas, { photo: venue.canvas });
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
  const referenceErrorPx = loo.length ? [...loo].sort((a, b) => a - b)[Math.floor(loo.length / 2)]! : null;
  const reps = areaReports(areas, sol, g, opts);
  const needsAttention = reps.filter((r) => r.status === "check").map((r) => `${r.name}: ${r.note}`);
  const worstPoint = g.looError.map((e, i) => ({ e: (e ?? 0) * scale, i })).sort((a, b) => b.e - a.e)[0];
  let confidence: AlignEstimate["confidence"] = "low";
  if (referenceErrorPx !== null && referenceErrorPx <= 3 && sol.fit.p95 <= 3 && g.pairs.length >= 6) confidence = "high";
  else if (referenceErrorPx !== null && referenceErrorPx <= 8 && g.pairs.length >= 5) confidence = "medium";
  const parts = [
    `${confidence[0]!.toUpperCase()}${confidence.slice(1)} confidence.`,
    referenceErrorPx === null ? "With 4 points the error can't be estimated — add 2 or more to check them against each other." : `Reference points agree to about ${referenceErrorPx.toFixed(1)} projector pixels.`,
    worstPoint && worstPoint.e > 3 * Math.max(1, referenceErrorPx ?? 1) ? `Point ${worstPoint.i + 1} disagrees most (${worstPoint.e.toFixed(0)} px) — check it's on the same spot in both pictures.` : "",
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
  const Hinv = H && mat3Invert(H);
  if (!H || !Hinv) throw new Error("The current alignment is degenerate.");
  const mesh = cal.mode === "mesh" ? cal.mesh : undefined;
  const W = projector.output.width, Ht = projector.output.height;
  const scale = projectorPxPerPhotoPx(H, venue.canvas);
  const errs: number[] = [];
  const byArea = new Map<string, number[]>();
  const areas = areasOf(venue);
  for (const c of corr) {
    // Where the camera sees this projector block land, in the photo — and where the alignment in use puts it.
    const qSeen = mapCameraToPhoto(model, c.camera);
    const qUsed = mapOutputToContent(Hinv, mesh, W, Ht, c.projector);
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
  await capturePatterns({ keepPhase: true });
  return solve();
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
    notes: s.notes.slice(-10),
  };
};

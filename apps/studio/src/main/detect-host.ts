/**
 * House detection in its own Node process (the app's executable run as Node), so a crash in a GPU
 * driver or running out of memory can't take the editor down, and cancelling is just ending it.
 *
 * The detector (Grounding DINO) is asked for each kind of part by name; the segmentation model
 * (SlimSAM) traces the outline of each part found and of the whole house. Both run through ONNX
 * Runtime, on the GPU through DirectML when that works, else on the CPU. The photo never leaves
 * the computer; the models are downloaded once, with the person's consent, into the data folder.
 *
 * Messages in:  { type: "run", image, cacheDir, allowDownload, device? }
 * Messages out: { type: "progress", stage, fraction, text } · { type: "result", detection } · { type: "error", message, code? }
 */
import { AutoProcessor, env, pipeline, RawImage, SamModel } from "@huggingface/transformers";
import {
  type BitMask,
  boxArea,
  boxIou,
  buildProposals,
  type Candidate,
  clipMask,
  closeMask,
  DETECT_LABELS,
  fillBox,
  type HouseDetection,
  largestComponent,
  maskArea,
  pointsBox,
  type RawDetection,
  selectCandidates,
  topContour,
  traceOutline,
  type TracedShape,
  type Vec2,
} from "@be/core";
import { DETECT_MODELS, modelsMissing } from "./detect-models.ts";

interface RunMessage {
  type: "run";
  image: string;
  cacheDir: string;
  allowDownload: boolean;
  device?: "gpu" | "cpu";
}

const send = (m: unknown) => process.send?.(m);
const progress = (stage: string, fraction: number, text: string) => send({ type: "progress", stage, fraction, text });

/** Download progress across all files of a model, reported as one fraction. */
const downloadProgress = (label: string, base: number, span: number) => {
  const files = new Map<string, { loaded: number; total: number }>();
  return (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== "progress" || !p.file) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    const all = [...files.values()].reduce((a, f) => ({ loaded: a.loaded + f.loaded, total: a.total + f.total }), { loaded: 0, total: 0 });
    if (all.total > 0) progress("download", base + span * (all.loaded / all.total), `${label}: ${(all.loaded / 1e6).toFixed(0)} of ${(all.total / 1e6).toFixed(0)} MB`);
  };
};

/** The parts of the segmentation model and its processor used here (their published types are generic). */
interface SamLike {
  (inputs: Record<string, unknown>): Promise<{ pred_masks: unknown; iou_scores: { data: Float32Array } }>;
  get_image_embeddings(inputs: unknown): Promise<Record<string, unknown>>;
  dispose(): Promise<unknown>;
}
interface SamProcessorLike {
  (image: unknown, opts?: Record<string, unknown>): Promise<{ input_points: unknown; input_labels: unknown; original_sizes: unknown; reshaped_input_sizes: unknown }>;
  post_process_masks(masks: unknown, original: unknown, reshaped: unknown): Promise<Array<{ dims: number[]; data: ArrayLike<number | boolean> }>>;
}

const toMask = (data: ArrayLike<number | boolean>, offset: number, width: number, height: number): BitMask => {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) out[i] = data[offset + i] ? 1 : 0;
  return { width, height, data: out };
};

const run = async (m: RunMessage) => {
  const t0 = performance.now();
  env.cacheDir = m.cacheDir;
  // Downloads are cached in the same layout local models are read from, so one folder serves both.
  env.localModelPath = m.cacheDir;
  env.allowLocalModels = true;
  const missing = modelsMissing(m.cacheDir);
  env.allowRemoteModels = missing.length > 0 && m.allowDownload;
  if (missing.length && !m.allowDownload) {
    send({ type: "error", code: "needs-download", message: `The detection models aren't on this computer yet (${missing.reduce((a, x) => a + x.sizeMB, 0)} MB to download once).` });
    return;
  }
  const notes: string[] = [];
  const image = await RawImage.read(m.image);
  const [gdino, sam] = DETECT_MODELS as [(typeof DETECT_MODELS)[0], (typeof DETECT_MODELS)[1]];

  // The GPU (DirectML) when it works; the CPU otherwise (several times slower, same results).
  let device: "gpu" | "cpu" = m.device ?? "gpu";
  progress("load", 0.02, missing.length ? "Downloading the detection models" : "Loading the detector");
  const load = async (dev: "gpu" | "cpu") =>
    pipeline("zero-shot-object-detection", gdino.id, { dtype: gdino.dtype, device: dev === "gpu" ? "dml" : "cpu", progress_callback: downloadProgress("Detector", 0.02, 0.3) as never });
  let detector: Awaited<ReturnType<typeof load>>;
  try {
    detector = await load(device);
  } catch (e) {
    if (device === "cpu") throw e;
    notes.push(`The GPU couldn't run the detector (${String((e as Error).message ?? e).slice(0, 160)}), so the CPU was used.`);
    device = "cpu";
    detector = await load(device);
  }

  const raw: RawDetection[] = [];
  for (const [i, rule] of DETECT_LABELS.entries()) {
    progress("detect", 0.35 + (0.3 * i) / DETECT_LABELS.length, `Looking for ${rule.label === "lamp" ? "light fixtures" : `${rule.label}s`}`);
    const found = (await detector(image, [`${rule.label}.`], { threshold: Math.min(rule.min, 0.25), percentage: false })) as Array<{ score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }>;
    for (const d of found) raw.push({ label: rule.label, score: d.score, box: { x0: d.box.xmin, y0: d.box.ymin, x1: d.box.xmax, y1: d.box.ymax } });
  }
  await detector.dispose();
  const sel = selectCandidates(raw, { width: image.width, height: image.height });
  notes.push(...sel.notes);

  progress("load", 0.66, "Loading the outline model");
  const samProgress = downloadProgress("Outline model", 0.66, 0.04) as never;
  const loadSam = async (dev: "gpu" | "cpu") => (await SamModel.from_pretrained(sam.id, { dtype: sam.dtype, device: dev === "gpu" ? "dml" : "cpu", progress_callback: samProgress })) as unknown as SamLike;
  let model: SamLike;
  try {
    model = await loadSam(device);
  } catch {
    model = await loadSam("cpu");
  }
  const processor = (await AutoProcessor.from_pretrained(sam.id, { progress_callback: samProgress })) as unknown as SamProcessorLike;
  progress("trace", 0.7, "Tracing outlines");
  const embeddings = await model.get_image_embeddings(await processor(image));

  /** The segmentation model's best mask for some prompt points, the one that best fits `fit`. */
  const segment = async (points: Array<[number, number, 0 | 1]>, fit: { x0: number; y0: number; x1: number; y1: number }): Promise<{ mask: BitMask; quality: number; spill: number } | null> => {
    const inputs = await processor(image, { input_points: [[points.map((p) => [p[0], p[1]])]], input_labels: [[points.map((p) => p[2])]] });
    const o = await model({ ...embeddings, input_points: inputs.input_points, input_labels: inputs.input_labels });
    const masks = (await processor.post_process_masks(o.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes))[0]!;
    const [, n, H, W] = masks.dims as [number, number, number, number];
    const scores = Array.from(o.iou_scores.data as Float32Array);
    let best: { mask: BitMask; quality: number; rank: number; spill: number } | null = null;
    for (let k = 0; k < n; k++) {
      const whole = toMask(masks.data, k * H * W, W, H);
      const clipped = clipMask(whole, fit);
      const inside = maskArea(clipped);
      const mask = largestComponent(clipped);
      if (maskArea(mask) < 16) continue;
      const outline = traceOutline(mask);
      const rank = scores[k]! * boxIou(pointsBox(outline), fit);
      // How much of the shape spills outside the box (a roof prompt that found the whole house).
      const spill = 1 - inside / Math.max(1, maskArea(whole));
      if (!best || rank > best.rank) best = { mask, quality: scores[k]!, rank, spill };
    }
    return best;
  };
  const grow = (b: Candidate["box"], f: number) => {
    const dx = (b.x1 - b.x0) * f, dy = (b.y1 - b.y0) * f;
    return { x0: b.x0 - dx, y0: b.y0 - dy, x1: b.x1 + dx, y1: b.y1 + dy };
  };

  const shapes: Record<string, TracedShape> = {};
  for (const [i, c] of sel.candidates.entries()) {
    progress("trace", 0.72 + (0.2 * i) / Math.max(1, sel.candidates.length), `Tracing outlines (${i + 1} of ${sel.candidates.length})`);
    const { x0, y0, x1, y1 } = c.box;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = x1 - x0, h = y1 - y0;
    // Several points inside, spread along the longer side (a window's panes, a garage door's width).
    const pts: Array<[number, number, 0 | 1]> = w > h * 1.2 ? [[cx, cy, 1], [x0 + w * 0.25, cy, 1], [x0 + w * 0.75, cy, 1]] : h > w * 1.2 ? [[cx, cy, 1], [cx, y0 + h * 0.25, 1], [cx, y0 + h * 0.75, 1]] : [[cx, cy, 1]];
    const r = await segment(pts, grow(c.box, 0.04));
    if (r && (c.kind !== "roof" || r.spill < 0.25)) shapes[c.key] = { outline: traceOutline(r.mask), quality: r.quality };
  }

  // The whole house: points on the house and its parts, and points on the sky and ground outside it.
  let silhouette: TracedShape | undefined;
  let roofline: Vec2[] | undefined;
  if (sel.house) {
    progress("trace", 0.93, "Tracing the house");
    const hb = sel.house.box;
    const inside: Array<[number, number, 0 | 1]> = [[(hb.x0 + hb.x1) / 2, hb.y0 + (hb.y1 - hb.y0) * 0.6, 1], ...sel.candidates.filter((c) => !c.uncertain && c.kind !== "roof" && c.kind !== "light").slice(0, 6).map((c) => [(c.box.x0 + c.box.x1) / 2, (c.box.y0 + c.box.y1) / 2, 1] as [number, number, 1])];
    const outside: Array<[number, number, 0 | 1]> = [];
    if (hb.y0 > 12) outside.push([hb.x0 + (hb.x1 - hb.x0) * 0.05, hb.y0 * 0.5, 0], [hb.x1 - (hb.x1 - hb.x0) * 0.05, hb.y0 * 0.5, 0]);
    if (hb.y1 < image.height - 12) outside.push([(hb.x0 + hb.x1) / 2, (hb.y1 + image.height) / 2, 0]);
    const r = await segment([...inside, ...outside], grow(hb, 0.02));
    if (r && boxArea(pointsBox(traceOutline(r.mask))) > 0.3 * boxArea(hb)) {
      // The house includes its doors and windows (white doors can fool the tracing); small notches
      // along the edges (stonework, shadows) are closed.
      let m = r.mask;
      for (const c of sel.candidates) if (!c.uncertain && (c.kind === "door" || c.kind === "garage" || c.kind === "window")) m = fillBox(m, c.box);
      m = largestComponent(closeMask(m, Math.max(3, Math.round(image.width / 240))));
      silhouette = { outline: traceOutline(m), quality: r.quality };
      roofline = topContour(m, hb, 2);
    } else notes.push("The outline of the whole house couldn't be traced; the facade is a box to reshape.");
  }
  await model.dispose();

  if (sel.candidates.some((c) => c.kind === "roof" && !shapes[c.key])) notes.push("Some roof surfaces couldn't be outlined reliably and weren't proposed; trace them by hand if you need them.");
  progress("build", 0.98, "Putting the proposals together");
  const proposals = buildProposals({ house: sel.house, candidates: sel.candidates, shapes, ...(silhouette ? { silhouette } : {}), ...(roofline ? { roofline } : {}), tolerance: Math.max(1.5, image.width / 800) });
  const detection: HouseDetection = { image: { width: image.width, height: image.height }, house: sel.house, proposals, notes, device, seconds: (performance.now() - t0) / 1000, models: DETECT_MODELS.map((x) => x.id) };
  send({ type: "result", detection });
};

process.on("message", (m: RunMessage) => {
  if (m?.type !== "run") return;
  run(m)
    .catch((e) => send({ type: "error", message: String((e as Error)?.message ?? e) }))
    .finally(() => setTimeout(() => process.exit(0), 50));
});
send({ type: "ready" });

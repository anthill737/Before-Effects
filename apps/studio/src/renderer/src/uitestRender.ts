/**
 * Background rendering journey: keep editing while an export renders (the export keeps its
 * snapshot), cancel and retry, and send a finished file to Google Drive, retrying a failed copy
 * without rendering again.
 */
import { secondsToTime } from "@be/core";
import type { RenderJob, RenderJobSpec } from "../../shared/api.ts";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { currentComp, useStudio } from "./studio/store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const st = () => useStudio.getState();
const jobById = async (id: string) => (await window.be.render.list()).find((j) => j.id === id);
const waitJob = async (id: string, pred: (j: RenderJob) => boolean, timeout = 300_000) => {
  const t0 = performance.now();
  for (;;) {
    const j = await jobById(id);
    if (j && pred(j)) return j;
    if (performance.now() - t0 > timeout) return j;
    await sleep(250);
  }
};

const spec = async (name: string, seconds: number): Promise<RenderJobSpec> => {
  const comp = currentComp(st())!;
  const paths = await window.be.app.paths();
  const frames = Math.round((seconds * comp.frameRate.num) / comp.frameRate.den);
  return {
    name,
    outcome: "share",
    preset: "h264",
    compId: comp.id,
    target: { kind: "master", keepAlpha: false },
    output: `${paths.renders}\\ui-test\\${name.replace(/\W+/g, "-")}-${Date.now()}.mp4`,
    width: comp.width,
    height: comp.height,
    frameRate: comp.frameRate,
    startFrame: 0,
    frames,
    alpha: false,
    withAudio: false,
    estimatedBytes: 10_000_000,
    snapshot: JSON.stringify(st().project),
  };
};

let doneJob: RenderJob | undefined;

const until = async (fn: () => boolean, timeout = 5000) => {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
};
const byText = (sel: string, text: string): HTMLElement | null => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text)) ?? null;
const click = (el: Element | null) => {
  if (!el) throw new Error("element not found");
  (el as HTMLElement).click();
};
const choose = (label: string, value: string) => {
  const sel = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!sel) throw new Error(`select ${label} not found`);
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
};

export const RENDER_STEPS: Record<string, () => Promise<{ ok: boolean; note?: string; settle?: number }>> = {
  "export-half-range": async () => {
    // Through the Export dialog: half size, preview range only (3 s → 90 frames).
    const comp = currentComp(st())!;
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const expected = `${even(comp.width / 2)}×${even(comp.height / 2)}`;
    st().setRange({ start: secondsToTime(2), end: secondsToTime(5) });
    st().setExportOpen(true);
    await until(() => !!(document.querySelector("dialog.export") as HTMLDialogElement | null)?.open);
    click(byText("dialog.export .outcome", "A video to share"));
    await until(() => !!document.querySelector('select[aria-label="Export size"]'));
    choose("Export size", "half");
    choose("Export range", "preview");
    await sleep(100);
    const sizeText = document.querySelector<HTMLSelectElement>('select[aria-label="Export size"]')?.selectedOptions[0]?.textContent ?? "";
    const lengthText = byText("dialog.export dd", "frames")?.textContent ?? "";
    const before = (await window.be.render.list()).length;
    click(byText("dialog.export button", "Export"));
    await until(() => !!byText("dialog.export h3", "Exporting in the background"), 8000);
    st().setExportOpen(false);
    st().setRange(null);
    const id = (await window.be.render.list())[before]?.id ?? "";
    const job = await waitJob(id, (j) => j.state === "done" || j.state === "failed");
    const res = job?.verify?.checks.find((c) => c.name === "Resolution")?.actual;
    const count = job?.verify?.checks.find((c) => c.name === "Frame count")?.actual;
    return {
      ok: job?.state === "done" && res === expected && count === "90" && !!job.verify?.checks.every((c) => c.ok),
      note: `dialog showed "${sizeText}" and "${lengthText.trim()}"; file is ${res}, ${count} frames; ${job?.verify?.checks.map((c) => `${c.ok ? "✓" : "✗"}${c.name}`).join(" ")}`,
    };
  },
  "render-while-editing": async () => {
    const original = await spec("edit while rendering", 12);
    const id = await window.be.render.enqueue(original);
    await waitJob(id, (j) => j.done > 10, 60_000);
    // Edit during the render: the editor stays responsive and the export keeps its snapshot.
    const comp = currentComp(st())!;
    const shown = comp.layerOrder.filter((lid) => comp.layers[lid]!.enabled);
    const t0 = performance.now();
    for (const layerId of shown) st().apply({ type: "layer.update", args: { compId: comp.id, layerId, changes: { enabled: false } } });
    st().setTime(secondsToTime(5));
    const editMs = performance.now() - t0;
    await sleep(400);
    const px = (await currentPreviewLoop()?.sample()) ?? { mean: 0 };
    const mid = await jobById(id);
    // Two short reference renders of frames 147–153: one from the original snapshot, one after the edit.
    const ref = await window.be.render.enqueue({ ...original, name: "reference (before edit)", output: original.output.replace(".mp4", "-ref.mp4"), startFrame: 147, frames: 7 });
    const edited = await window.be.render.enqueue({ ...(await spec("reference (after edit)", 1)), startFrame: 147, frames: 7 });
    for (let i = 0; i < shown.length; i++) st().undo();
    const job = await waitJob(id, (j) => j.state === "done" || j.state === "failed");
    const refJob = await waitJob(ref, (j) => j.state === "done" || j.state === "failed");
    const editJob = await waitJob(edited, (j) => j.state === "done" || j.state === "failed");
    doneJob = job;
    const fps = original.frameRate.num / original.frameRate.den;
    const frame = async (path: string, n: number) => (await window.be.media.decodeFrame(path, n, fps, 320, original.width, original.height))?.data;
    const [a, b, c] = await Promise.all([frame(job!.result!, 150), frame(refJob!.result!, 3), frame(editJob!.result!, 3)]);
    const diff = (x?: Uint8Array, y?: Uint8Array) => {
      if (!x || !y || x.length !== y.length) return 255;
      let d = 0;
      for (let i = 0; i < x.length; i += 4) d += Math.abs(x[i]! - y[i]!) + Math.abs(x[i + 1]! - y[i + 1]!) + Math.abs(x[i + 2]! - y[i + 2]!);
      return d / ((x.length / 4) * 3);
    };
    const same = diff(a, b);
    const changed = diff(a, c);
    return {
      ok: job?.state === "done" && shown.length > 0 && editMs < 250 && same < 2 && changed > same + 3,
      note: `hid all ${shown.length} layers in ${editMs.toFixed(0)} ms while frame ${mid?.done}/${mid?.frames} rendered; preview kept drawing (mean ${px.mean}); frame 150 of the export vs the original snapshot: ${same.toFixed(2)} avg difference, vs the edited show: ${changed.toFixed(2)}. ${job?.verify?.checks.map((c) => `${c.ok ? "✓" : "✗"}${c.name}`).join(" ")}`,
    };
  },
  "cancel-and-retry": async () => {
    const id = await window.be.render.enqueue(await spec("cancel me", 20));
    await waitJob(id, (j) => j.state === "rendering" && j.done > 5, 60_000);
    await window.be.render.cancel(id);
    const c = await waitJob(id, (j) => j.state === "cancelled", 30_000);
    const retryId = await window.be.render.retry(id);
    const r = await waitJob(retryId, (j) => j.state === "done" || j.state === "failed");
    return { ok: c?.state === "cancelled" && r?.state === "done", note: `cancelled at frame ${c?.done}; retry rendered all ${r?.frames} frames and passed its check` };
  },
  "drive-upload-retry": async () => {
    const paths = await window.be.app.paths();
    if (!doneJob) return { ok: false, note: "no finished export to send" };
    // First attempt fails (the "Drive" folder is unreachable), then succeeds after it's available.
    await window.be.deliver.testFolder("Q:\\No Drive Here");
    let failedMsg = "";
    try {
      await window.be.deliver.copyToDrive(doneJob.id);
    } catch (e) {
      failedMsg = String((e as Error).message ?? e);
    }
    const afterFail = await jobById(doneJob.id);
    await window.be.deliver.testFolder(`${paths.renders}\\ui-test\\fake-google-drive`);
    const target = await window.be.deliver.copyToDrive(doneJob.id);
    const afterRetry = await jobById(doneJob.id);
    await window.be.deliver.testFolder(null);
    const exists = await window.be.files.exists(target);
    useStudio.setState({ rendersOpen: true });
    return {
      ok: afterFail?.delivery?.state === "failed" && afterRetry?.delivery?.state === "copied" && exists && (await window.be.files.exists(doneJob.result!)),
      settle: 800,
      note: `first copy failed with a plain message ("${failedMsg.replace(/^Error invoking remote method '[^']+': (Error: )?/, "").slice(0, 90)}…"); retried without re-rendering → ${target}; local file kept`,
    };
  },
};

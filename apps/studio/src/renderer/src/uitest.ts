/**
 * Scripted journey (pnpm --filter @be/studio uitest, or "Before Effects.exe --ui-test").
 * Each step acts through the real UI (DOM clicks, keys, pointer events) the way a first-time user
 * would, then asserts on project state, preview canvas sizes and stats. The main process captures
 * a screenshot after each step. This checks workflow mechanics; it does not replace testing with
 * real first-time users.
 */
import { frameToTime, secondsToTime, timeToFrame } from "@be/core";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreviewStats } from "./preview/loop.ts";
import { usePreview } from "./preview/settings.ts";
import { getRenderer } from "./studio/engineHost.ts";
import { useStudio } from "./studio/store.ts";
import { MEDIA_STEPS } from "./uitestMedia.ts";
import { RENDER_STEPS } from "./uitestRender.ts";
import { ASSISTANT_STEPS } from "./uitestAssistant.ts";
import { SIM_STEPS } from "./uitestSim.ts";
import { AE_STEPS } from "./uitestAe.ts";
import { WORKFLOW_A_STEPS } from "./uitestWorkflowA.ts";
import { WORKFLOW_B_STEPS } from "./uitestWorkflowB.ts";
import { PERF_STEPS } from "./uitestPerf.ts";
import { PHOTO_STEPS } from "./uitestPhoto.ts";
import { HEIC_STEPS } from "./uitestHeic.ts";
import { HOUSE_STEPS } from "./uitestHouse.ts";
import { KEY_STEPS } from "./uitestKeys.ts";
import { BLENDER_STEPS } from "./uitestBlender.ts";
import { EFFECT_STEPS } from "./uitestEffects.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, timeout = 5000) => {
  const t0 = performance.now();
  while (!fn()) {
    if (performance.now() - t0 > timeout) return false;
    await sleep(50);
  }
  return true;
};
const byText = (sel: string, text: string): HTMLElement | null => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text)) ?? null;
const click = (el: Element | null) => {
  if (!el) throw new Error("element not found");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};
const choose = (label: string, value: string) => {
  const sel = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!sel) throw new Error(`select ${label} not found`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(sel, value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
};
const key = (k: string, opts: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...opts }));
const region = (label: string) => document.querySelector(`.overlay path[aria-label^="${label}"]`);
const canvas = () => document.querySelector<HTMLCanvasElement>(".canvas-stage canvas")!;
const st = () => useStudio.getState();
const comp = () => st().project!.compositions[st().compId!]!;
let actions = 0;

type Result = { ok: boolean; note?: string; settle?: number };

/** Mean brightness and contrast (0–255) of the current preview view, rendered offscreen. */
const canvasPixels = async () => (await currentPreviewLoop()?.sample()) ?? { mean: 0, spread: 0, width: 0, height: 0 };
const looksRendered = (p: { mean: number; spread: number }) => p.mean > 0 && p.spread > 2; // a broken view reads exactly black

const sizeIs = async (w: number, h: number) => until(() => canvas()?.width === w && canvas()?.height === h, 4000);

const STEPS: Record<string, () => Promise<Result>> = {
  welcome: async () => ({ ok: !!byText("h2", "What would you like to make?") }),
  "open-sample": async () => {
    usePreview.getState().reset();
    click(byText("button", "Try the sample"));
    const ok = await until(() => !!canvas() && Object.keys(st().project?.recipes ?? {}).length >= 1);
    await sleep(1200);
    return { ok, note: "sample opens already playing", settle: 900 };
  },
  "find-preview": async () => {
    const panel = document.querySelector(".preview-panel");
    const tabs = [...document.querySelectorAll(".preview-toolbar [role=radio]")].map((b) => b.textContent);
    const area = panel ? panel.getBoundingClientRect().width * panel.getBoundingClientRect().height : 0;
    const share = area / (window.innerWidth * window.innerHeight);
    return { ok: !!panel && tabs.includes("Show preview") && tabs.includes("3D projection") && tabs.includes("Projector output") && share > 0.3, note: `preview occupies ${Math.round(share * 100)}% of the window; tabs: ${tabs.join(", ")}` };
  },
  "resolution-full": async () => {
    st().setPlaying(false);
    choose("Preview size", "full");
    const ok = await sizeIs(1920, 1080);
    await sleep(300);
    const px = await canvasPixels();
    return { ok: ok && looksRendered(px), note: `canvas ${canvas().width}×${canvas().height}; label "${document.querySelector(".preview-toolbar .dims")?.textContent}"; pixels mean ${px.mean}, contrast ${px.spread}` };
  },
  "resolution-half": async () => {
    choose("Preview size", "half");
    return { ok: await sizeIs(960, 540), note: `canvas ${canvas().width}×${canvas().height}` };
  },
  "resolution-quarter": async () => {
    choose("Preview size", "quarter");
    return { ok: await sizeIs(480, 270), note: `canvas ${canvas().width}×${canvas().height}` };
  },
  "resolution-eighth": async () => {
    choose("Preview size", "eighth");
    return { ok: await sizeIs(240, 135), note: `canvas ${canvas().width}×${canvas().height}` };
  },
  "zoom-is-display-only": async () => {
    choose("Zoom", "2");
    await sleep(300);
    const zoomed = { w: canvas().width, h: canvas().height, css: canvas().style.width };
    choose("Zoom", "fit");
    await sleep(300);
    return { ok: zoomed.w === 240 && zoomed.h === 135 && canvas().width === 240, note: `at 200% zoom the canvas still renders ${zoomed.w}×${zoomed.h} (shown at ${zoomed.css})` };
  },
  "resolution-auto": async () => {
    choose("Preview size", "auto");
    const ok = await sizeIs(1920, 1080); // paused: Auto renders full quality
    // …and says so (the label follows the rendered size).
    const labelled = await until(() => /1920×1080 \(Full\)/.test(document.querySelector(".preview-toolbar .dims")?.textContent ?? ""), 3000);
    return { ok: ok && labelled, note: `paused Auto renders ${canvas().width}×${canvas().height}; label "${document.querySelector(".preview-toolbar .dims")?.textContent}"` };
  },
  "scales-consistent": async () => {
    // The same frame rendered at Full and at Half must show the same picture (Full averaged 2×2 vs Half).
    const r = await getRenderer();
    const s = st();
    const t = secondsToTime(2.5);
    const read = async (scale: number) => {
      const tex = r.renderContent(s.project!, s.compId!, t, scale)!;
      const px = await r.readTexture(tex);
      const out = { w: tex.width, h: tex.height, px };
      r.gpu.release(tex);
      return out;
    };
    const full = await read(1);
    const half = await read(0.5);
    // Content textures are rgba16float: read as half floats.
    const f16 = (b: Uint8Array) => new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2);
    const h2f = (h: number) => {
      const e = (h >> 10) & 0x1f;
      const m = h & 0x3ff;
      const v = e === 0 ? m / 1024 / 16384 : e === 31 ? 0 : (1 + m / 1024) * 2 ** (e - 15);
      return h & 0x8000 ? -v : v;
    };
    const F = f16(full.px);
    const H = f16(half.px);
    const fw = full.px.length / 8 / full.h;
    const hw = half.px.length / 8 / half.h;
    let diff = 0;
    let n = 0;
    let lum = 0;
    for (let y = 0; y < half.h - 1; y++)
      for (let x = 0; x < half.w - 1; x++)
        for (let c = 0; c < 3; c++) {
          const avg = (h2f(F[((2 * y) * fw + 2 * x) * 4 + c]!) + h2f(F[((2 * y) * fw + 2 * x + 1) * 4 + c]!) + h2f(F[((2 * y + 1) * fw + 2 * x) * 4 + c]!) + h2f(F[((2 * y + 1) * fw + 2 * x + 1) * 4 + c]!)) / 4;
          const v = h2f(H[(y * hw + x) * 4 + c]!);
          diff += Math.abs(avg - v);
          lum += v;
          n++;
        }
    const meanDiff = (diff / n) * 255;
    return { ok: meanDiff < 3 && lum / n > 0.005, note: `Full ${full.w}×${full.h} averaged down vs Half ${half.w}×${half.h}: mean difference ${meanDiff.toFixed(2)} of 255 (same picture, sharper at Full)` };
  },
  "view-3d": async () => {
    click(byText(".preview-toolbar [role=radio]", "3D projection"));
    await sleep(800);
    const o = usePreview.getState().orbit;
    usePreview.getState().set({ orbit: { ...o, yaw: -32, pitch: 12 } });
    await sleep(600);
    const px = await canvasPixels();
    return { ok: usePreview.getState().view === "3d" && canvas().width > 200 && looksRendered(px), note: `3D viewport renders ${canvas().width}×${canvas().height}; pixels mean ${px.mean}, contrast ${px.spread}`, settle: 1000 };
  },
  "view-projector": async () => {
    click(byText(".preview-toolbar [role=radio]", "Projector output"));
    const ok = await until(() => usePreview.getState().view === "projector" && !!document.querySelector(".calibration"));
    await sleep(400);
    const px = await canvasPixels();
    return { ok: ok && looksRendered(px), note: `projector output preview ${canvas().width}×${canvas().height}; pixels mean ${px.mean}, contrast ${px.spread}`, settle: 900 };
  },
  "view-show": async () => {
    click(byText(".preview-toolbar [role=radio]", "Show preview"));
    return { ok: await until(() => usePreview.getState().view === "show") };
  },
  "frame-step": async () => {
    st().setPlaying(false);
    st().setTime(0);
    (document.activeElement as HTMLElement | null)?.blur();
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowRight");
    const three = timeToFrame(st().time, comp().frameRate);
    key("ArrowLeft");
    const two = timeToFrame(st().time, comp().frameRate);
    return { ok: three === 3 && two === 2 && st().time === frameToTime(2, comp().frameRate), note: `→→→ gave frame ${three}; ← gave frame ${two}` };
  },
  "loop-range": async () => {
    st().setTime(secondsToTime(1));
    click(byText(".transport button", "Range start"));
    st().setTime(secondsToTime(2));
    click(byText(".transport button", "Range end"));
    st().setTime(secondsToTime(1));
    st().setPlaying(true);
    let outside = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const t = st().time;
      if (t < secondsToTime(1) || t >= secondsToTime(2)) outside++;
    }
    st().setPlaying(false);
    const r = st().range;
    return { ok: !!r && outside === 0, note: `range ${r ? `${r.start / 705600000}s–${r.end / 705600000}s` : "none"}; ${outside} samples outside while looping 2 s` };
  },
  "cache-first-playback": async () => {
    choose("Preview size", "half");
    usePreview.getState().set({ playbackMode: "cache" });
    currentPreviewLoop()?.resetDropped();
    st().setPlaying(true);
    const prepared = await until(() => usePreviewStats.getState().mode === "playing", 20000);
    await sleep(1500);
    const s = usePreviewStats.getState();
    st().setPlaying(false);
    return { ok: prepared && s.cacheFrames >= 30, note: `prepared ${s.cacheFrames} frames; then played at ${s.achievedFps}/${s.targetFps} fps, ${s.dropped} skipped` };
  },
  "edit-invalidates-only-affected": async () => {
    const loop = currentPreviewLoop()!;
    const c = comp();
    const fps = c.frameRate.num / c.frameRate.den;
    // Cache frames at 1–2 s (inside the roofline effect, 0–8 s) and 9–11 s (outside it).
    for (const sec of [1, 1.5, 9, 10, 10.5]) {
      st().setTime(secondsToTime(sec));
      await sleep(120);
    }
    const fraction = usePreviewStats.getState().fraction;
    const q = usePreview.getState().effectQuality;
    const inside = () => loop.cache.cachedFrames(c.id, fraction, q, secondsToTime(1), secondsToTime(2), c.frameRate).size;
    const outside = () => loop.cache.cachedFrames(c.id, fraction, q, secondsToTime(9), secondsToTime(11), c.frameRate).size;
    const before = { inside: inside(), outside: outside() };
    const inst = Object.values(st().project!.recipes)[0]!;
    st().apply({ type: "recipe.update", args: { instanceId: inst.id, params: { glow: 90 } } });
    await sleep(100);
    const after = { inside: inside(), outside: outside() };
    return {
      ok: before.inside > 0 && before.outside > 0 && after.inside === 0 && after.outside === before.outside,
      note: `editing the roofline effect (0–8 s): frames at 1–2 s ${before.inside}→${after.inside}, frames at 9–11 s ${before.outside}→${after.outside} (kept) @${fps} fps`,
    };
  },
  "select-window": async () => {
    usePreview.getState().set({ playbackMode: "realtime" });
    st().setTime(secondsToTime(3));
    click(region("Upper window 2"));
    actions++;
    const ok = await until(() => st().selection.regionIds.join() === "win-top-2" && !!document.querySelector(".action-bar"));
    return { ok, note: `action bar: ${document.querySelector(".action-bar")?.textContent?.slice(0, 120)}` };
  },
  "select-all-windows": async () => {
    click(byText(".action-bar button", "Select all"));
    actions++;
    return { ok: await until(() => st().selection.regionIds.length === 9), note: `${st().selection.regionIds.length} windows selected` };
  },
  "hover-preview": async () => {
    const btn = byText(".action-bar button", "Light up one after another");
    btn?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    btn?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
    const ok = await until(() => st().hoverPreview !== null);
    st().setTime(secondsToTime(2.2));
    return { ok, note: "preview shown without changing the project", settle: 900 };
  },
  "apply-light-up": async () => {
    const before = Object.keys(st().project!.recipes).length;
    const undoBefore = st().history!.transactions().length;
    click(byText(".action-bar button", "Light up one after another"));
    actions++;
    const ok = await until(() => Object.keys(st().project!.recipes).length === before + 1 && !!st().selection.recipeId);
    st().setPlaying(false);
    st().setTime(st().project!.recipes[st().selection.recipeId!]!.startTime + secondsToTime(1.6));
    const barGone = !document.querySelector(".action-bar");
    return { ok: ok && barGone && st().history!.transactions().length === undoBefore + 1 && actions <= 3, note: `${actions} deliberate actions; one undo step; action bar closed`, settle: 1000 };
  },
  "change-color": async () => {
    const id = st().selection.recipeId!;
    const before = JSON.stringify(st().project!.recipes[id]!.params.color);
    click(document.querySelectorAll<HTMLElement>(".inspector .swatch")[9] ?? null);
    const ok = await until(() => JSON.stringify(st().project!.recipes[id]!.params.color) !== before);
    return { ok, note: `color ${before} → ${JSON.stringify(st().project!.recipes[id]!.params.color)}`, settle: 900 };
  },
  undo: async () => {
    const id = st().selection.recipeId!;
    const before = JSON.stringify(st().project!.recipes[id]!.params.color);
    (document.activeElement as HTMLElement | null)?.blur();
    key("z", { ctrlKey: true });
    const ok = await until(() => JSON.stringify(st().project!.recipes[id]?.params.color) !== before);
    return { ok, note: "Ctrl+Z restored the previous color" };
  },
  "enlarge-preview": async () => {
    click(byText(".preview-toolbar button", "Enlarge"));
    await sleep(500);
    const ok = !!document.querySelector(".studio.maximized") && !!document.querySelector(".transport") && !!document.querySelector(".timeline");
    return { ok, note: "side panels hidden; transport and timeline still available", settle: 700 };
  },
  "restore-preview": async () => {
    click(byText(".preview-toolbar button", "Restore"));
    return { ok: await until(() => !document.querySelector(".studio.maximized")) };
  },
  "pop-out-preview": async () => {
    let open = false;
    const off = window.be.windows.onWindowsChanged((w) => (open = w.preview));
    click(byText(".preview-toolbar button", "Pop out"));
    const opened = await until(() => open, 8000);
    await sleep(2500);
    const note = !!document.querySelector(".popped-note");
    await window.be.windows.closePreview();
    const closed = await until(() => !open, 5000);
    off();
    return { ok: opened && closed && note, note: "pop-out opened, editor showed 'open in its own window', then brought back" };
  },
  "projector-output-window": async () => {
    click(byText(".preview-toolbar [role=radio]", "Projector output"));
    await until(() => !!byText(".projector-output button", "Open projector output"));
    click(byText(".projector-output button", "Open projector output"));
    const opened = await until(() => !!byText(".projector-output button", "Close projector output"), 8000);
    await sleep(1500);
    click(byText(".projector-output [role=radio]", "Grid"));
    await sleep(800);
    click(byText(".projector-output [role=radio]", "Show"));
    await sleep(1200);
    const outputs = await window.be.windows.outputs();
    click(byText(".projector-output button", "Close projector output"));
    const closed = await until(() => !!byText(".projector-output button", "Open projector output"), 5000);
    click(byText(".preview-toolbar [role=radio]", "Show preview"));
    return { ok: opened && closed && outputs.length === 1, note: `output opened on ${outputs[0]?.displayLabel ?? "?"}, patterns switched, closed` };
  },
  "open-export": async () => {
    choose("Preview size", "quarter");
    await sleep(300);
    click(byText(".route-step", "Export or play"));
    return { ok: await until(() => !!(document.querySelector("dialog.export") as HTMLDialogElement | null)?.open), note: "preview left at Quarter before exporting" };
  },
  "choose-share": async () => {
    click(byText("dialog.export .outcome", "A video to share"));
    return { ok: await until(() => !!byText("dialog.export h3", "A video to share")) };
  },
  "export-run": async () => {
    const before = (await window.be.render.list()).length;
    click(byText("dialog.export button", "Export"));
    await until(() => !!byText("dialog.export h3", "Exporting in the background"), 8000);
    let job: Awaited<ReturnType<typeof window.be.render.list>>[number] | undefined;
    const ok = await until(() => {
      void window.be.render.list().then((l) => (job = l.length > before ? l[l.length - 1] : undefined));
      return job?.state === "done" || job?.state === "failed";
    }, 300_000);
    const checks = job?.verify?.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.actual}`).join(", ") ?? job?.error ?? "";
    return { ok: ok && job?.state === "done" && checks.includes("1920×1080"), note: `full-resolution background export after editing at Quarter: ${checks}` };
  },
  "close-export": async () => {
    click(document.querySelector('dialog.export button[aria-label="Close"]'));
    return { ok: await until(() => !st().exportOpen) };
  },
};

Object.assign(STEPS, PHOTO_STEPS, MEDIA_STEPS, ASSISTANT_STEPS, RENDER_STEPS, SIM_STEPS, AE_STEPS, WORKFLOW_A_STEPS, WORKFLOW_B_STEPS, PERF_STEPS, HEIC_STEPS, HOUSE_STEPS, BLENDER_STEPS, EFFECT_STEPS, KEY_STEPS);

// Last: every preview view draws without a single WebGPU validation error (shader typos, bad pipelines).
STEPS["no-gpu-errors"] = async () => {
  const r = await getRenderer();
  const loop = currentPreviewLoop();
  for (const view of ["show", "venue", "3d", "projector"] as const) {
    usePreview.getState().set({ view });
    await new Promise((res) => setTimeout(res, 400));
    await loop?.sample();
  }
  usePreview.getState().set({ view: "show" });
  return { ok: r.gpu.validationErrors.length === 0, note: r.gpu.validationErrors.length ? `${r.gpu.validationErrors.length} WebGPU errors, first: ${r.gpu.validationErrors[0]}` : "all four preview views drew with no WebGPU validation errors" };
};

(window as unknown as { __beTest: unknown }).__beTest = {
  steps: () => Object.keys(STEPS),
  run: async (name: string): Promise<Result> => {
    try {
      return await STEPS[name]!();
    } catch (e) {
      return { ok: false, note: String((e as Error).message ?? e) };
    }
  },
};

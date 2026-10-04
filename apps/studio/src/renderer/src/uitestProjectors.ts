/**
 * Journey steps for several projectors (after the house steps): add a second projector from the
 * projector panel, rename it, arrange both side by side with an overlap, switch between them, check
 * the edge blend in each output, then export every projector (one file each) and check the files.
 */
import { blendSetup, blendWeight, type Projector, secondsToTime } from "@be/core";
import { PhysicsEngine } from "@be/engine";
import { dispatch } from "./agent/core.ts";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreviewStats } from "./preview/loop.ts";
import { applyPlan, computePlan } from "./preview/recommend.ts";
import { usePreview } from "./preview/settings.ts";
import { applyEffect } from "./studio/actions.ts";
import { encodeWav } from "./studio/audioEngine.ts";
import { getRenderer } from "./studio/engineHost.ts";
import { addAssetLayer, importMediaFiles } from "./studio/media.ts";
import { useProjectorPick } from "./studio/projectors.ts";
import { activeVenue, useStudio } from "./studio/store.ts";

type Step = () => Promise<{ ok: boolean; note?: string; settle?: number }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, timeout = 5000) => {
  const t0 = performance.now();
  while (!fn()) {
    if (performance.now() - t0 > timeout) return false;
    await sleep(80);
  }
  return true;
};
const click = (el: Element | null | undefined) => {
  if (!el) throw new Error("element not found");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};
const byText = (sel: string, text: string): HTMLElement | null => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim().startsWith(text)) ?? null;
const typeInto = (el: HTMLInputElement | null, value: string) => {
  if (!el) throw new Error("input not found");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const st = () => useStudio.getState();
const venue = () => activeVenue({ project: st().project! })!;
const list = () => venue().projectorOrder.map((id) => venue().projectors[id]!);

/** Brightness across the middle row of the projector view (linear light), for the current projector. */
const outputRow = async (): Promise<number[]> => {
  st().setPlaying(false);
  st().setTime(secondsToTime(2));
  const r = await getRenderer();
  await sleep(300);
  let shot = await currentPreviewLoop()!.sample();
  const t0 = performance.now();
  while ((r.lastFrameIncomplete || !shot.pixels) && performance.now() - t0 < 20_000) {
    await sleep(150);
    shot = await currentPreviewLoop()!.sample();
  }
  const px = shot.pixels!;
  const y = Math.round(shot.height * 0.35);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return Array.from({ length: shot.width }, (_, x) => lin(px[(y * shot.width + x) * 4 + 1]!));
};

/** Play [start, end) for `seconds` and report the frames per second actually shown. */
const play = async (start: number, end: number, seconds: number, resolution: "full" | "half", clear: boolean) => {
  usePreview.getState().set({ resolution, playbackMode: "realtime", frameSkipping: true, view: "show" });
  const loop = currentPreviewLoop()!;
  if (clear) loop.cache.clear();
  useStudio.setState({ range: { start, end } });
  st().setTime(start);
  await sleep(300);
  loop.resetDropped();
  st().setPlaying(true);
  const samples: number[] = [];
  const t0 = performance.now();
  await sleep(700);
  while (performance.now() - t0 < seconds * 1000) {
    await sleep(250);
    samples.push(usePreviewStats.getState().achievedFps);
  }
  const dropped = usePreviewStats.getState().dropped;
  st().setPlaying(false);
  await sleep(200);
  const s = usePreviewStats.getState();
  return { meanFps: Math.round((samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)) * 10) / 10, minFps: Math.min(...samples), droppedFrames: dropped, size: s.size ? `${s.size.width}x${s.size.height}` : "?", cacheFrames: s.cacheFrames };
};

let skip = "";
const skipped = () => ({ ok: true, note: `SKIPPED: ${skip}` });
const rows: Record<string, number[]> = {};

/** Preview settings before the output steps changed them (null: not changed). */
let kept: Partial<ReturnType<typeof usePreview.getState>> | null = null;
const restorePreview = () => {
  if (kept) usePreview.getState().set(kept);
  kept = null;
};

/**
 * A show plays by its soundtrack's clock: give the test show a quiet one (a low tone, 10 s) so the
 * editor and the outputs follow the sound card, as they do with a real show.
 */
const ensureSoundtrack = async () => {
  const c = st().project!.compositions[st().compId!]!;
  if (Object.values(c.layers).some((l) => l.source.kind === "audio")) return;
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, rate * 10, rate);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 220;
  gain.gain.value = 0.02;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  const path = `${(await window.be.app.paths()).renders}\\ui-test\\soundtrack.wav`;
  await window.be.files.writeBinary(path, encodeWav(await ctx.startRendering()));
  const [asset] = await importMediaFiles([path], { quiet: true });
  if (asset) addAssetLayer(asset, 0, { select: false });
};

/**
 * The show-night way: memory as recommended for this computer, the opening seconds prepared to disk
 * (in a folder of the test's own), then these projectors' outputs play them read from disk, following
 * the editor's clock, for 3 s from when it plays. Counted from what each put on its screen: different
 * frames a second, frames never shown, going back to an earlier frame, its clock against the editor's.
 */
const playOutputs = async (projectors: Projector[]) => {
  if (!kept) {
    const b = usePreview.getState();
    kept = { cacheBudgetMB: b.cacheBudgetMB, videoCacheMB: b.videoCacheMB, diskCache: b.diskCache, diskCacheFolder: b.diskCacheFolder, diskCacheGB: b.diskCacheGB, playbackMode: b.playbackMode, resolution: b.resolution };
    applyPlan((await computePlan()).plan);
    usePreview.getState().set({ diskCacheFolder: `${(await window.be.app.paths()).renders}\\ui-test\\preview-cache`, diskCacheGB: 2, playbackMode: "cache", resolution: "full" });
  }
  await ensureSoundtrack();
  const c = st().project!.compositions[st().compId!]!;
  const fps = c.frameRate.num / c.frameRate.den;
  const call = async (method: string, params: Record<string, unknown>) => {
    const r = await dispatch({ callId: `proj-${method}`, requestId: `proj-${method}`, method, params });
    if (!r.ok) throw new Error(`${method}: ${r.error?.message}`);
    return r.result as { frames?: { state?: string; done?: number; total?: number; reason?: string } };
  };
  await call("prepare.frames", { target: "scene", scene: st().compId!, resolution: "full", fromSeconds: 0, toSeconds: 8 });
  const prep = await call("prepare.wait", { timeoutMs: 180_000 });
  const displays = await window.be.displays.list();
  const d = displays.find((x) => !x.primary) ?? displays[0]!;
  for (const pr of projectors) await window.be.windows.openOutput({ venueId: venue().id, projectorId: pr.id, displayId: d.id, pattern: "none" });
  const open = async () => (await window.be.windows.outputs()).filter((o) => o.open && o.showing && projectors.some((p) => p.id === o.projectorId));
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = (await open()).filter((o) => (o.showing!.framesOnDisk ?? 0) > 0).length >= projectors.length;
    if (!ready) await sleep(150);
  }
  st().setRange({ start: 0, end: secondsToTime(8) });
  st().setTime(0);
  const playFrom = Math.round(performance.now());
  st().setPlaying(true);
  await until(() => usePreviewStats.getState().mode === "playing", 60_000);
  await sleep(1400);
  const samples: Array<{ frames: number[]; editor: number; unshown: number[] }> = [];
  for (let i = 0; i < 4; i++) {
    const outs = await open();
    if (outs.length >= projectors.length) samples.push({ frames: outs.map((o) => o.showing!.frame), editor: Math.round((st().time / 705_600_000) * fps), unshown: outs.map((o) => o.showing!.skipped ?? 0) });
    await sleep(400);
  }
  const shown = (await open()).map((o) => o.showing!);
  const changes = (currentPreviewLoop()?.changes ?? []).filter((x) => x.at >= playFrom).map((x) => `${((x.at - playFrom) / 1000).toFixed(2)} s ${x.state}${x.followers ? "" : " (outputs not ready)"}`);
  st().setPlaying(false);
  st().setRange(null);
  // Blackout all, then close.
  for (const o of await open()) await window.be.windows.setOutputPattern(o.projectorId, "black");
  await sleep(300);
  for (const pr of projectors) await window.be.windows.closeOutput(pr.id);
  const each = (f: (o: (typeof shown)[number]) => unknown) => shown.map(f).join(" and ");
  const note = `${prep.frames?.done ?? 0}/${prep.frames?.total ?? 0} frames prepared (${prep.frames?.state}${prep.frames?.reason ? `: ${prep.frames.reason}` : ""}); different frames a second ${each((o) => o.unique ?? 0)}, never shown ${each((o) => o.skipped ?? 0)} (so far at 1.4/1.8/2.2/2.6 s of playing: ${samples.map((x) => x.unshown.join("+")).join(", ")}), went back ${each((o) => o.stepsBack ?? 0)} times, clock off the editor's by at most ${each((o) => o.clockErrMaxMs ?? 0)} ms (unshown: ${each((o) => `${o.causes?.lateReads ?? 0} late reads, ${o.causes?.lateTurns ?? 0} late turns`)}); editor reads a frame in ${usePreviewStats.getState().diskReadMs} ms, holds up to ${usePreviewStats.getState().cacheBudgetMB} MB of frames: ${changes.join(", ")}`;
  return { prepared: prep.frames?.state === "done", ready, fps, samples, shown, note };
};

export const PROJECTOR_STEPS: Record<string, Step> = {
  "proj-add": async () => {
    if (!venue()?.regions || !Object.values(venue().regions).some((r) => r.name === "Facade")) {
      skip = "no house";
      return skipped();
    }
    // Even light over the facade, so the blend shows.
    st().selectRegions([Object.values(venue().regions).find((r) => r.name === "Facade")!.id]);
    const fx = await applyEffect("color-wash");
    if (fx) st().apply({ type: "recipe.update", args: { instanceId: fx, params: { color: [1, 1, 1, 1], brightness: 100, fade: 0 } } });
    usePreview.getState().set({ view: "projector" });
    await until(() => !!byText(".projectors button", "+ Add projector"));
    const before = list().length;
    click(byText(".projectors button", "+ Add projector"));
    const added = await until(() => list().length === before + 1);
    const p2 = list().at(-1)!;
    const picked = await until(() => useProjectorPick.getState().id === p2.id);
    typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Projector name"]'), "Right");
    const named = await until(() => venue().projectors[p2.id]?.name === "Right");
    return { ok: added && picked && named, note: `“+ Add projector” added ${p2.name}, now the one being aligned; renamed “Right” — ${list().length} projectors`, settle: 600 };
  },
  "proj-arrange": async () => {
    if (skip) return skipped();
    click(byText(".projectors button", "Side by side"));
    const done = await until(() => {
      const [a, b] = list();
      return !!a && !!b && b.calibration.points[0]!.content[0] > 1 && a.calibration.points[1]!.content[0] < venue().canvas.width - 1;
    });
    const [a, b] = list();
    const overlap = Math.round(a!.calibration.points[1]!.content[0] - b!.calibration.points[0]!.content[0]);
    const setup = blendSetup(venue());
    const mid = (a!.calibration.points[1]!.content[0] + b!.calibration.points[0]!.content[0]) / 2;
    const sum = blendWeight([mid, 300], 0, setup, 2) + blendWeight([mid, 300], 1, setup, 2);
    return { ok: done && overlap > 100 && Math.abs(sum - 1) < 1e-6, note: `“Side by side”: ${a!.name} lights content 0–${Math.round(a!.calibration.points[1]!.content[0])} px, ${b!.name} ${Math.round(b!.calibration.points[0]!.content[0])}–${venue().canvas.width} px (${overlap} px overlap); blend weights in the overlap add up to ${sum.toFixed(3)}`, settle: 600 };
  },
  "proj-blend": async () => {
    if (skip) return skipped();
    const [a, b] = list();
    for (const p of [a!, b!]) {
      click(byText('.projectors [role="radiogroup"] button', p.name));
      await until(() => useProjectorPick.getState().id === p.id);
      rows[p.id] = await outputRow();
    }
    const ra = rows[a!.id]!, rb = rows[b!.id]!;
    const w = ra.length;
    // Left fades out toward its right edge; right fades in from its left edge.
    const fadeA = ra[Math.round(w * 0.98)]! < ra[Math.round(w * 0.5)]! * 0.5;
    const fadeB = rb[Math.round(w * 0.02)]! < rb[Math.round(w * 0.5)]! * 0.5;
    // Turned off, the overlap is as bright as the rest.
    click(document.querySelector('.projectors button[role="switch"][aria-label="Edge blending"]'));
    const off = await until(() => venue().blend?.enabled === false);
    click(byText('.projectors [role="radiogroup"] button', a!.name));
    await until(() => useProjectorPick.getState().id === a!.id);
    const rOff = await outputRow();
    const flat = rOff[Math.round(w * 0.98)]! > rOff[Math.round(w * 0.5)]! * 0.9;
    click(document.querySelector('.projectors button[role="switch"][aria-label="Edge blending"]'));
    await until(() => venue().blend?.enabled === true);
    return { ok: fadeA && fadeB && off && flat, note: `Projector outputs: ${a!.name} fades from ${ra[Math.round(w * 0.5)]!.toFixed(3)} to ${ra[Math.round(w * 0.98)]!.toFixed(3)} at its right edge, ${b!.name} from ${rb[Math.round(w * 0.02)]!.toFixed(3)} at its left edge; with blending off the edge stays at ${rOff[Math.round(w * 0.98)]!.toFixed(3)}`, settle: 600 };
  },
  "proj-output-smooth": async () => {
    if (skip) return skipped();
    // Show night with one projector: its output plays the prepared frames as they are, with the editor.
    const r = await playOutputs(list().slice(0, 1));
    restorePreview();
    const o = r.shown[0];
    const ok = r.prepared && r.ready && !!o && (o.unique ?? 0) >= r.fps * 0.9 && (o.skipped ?? 0) <= 3 && (o.stepsBack ?? 0) === 0 && (o.clockErrMaxMs ?? 0) < 100;
    return { ok, note: `one output reading prepared frames: ${r.note}` };
  },
  "proj-outputs-sync": async () => {
    if (skip) return skipped();
    // Both projectors' outputs (on one display here: both full screen, one over the other, on top of
    // the editor — more than a show asks of the computer, where each has a display of its own) stay
    // in step with each other and the editor; how smoothly each played is in the note.
    const r = await playOutputs(list());
    const apart = r.samples.map((x) => Math.max(...x.frames) - Math.min(...x.frames));
    const behind = r.samples.map((x) => x.editor - Math.min(...x.frames));
    restorePreview();
    // Reports are sampled up to 250 ms apart, so allow that much between them.
    const ok = r.prepared && r.ready && r.shown.length >= 2 && r.shown.every((o) => (o.stepsBack ?? 0) === 0 && (o.clockErrMaxMs ?? 0) < 100) && r.samples.length >= 3 && Math.max(...apart) <= Math.ceil(r.fps * 0.3) && Math.max(...behind) <= Math.ceil(r.fps * 0.6);
    return { ok, note: `two outputs reading prepared frames, in step: frames apart ${apart.join("/")} (reports are up to 250 ms old), behind the editor ${behind.join("/")}; ${r.note}` };
  },
  "proj-export-all": async () => {
    if (skip) return skipped();
    usePreview.getState().set({ view: "show" });
    const p = st().project!;
    const comp = p.compositions[st().compId!]!;
    const fps = comp.frameRate.num / comp.frameRate.den;
    const dir = `${(await window.be.app.paths()).renders}\\ui-test`;
    const results: string[] = [];
    let ok = true;
    for (const pr of list()) {
      const output = `${dir}\\Projector ${pr.name}.mp4`;
      const id = await window.be.render.enqueue({ name: `Projector ${pr.name}`, outcome: "projector", preset: "h264", compId: comp.id, target: { kind: "projector", venueId: venue().id, projectorId: pr.id }, output, width: pr.output.width, height: pr.output.height, frameRate: comp.frameRate, startFrame: 0, frames: Math.round(fps * 3), alpha: false, withAudio: false, estimatedBytes: 5_000_000, snapshot: JSON.stringify(p) });
      let job: Awaited<ReturnType<typeof window.be.render.list>>[number] | undefined;
      const t0 = performance.now();
      while (performance.now() - t0 < 180_000) {
        job = (await window.be.render.list()).find((j) => j.id === id);
        if (job?.state === "done" || job?.state === "failed") break;
        await sleep(300);
      }
      if (job?.state !== "done") {
        ok = false;
        results.push(`${pr.name}: ${job?.state} ${job?.error ?? ""}`);
        continue;
      }
      const f = await window.be.media.decodeFrame(job.result!, Math.round(fps * 2), fps, 480, pr.output.width, pr.output.height);
      const lum = (x: number) => (f ? f.data[(Math.round(f.height * 0.35) * f.width + Math.round(x * (f.width - 1))) * 4 + 1]! : -1);
      results.push(`${pr.name}: ${pr.output.width}×${pr.output.height}, middle ${lum(0.5)}, left edge ${lum(0.02)}, right edge ${lum(0.98)}`);
      ok &&= !!f && lum(0.5) > 60;
    }
    return { ok, note: `one file per projector, each with its own alignment and blend — ${results.join("; ")}` };
  },
  "perf-house": async () => {
    if (skip) return skipped();
    const p = st().project!;
    const comp = p.compositions[st().compId!]!;
    const layers = comp.layerOrder.map((id) => comp.layers[id]!);
    const r = await getRenderer();
    // Physics preparation for every 3D layer with physics, from scratch.
    const { resolveScene3DLayer } = await import("@be/core");
    const prep: string[] = [];
    for (const l of layers) {
      const res = resolveScene3DLayer(p, comp.id, l.id);
      if (!res?.physics) continue;
      // From scratch: a fresh engine with no stored motion (the app's own keeps it after the first time).
      const fresh = new PhysicsEngine(null);
      const t0 = performance.now();
      await fresh.ensure(res.physics);
      prep.push(`${l.name}: ${res.physics.bodies.length} bodies × ${res.physics.frames} frames prepared in ${Math.round(performance.now() - t0)} ms from scratch`);
    }
    const start = 0, end = secondsToTime(6);
    const halfCold = await play(start, end, 4, "half", true);
    const halfWarm = await play(start, end, 4, "half", false);
    const fullCold = await play(start, end, 4, "full", true);
    // An edit reaching the screen: change the top layer's opacity and time one full frame.
    const top = layers[0]!;
    st().apply({ type: "prop.set", args: { compId: comp.id, layerId: top.id, path: "transform.opacity", value: 80 } }, { label: "perf edit" });
    const t0 = performance.now();
    const tex = r.renderContent(st().project!, comp.id, secondsToTime(2), 1, "full");
    await r.gpu.device.queue.onSubmittedWorkDone();
    const editMs = Math.round(performance.now() - t0);
    if (tex) r.gpu.release(tex);
    st().undo();
    const m = await window.be.app.metrics();
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    const memory = { totalMb: m.processes.reduce((a, x) => a + x.mb, 0), editorJsHeapMb: Math.round(heap / 1024 / 1024) };
    const report = { machine: { cpu: m.cpu, threads: m.threads, ramGB: m.ramGB }, scene: { resolution: `${comp.width}x${comp.height}`, layers: layers.map((l) => `${l.name} (${l.source.kind})`), projectors: Object.keys(venue().projectors).length }, physics: prep, playback: { halfUncached: halfCold, halfCached: halfWarm, fullUncached: fullCold }, editToScreenMs: editMs, memory };
    await window.be.files.writeText(`${(await window.be.app.paths()).renders}\\ui-test\\perf-house.json`, JSON.stringify(report, null, 2));
    return { ok: true, note: `${layers.length} layers (${layers.map((l) => l.source.kind).join(", ")}), ${report.scene.projectors} projectors at ${report.scene.resolution}: Half ${halfCold.meanFps} fps uncached / ${halfWarm.meanFps} cached (${halfCold.size}), Full ${fullCold.meanFps} fps uncached (${fullCold.size}); an edit reaches a full frame in ${editMs} ms; physics: ${prep.join("; ") || "none"}; memory ${memory.totalMb} MB in all processes (editor JS heap ${memory.editorJsHeapMb} MB) — on ${m.cpu}` };
  },
  "proj-panel-fits": async () => {
    if (skip) return skipped();
    usePreview.getState().set({ view: "projector" });
    await sleep(400);
    // Nothing in the inspector sticks out sideways (no horizontal scrolling).
    const panel = document.querySelector<HTMLElement>(".inspector")!;
    const pr = panel.getBoundingClientRect();
    const wide = [...panel.querySelectorAll<HTMLElement>("*")].filter((e) => e.getBoundingClientRect().right > pr.right + 1 && e.getBoundingClientRect().width > 0);
    // Back to the show for the steps that follow.
    const fits = panel.scrollWidth <= panel.clientWidth && !wide.length;
    const w = panel.clientWidth, sw = panel.scrollWidth;
    usePreview.getState().set({ view: "show" });
    return { ok: fits, note: `projector panel ${w} px wide, content ${sw} px${wide.length ? ` — too wide: ${wide.slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${e.className}`).join(", ")}` : ""}` };
  },
};

/**
 * Performance measurements on the two acceptance shows (run after workflows A and B saved them):
 * preview playback (frames per second actually shown, uncached and cached, at full and half
 * resolution), how long an edit takes to reach the screen, physics preparation, export time
 * (from the workflow runs) and memory. Results are written to perf-report.json next to the
 * screenshots, with the machine they were measured on.
 */
import { frameToTime, resolveScene3DLayer, secondsToTime } from "@be/core";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreviewStats } from "./preview/loop.ts";
import { usePreview } from "./preview/settings.ts";
import { PhysicsEngine } from "@be/engine";
import { getRenderer } from "./studio/engineHost.ts";
import { simStore } from "./studio/simHost.ts";
import { deserialize } from "./studio/persistence.ts";
import { useStudio } from "./studio/store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const st = () => useStudio.getState();
const results: Record<string, unknown> = {};

const open = async (name: string) => {
  const paths = await window.be.app.paths();
  const path = `${paths.projects}\\${name}.beproj`;
  const opened = await window.be.files.openProject(path);
  if (!opened) throw new Error(`${name} hasn't been saved yet (run the workflow first)`);
  st().openProject(deserialize(opened.json), path);
  await sleep(800);
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
  await sleep(700); // settle
  while (performance.now() - t0 < seconds * 1000) {
    await sleep(250);
    samples.push(usePreviewStats.getState().achievedFps);
  }
  const dropped = usePreviewStats.getState().dropped;
  st().setPlaying(false);
  await sleep(200);
  const sorted = [...samples].sort((a, b) => a - b);
  const s = usePreviewStats.getState();
  return { meanFps: Math.round((samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)) * 10) / 10, minFps: sorted[0] ?? 0, droppedFrames: dropped, target: s.targetFps, size: s.size, cacheFrames: s.cacheFrames };
};

/** Time to render one frame at full size after an edit (CPU evaluate + GPU work). */
const frameMs = async (t: number) => {
  const r = await getRenderer();
  const t0 = performance.now();
  const tex = r.renderContent(st().project!, st().compId!, t, 1, "full");
  await r.gpu.device.queue.onSubmittedWorkDone();
  const ms = performance.now() - t0;
  if (tex) r.gpu.release(tex);
  return Math.round(ms * 10) / 10;
};

const memory = async () => {
  const m = await window.be.app.metrics();
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
  return { totalMb: m.processes.reduce((a, p) => a + p.mb, 0), byProcess: m.processes.map((p) => `${p.type}${p.name ? ` (${p.name})` : ""}: ${p.mb} MB`), editorJsHeapMb: Math.round(heap / 1024 / 1024) };
};

export const PERF_STEPS: Record<string, () => Promise<{ ok: boolean; note?: string; settle?: number }>> = {
  "perf-3d-collapse": async () => {
    await open("Workflow B");
    const c = st().project!.compositions[st().compId!]!;
    const l = Object.values(c.layers).find((x) => x.source.kind === "scene3d")!;
    const sceneId = l.source.kind === "scene3d" ? l.source.sceneId : "";
    const r = await getRenderer();
    const wall = Object.values(st().project!.scenes3d![sceneId]!.objects).find((o) => o.fracture)!;
    // Physics: prepare from scratch (a shuffle of the pieces never prepared before), then load it
    // back from the store as a reopened show (or the export window) would.
    st().apply({ type: "object3d.update", args: { sceneId, objectId: wall.id, changes: { fracture: { ...wall.fracture!, seed: 1000 + Math.floor(Math.random() * 1e9) } } } }, { label: "perf" });
    const p = resolveScene3DLayer(st().project!, c.id, l.id)!.physics!;
    const tp = performance.now();
    await r.physics!.ensure(p);
    const physicsMs = Math.round(performance.now() - tp);
    await sleep(300);
    const tl = performance.now();
    await new PhysicsEngine(simStore()).ensure(p);
    const loadMs = Math.round(performance.now() - tl);
    const pieces = p.bodies.filter((b) => b.kind === "fragment").length;
    const start = l.startTime;
    const end = l.outPoint;
    const fullCold = await play(start, end, 4, "full", true);
    const fullWarm = await play(start, end, 4, "full", false);
    const halfCold = await play(start, end, 4, "half", true);
    // Edit → frame on screen: move the light, then render the frame at full size.
    const key = Object.values(st().project!.scenes3d![sceneId]!.objects).find((o) => o.light?.type === "directional")!;
    const t = start + secondsToTime(3);
    st().setTime(t);
    const te = performance.now();
    st().apply({ type: "object3d.update", args: { sceneId, objectId: key.id, changes: { position: { value: [3, 8, 6], spatial: true } } } }, { label: "perf light" });
    const applyMs = Math.round((performance.now() - te) * 10) / 10;
    const renderMs = await frameMs(t);
    const mem = await memory();
    results.collapse3d = { scene: `1600×1000, ${pieces} pieces + ledge, ground, inside, 2 lights with shadows, ${Math.round(((end - start) / 705_600_000) * 10) / 10} s`, physicsPrepareMs: physicsMs, physicsLoadFromDiskMs: loadMs, physicsFrames: p.frames, previewFullUncached: fullCold, previewFullCached: fullWarm, previewHalfUncached: halfCold, editApplyMs: applyMs, frameRenderAfterEditMs: renderMs, memory: mem };
    return {
      ok: true,
      note: `${pieces} pieces: physics prepared from scratch in ${physicsMs} ms (${p.frames} frames), loaded back from disk in ${loadMs} ms; preview full ${fullCold.meanFps} fps uncached (min ${fullCold.minFps}, ${fullCold.droppedFrames} skipped) → ${fullWarm.meanFps} fps cached; half ${halfCold.meanFps} fps uncached; light move: ${applyMs} ms to apply + ${renderMs} ms to render the full-size frame; memory ${mem.totalMb} MB across processes`,
    };
  },
  "perf-video-show": async () => {
    await open("Workflow A");
    const p = st().project!;
    useStudio.setState({ compId: p.mainCompId! });
    const show = p.compositions[p.mainCompId!]!;
    const fullCold = await play(0, show.duration, 5, "full", true);
    const fullWarm = await play(0, show.duration, 5, "full", false);
    const halfCold = await play(0, show.duration, 5, "half", true);
    const renderMs = await frameMs(frameToTime(165, show.frameRate));
    const mem = await memory();
    const m = await window.be.app.metrics();
    const gpu = (await getRenderer()).gpu.info;
    results.videoShow = { scene: `show 1600×1000, 2 scenes crossfading, 4 videos + picture + animation, ${Math.round(show.duration / 705_600_000)} s`, previewFullUncached: fullCold, previewFullCached: fullWarm, previewHalfUncached: halfCold, crossfadeFrameRenderMs: renderMs, memory: mem };
    results.machine = { cpu: m.cpu, threads: m.threads, ramGB: m.ramGB, gpu, build: window.be.app.mode };
    const paths = await window.be.app.paths();
    await window.be.files.writeBinary(`${paths.renders}\\ui-test\\perf-report.json`, new TextEncoder().encode(JSON.stringify({ at: new Date().toISOString(), ...results }, null, 2)));
    return { ok: true, note: `show: preview full ${fullCold.meanFps} fps uncached (min ${fullCold.minFps}) → ${fullWarm.meanFps} fps cached; half ${halfCold.meanFps} fps uncached; crossfade frame renders in ${renderMs} ms at full size; memory ${mem.totalMb} MB; ${m.cpu}, ${m.threads} threads, ${m.ramGB} GB` };
  },
};

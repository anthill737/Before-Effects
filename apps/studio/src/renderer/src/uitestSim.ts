/**
 * Simulation journey: smoke rising out of windows and water filling them — prepared in the
 * background, shown in the preview, reproducible byte for byte, re-prepared after an edit, and
 * exported in the background with the same frames.
 */
import { evalProp, resolveSimulationLayer, type ResolvedSim, secondsToTime, simulationLayers } from "@be/core";
import { SimEngine, type SimStore } from "@be/engine";
import type { RenderJob } from "../../shared/api.ts";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreview } from "./preview/settings.ts";
import { applyRecipeToSelection } from "./studio/actions.ts";
import { getRenderer } from "./studio/engineHost.ts";
import { simStore, useSims } from "./studio/simHost.ts";
import { activeVenue, currentComp, useStudio } from "./studio/store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, timeout = 5000) => {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
};
const st = () => useStudio.getState();
const windows = () => {
  const v = activeVenue({ project: st().project! })!;
  return v.regionOrder.filter((id) => v.regions[id]?.kind === "window");
};
const simOf = (instanceId: string): { layerId: string; sim: ResolvedSim } | null => {
  const p = st().project!;
  const l = simulationLayers(p).find((x) => x.layerId.startsWith(`${instanceId}__`));
  const sim = l ? resolveSimulationLayer(p, l.compId, l.layerId) : null;
  return l && sim ? { layerId: l.layerId, sim } : null;
};
const prepared = async (layerId: string, timeout = 120_000) => {
  const t0 = performance.now();
  const ok = await until(() => {
    const s = useSims.getState().status[layerId];
    return !!s && s.total > 0 && s.done >= s.total;
  }, timeout);
  return { ok, seconds: (performance.now() - t0) / 1000, status: useSims.getState().status[layerId] };
};
/** Mean brightness of the preview in a rectangle (fractions of the picture). */
const regionMean = async (x0: number, y0: number, x1: number, y1: number) => {
  await sleep(300);
  const s = await currentPreviewLoop()?.sample?.();
  if (!s?.pixels) return -1;
  const { width: w, height: h, pixels } = s;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++)
    for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) {
      const i = (y * w + x) * 4;
      sum += pixels[i]! + pixels[i + 1]! + pixels[i + 2]!;
      n += 3;
    }
  return n ? sum / n : -1;
};

/** Bounding box of regions as fractions of the composition. */
const boxOf = (ids: readonly string[]) => {
  const v = activeVenue({ project: st().project! })!;
  const comp = currentComp(st())!;
  const pts = ids.flatMap((id) => v.regions[id]!.path.vertices.map((x) => x.p));
  const xs = pts.map((p) => p[0] / comp.width);
  const ys = pts.map((p) => p[1] / comp.height);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

/** How blue the preview is in a rectangle: mean of (blue − red), 0–255 (pixels are BGRA). */
const regionBlue = async (x0: number, y0: number, x1: number, y1: number) => {
  await sleep(300);
  const s = await currentPreviewLoop()?.sample?.();
  if (!s?.pixels) return -999;
  const { width: w, height: h, pixels } = s;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++)
    for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) {
      const i = (y * w + x) * 4;
      sum += pixels[i]! - pixels[i + 2]!;
      n++;
    }
  return n ? sum / n : -999;
};

let smokeId = "";
let waterId = "";

export const SIM_STEPS: Record<string, () => Promise<{ ok: boolean; note?: string; settle?: number }>> = {
  "sim-smoke": async () => {
    usePreview.getState().set({ resolution: "full" });
    st().setPlaying(false);
    const w = windows().slice(-4);
    const box = boxOf(w);
    // Measure above the windows the smoke rises from, 3 seconds after it starts.
    const area = [box.x0, Math.max(0, box.y0 - 0.3), box.x1, box.y1] as const;
    st().setTime(secondsToTime(7));
    const before = await regionMean(...area);
    st().setTime(secondsToTime(4));
    smokeId = applyRecipeToSelection("smoke-rising", w, { seconds: 6 }) ?? "";
    st().setPlaying(false);
    const s = simOf(smokeId);
    if (!s) return { ok: false, note: "no simulation layer was created" };
    const r = await prepared(s.layerId);
    st().setTime(secondsToTime(7));
    const after = await regionMean(...area);
    return {
      ok: r.ok && after > before + 3,
      note: `${s.sim.frames} frames (${s.sim.prerollFrames} preroll) prepared in ${r.seconds.toFixed(1)} s on a ${s.sim.settings.quality} grid; brightness above the windows at 7 s: ${before.toFixed(1)} → ${after.toFixed(1)}`,
      settle: 400,
    };
  },
  "sim-reproducible": async () => {
    const s = simOf(smokeId);
    if (!s) return { ok: false, note: "no smoke simulation" };
    // Simulate the same settings again from scratch in a separate engine and compare frames byte for byte.
    const mem = new Map<string, Uint8Array>();
    const memory: SimStore = { read: async (k, n) => mem.get(`${k}/${n}`) ?? null, write: async (k, n, d) => void mem.set(`${k}/${n}`, d) };
    const r = await getRenderer();
    const fresh = new SimEngine(r.gpu, memory);
    const check = [10, 60, Math.min(s.sim.frames - 1, 150)];
    await fresh.ensure(s.sim, check.at(-1)!);
    const disk = simStore();
    let same = 0;
    for (const f of check) {
      const a = mem.get(`${s.sim.key}/f${f}.bin`);
      const b = await disk.read(s.sim.key, `f${f}.bin`);
      if (a && b && a.length === b.length && a.every((v, i) => v === b[i])) same++;
    }
    fresh.dispose();
    return { ok: same === check.length, note: `frames ${check.join(", ")} identical in a second run: ${same}/${check.length}` };
  },
  "sim-edit-reprepares": async () => {
    const before = simOf(smokeId)!.sim.key;
    // A fresh variation each run, so the stored frames from earlier test runs don't already cover it.
    st().apply({ type: "recipe.update", args: { instanceId: smokeId, params: { amount: 90, color: [1, 0.55, 0.3, 1], seed: 2 + (Date.now() % 100000) } } });
    const s = simOf(smokeId)!;
    const reset = await until(() => (useSims.getState().status[s.layerId]?.done ?? 0) < s.sim.frames, 3000);
    const r = await prepared(s.layerId);
    return { ok: s.sim.key !== before && reset && r.ok, note: `new settings → new cache key; prepared again in ${r.seconds.toFixed(1)} s (old frames kept on disk for undo)` };
  },
  "sim-water": async () => {
    if (smokeId && st().project!.recipes[smokeId]) st().apply({ type: "recipe.remove", args: { instanceId: smokeId } });
    const w = windows();
    st().setTime(0);
    waterId = applyRecipeToSelection("water-fill", w.slice(0, 3), { seconds: 6 }) ?? "";
    st().setPlaying(false);
    const s = simOf(waterId);
    if (!s) return { ok: false, note: "no water simulation" };
    const r = await prepared(s.layerId);
    // Look inside the first window, low down, where water collects: compare the same moment with and without the water.
    const bx = boxOf([w[0]!]);
    const low = [bx.x0 + 0.01, bx.y1 - (bx.y1 - bx.y0) * 0.3, bx.x1 - 0.01, bx.y1 - 0.005] as const;
    st().setTime(secondsToTime(5));
    const late = await regionBlue(...low);
    st().apply({ type: "layer.update", args: { compId: currentComp(st())!.id, layerId: s.layerId, changes: { enabled: false } } }, { label: "test: hide water" });
    const early = await regionBlue(...low);
    st().undo();
    st().setTime(secondsToTime(5));
    return { ok: r.ok && late > early + 15, note: `${s.sim.frames} frames prepared in ${r.seconds.toFixed(1)} s; blueness at the bottom of the first window at 5 s: ${early.toFixed(1)} without the water → ${late.toFixed(1)} with it`, settle: 400 };
  },
  "crack-rebuild": async () => {
    const w = windows();
    st().setPlaying(false);
    st().setTime(secondsToTime(1));
    const id = applyRecipeToSelection("crack-rebuild", w.slice(0, 2), { seconds: 8, pieces: 8 }) ?? "";
    st().setPlaying(false);
    const p = st().project!;
    const comp = currentComp(st())!;
    const inst = p.recipes[id];
    if (!inst) return { ok: false, note: "the effect wasn't applied" };
    const layers = Object.values(inst.generated).map((lid) => comp.layers[lid]!);
    const pieces = layers.filter((l) => l.name.startsWith("Piece"));
    const usesPhoto = pieces.every((l) => l.source.kind === "footage");
    const venue = activeVenue({ project: p })!;
    const moved = (sec: number) => {
      const t = secondsToTime(sec);
      const d = pieces.map((l) => {
        const home = l.transform.position.value;
        const now = evalProp(l.transform.position, t);
        return Math.hypot(now[0] - home[0], now[1] - home[1]);
      });
      return d.reduce((a, b) => a + b, 0) / Math.max(1, d.length);
    };
    const before = moved(1.5);
    const falling = moved(4.6);
    const rebuilt = moved(7.6);
    st().setTime(secondsToTime(4.2));
    return {
      ok: pieces.length >= 10 && before < 0.5 && falling > 100 && rebuilt < 0.5 && usesPhoto === !!venue.referenceAssetId,
      note: `${pieces.length} pieces on 2 windows (${usesPhoto ? "carrying the venue photo" : "lit slabs (no venue photo)"}); average distance from home: ${before.toFixed(1)} px before → ${falling.toFixed(0)} px while falling → ${rebuilt.toFixed(1)} px rebuilt`,
      settle: 600,
    };
  },
  "sim-export": async () => {
    const comp = currentComp(st())!;
    const paths = await window.be.app.paths();
    const fps = comp.frameRate.num / comp.frameRate.den;
    const id = await window.be.render.enqueue({
      name: "water export",
      outcome: "share",
      preset: "h264",
      compId: comp.id,
      target: { kind: "master", keepAlpha: false },
      output: `${paths.renders}\\ui-test\\water-${Date.now()}.mp4`,
      width: comp.width,
      height: comp.height,
      deliverSize: { width: Math.round(comp.width / 4) * 2, height: Math.round(comp.height / 4) * 2 },
      frameRate: comp.frameRate,
      startFrame: Math.round(4 * fps),
      frames: Math.round(1.5 * fps),
      alpha: false,
      withAudio: false,
      estimatedBytes: 5_000_000,
      snapshot: JSON.stringify(st().project),
    });
    let job: RenderJob | undefined;
    await until(() => {
      void window.be.render.list().then((l) => (job = l.find((j) => j.id === id)));
      return job?.state === "done" || job?.state === "failed";
    }, 180_000);
    return { ok: job?.state === "done", note: job?.state === "done" ? `background export with the water simulation: ${job.verify?.checks.map((c) => `${c.ok ? "✓" : "✗"}${c.name}`).join(" ")}` : `failed: ${job?.error}` };
  },
};

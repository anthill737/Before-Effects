/**
 * Where a frame's time goes, stage by stage (diagnostics for preview speed): getting media and
 * simulations ready, evaluating the scene, recording the GPU work, the GPU drawing it; and for frames
 * already on disk, reading the file, decoding the picture, uploading it. Each stage is timed on its
 * own (one frame at a time: latency), then a run of frames back to back (sustained frames a second).
 * A copy of the show with some kinds of layer switched off shows what those layers cost; the show
 * itself is never changed.
 */
import { evaluateComp, frameToTime, type Project } from "@be/core";
import { z } from "zod";
import { currentPreviewLoop } from "../preview/PreviewPanel.tsx";
import { getRenderer } from "../studio/engineHost.ts";
import { useStudio } from "../studio/store.ts";
import { AgentError, method } from "./core.ts";

const st = () => useStudio.getState();
const ms = (v: number) => Math.round(v * 10) / 10;
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { mean: ms(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)), median: ms(at(0.5)), p90: ms(at(0.9)), max: ms(at(1)) };
};

/** The show with some kinds of layer off (every composition), for measuring what they cost. */
const without = (p: Project, kinds: readonly string[]): Project => {
  if (!kinds.length) return p;
  const compositions = Object.fromEntries(
    Object.entries(p.compositions).map(([id, c]) => [
      id,
      {
        ...c,
        layers: Object.fromEntries(
          Object.entries(c.layers).map(([lid, l]) => {
            if (kinds.includes(l.source.kind)) return [lid, { ...l, enabled: false }];
            return [lid, { ...l, ...(kinds.includes("effects") ? { effects: [] } : {}), ...(kinds.includes("masks") ? { masks: [] } : {}) }];
          }),
        ),
      },
    ]),
  );
  return { ...p, compositions } as Project;
};

method({
  name: "preview.profile",
  summary:
    "Diagnostics: time each stage of making preview frames for a stretch of the current scene at a size (fraction 1, 0.5, 0.25, 0.125): media/simulations ready, scene evaluation, recording GPU work, GPU drawing; then frames back to back (sustained rate). without: switch off layer kinds in a copy (scene3d, footage, solid, text, shape, comp; effects or masks: those removed) to see what they cost. Frames already on disk: read, decode and upload times.",
  params: z.object({
    fromSeconds: z.number().min(0),
    toSeconds: z.number().min(0),
    fraction: z.number().min(0.05).max(1).default(1),
    step: z.number().int().min(1).max(300).default(5),
    without: z.array(z.string()).default([]),
    disk: z.boolean().default(false),
  }),
  long: true,
  run: async (p) => {
    const s = st();
    const project = s.project;
    const compId = s.compId;
    if (!project || !compId) throw new AgentError("unavailable", "No scene is open.");
    const comp = project.compositions[compId]!;
    const r = await getRenderer();
    const pr = without(project, p.without);
    const rate = comp.frameRate;
    const f0 = Math.floor((p.fromSeconds * rate.num) / rate.den);
    const f1 = Math.ceil((p.toSeconds * rate.num) / rate.den);
    const frames: number[] = [];
    for (let f = f0; f < f1; f += p.step) frames.push(f);
    const venueId = comp.venueId ?? project.activeVenueId;
    const prep: number[] = [];
    const evalMs: number[] = [];
    const issue: number[] = [];
    const gpu: number[] = [];
    let incomplete = 0;
    s.setPlaying(false);
    const done = () => r.gpu.device.queue.onSubmittedWorkDone();
    await done();
    // One frame at a time: each stage on its own.
    for (const f of frames) {
      const t = frameToTime(f, rate);
      let a = performance.now();
      await r.prepareAt(pr, compId, t, p.fraction);
      prep.push(performance.now() - a);
      a = performance.now();
      evaluateComp(pr, compId, t, venueId ? { venueId } : {});
      evalMs.push(performance.now() - a);
      a = performance.now();
      const tex = r.renderContent(pr, compId, t, p.fraction, "full");
      issue.push(performance.now() - a);
      a = performance.now();
      await done();
      gpu.push(performance.now() - a);
      if (r.lastFrameIncomplete) incomplete++;
      if (tex) r.gpu.release(tex);
    }
    // Back to back (as preparation and playback render): every frame of the stretch, media awaited only when needed.
    const all: number[] = [];
    for (let f = f0; f < f1; f++) all.push(f);
    const t0 = performance.now();
    let inFlight = 0;
    for (const f of all) {
      const t = frameToTime(f, rate);
      await r.prepareAt(pr, compId, t, p.fraction);
      const tex = r.renderContent(pr, compId, t, p.fraction, "full");
      if (tex) r.gpu.release(tex);
      if (++inFlight >= 2) {
        await done();
        inFlight = 0;
      }
    }
    await done();
    const sustained = all.length / ((performance.now() - t0) / 1000);
    // Frames on disk: read, decode, upload (through the preview's own disk cache).
    let disk: Record<string, unknown> | null = null;
    if (p.disk) {
      const loop = currentPreviewLoop();
      const read: number[] = [];
      const decode: number[] = [];
      const upload: number[] = [];
      let found = 0;
      const keys = await window.be.cache.keys({ project: project.id, comp: compId });
      const byFrame = new Map<number, string>();
      for (const k of keys) {
        const m = /^(\d+)\|1\.00000\|full\|/.exec(k);
        if (m) byFrame.set(Number(m[1]), k);
      }
      for (const f of frames) {
        const key = byFrame.get(f);
        if (!key) continue;
        found++;
        let a = performance.now();
        const bytes = await window.be.cache.get({ project: project.id, comp: compId }, key);
        read.push(performance.now() - a);
        if (!bytes) continue;
        a = performance.now();
        const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        decode.push(performance.now() - a);
        a = performance.now();
        const tex = r.gpu.device.createTexture({ size: [bmp.width, bmp.height], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        r.gpu.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
        await done();
        upload.push(performance.now() - a);
        tex.destroy();
        bmp.close();
      }
      // Decoding straight to a smaller picture (what a Half or Quarter preview needs from a full-size frame).
      const decodeSmall: number[] = [];
      for (const f of frames.slice(0, 10)) {
        const key = byFrame.get(f);
        const bytes = key ? await window.be.cache.get({ project: project.id, comp: compId }, key) : null;
        if (!bytes) continue;
        const a = performance.now();
        const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }), { colorSpaceConversion: "none", premultiplyAlpha: "none", resizeWidth: 960, resizeHeight: 1080, resizeQuality: "low" });
        decodeSmall.push(performance.now() - a);
        bmp.close();
      }
      disk = { found, readMs: stats(read), decodeMs: stats(decode), uploadMs: stats(upload), decodeToHalfMs: stats(decodeSmall), loopReadAvgMs: ms(loop?.disk.readMs ?? 0) };
    }
    return {
      frames: frames.length,
      size: `${Math.round(comp.width * p.fraction)}×${Math.round(comp.height * p.fraction)}`,
      without: p.without,
      incomplete,
      mediaReadyMs: stats(prep),
      evaluateMs: stats(evalMs),
      recordGpuWorkMs: stats(issue),
      gpuDrawMs: stats(gpu),
      sustainedFps: ms(sustained),
      disk,
    };
  },
});

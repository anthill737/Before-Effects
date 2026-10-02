/**
 * Hidden render worker: renders queued exports from their snapshots, at full size and quality,
 * independent of anything shown in the editor. One job at a time; progress is reported to the queue.
 */
import { frameToTime, type Project } from "@be/core";
import { halfToU16 } from "@be/engine";
import type { RenderJob } from "../../../shared/api.ts";
import { mixdownWav } from "../studio/audioEngine.ts";
import { getMediaHost, getRenderer } from "../studio/engineHost.ts";
import { useStudio } from "../studio/store.ts";

const cancelled = new Set<string>();

const plain = (e: unknown): string => {
  const m = String((e as Error)?.message ?? e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
};

const run = async (job: RenderJob) => {
  const be = window.be;
  let encodeId: string | null = null;
  const t0 = performance.now();
  try {
    const project = JSON.parse(job.snapshot) as Project;
    // The snapshot is this window's project: later edits in the editor never reach it.
    useStudio.setState({ project, compId: job.compId, screen: "studio" });
    const r = await getRenderer();
    const host = getMediaHost();
    if (host) host.project = project;
    const comp = project.compositions[job.compId];
    if (!comp) throw new Error("The scene for this export no longer exists in the snapshot.");

    let audioPath: string | undefined;
    if (job.withAudio) {
      be.render.progress(job.id, { phase: "Mixing the sound" });
      const from = frameToTime(job.startFrame, comp.frameRate);
      const to = frameToTime(job.startFrame + job.frames, comp.frameRate);
      const wav = await mixdownWav(project, comp.id, from, to);
      if (wav) {
        audioPath = `${job.output}.mix.wav`;
        await be.files.writeBinary(audioPath, wav);
      }
    }

    const high = job.preset.startsWith("prores");
    const { id } = await be.encode.start({
      preset: job.preset,
      output: job.output,
      width: job.width,
      height: job.height,
      frameRate: job.frameRate,
      ...(audioPath ? { audioPath } : {}),
      ...(job.deliverSize ? { deliverSize: job.deliverSize } : {}),
    });
    encodeId = id;
    for (let f = 0; f < job.frames; f++) {
      if (cancelled.has(job.id)) {
        await be.encode.cancel(id);
        be.render.finished(job.id, { state: "cancelled", phase: "Cancelled", done: f });
        return;
      }
      const t = frameToTime(job.startFrame + f, comp.frameRate);
      const px = await r.renderPixels(project, comp.id, t, job.target, high ? "rgba16" : "rgba8");
      await be.encode.frame(id, high ? halfToU16(px.data) : px.data);
      if (f % 5 === 4 || f === job.frames - 1) {
        const secs = (performance.now() - t0) / 1000;
        const fps = (f + 1) / secs;
        be.render.progress(job.id, { phase: "Rendering frames", done: f + 1, fps: Math.round(fps * 10) / 10, etaSeconds: Math.round((job.frames - f - 1) / Math.max(0.01, fps)) });
      }
      // Yield so the GPU and the editor stay responsive.
      await new Promise((res) => setTimeout(res, 0));
    }
    be.render.progress(job.id, { phase: "Finishing the file", done: job.frames });
    const res = await be.encode.finish(id);
    encodeId = null;
    if (!res.ok) throw new Error(res.error ?? "The encoder reported a problem.");
    be.render.progress(job.id, { phase: "Checking the file" });
    const size = job.deliverSize ?? { width: job.width, height: job.height };
    const verify = await be.media.verify(res.output, { width: size.width, height: size.height, frameRate: job.frameRate, frames: job.frames, alpha: job.alpha, audio: !!audioPath });
    be.render.finished(job.id, {
      state: verify.ok ? "done" : "failed",
      phase: verify.ok ? "Done" : "The file didn't pass its check",
      result: res.output,
      sizeBytes: verify.probe.sizeBytes,
      verify,
      ...(verify.ok ? {} : { error: verify.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.actual} (expected ${c.expected})`).join("; ") }),
    });
  } catch (e) {
    if (encodeId) await be.encode.cancel(encodeId).catch(() => undefined);
    be.render.finished(job.id, { state: "failed", phase: "Failed", error: plain(e) });
  }
};

export const startRenderWorker = () => {
  document.body.textContent = "Before Effects render worker";
  window.be.render.onCancel((id) => cancelled.add(id));
  let busy = Promise.resolve();
  window.be.render.onJob((job) => {
    busy = busy.then(() => run(job));
  });
  window.be.render.ready();
};

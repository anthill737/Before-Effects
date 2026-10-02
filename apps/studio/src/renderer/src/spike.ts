/**
 * Milestone A architecture spike. It proves the chosen stack can:
 *   1. composite layers (shapes, masks, glow) in linear light on WebGPU,
 *   2. render an animated 3D scene (three.js, same GPU device) at exact times,
 *   3. warp output through a projector calibration,
 *   4. encode usable video (H.264, ProRes 4444 with alpha), verified automatically,
 *   5. render deterministically regardless of frame order.
 * Run with: pnpm --filter @be/studio spike  (prints SPIKE_REPORT and writes spike-report.json).
 */
import { boxObject, type Composition, frameToTime, type History, lightObject, newLayer, type Project, secondsToTime, staticProp, type Vec3 } from "@be/core";
import { FrameRenderer, type FrameTarget, halfToU16, type PixelFrame } from "@be/engine";
import type { PresetId } from "@be/media";
import { createSampleHistory } from "./samples/facade.ts";

interface Step {
  name: string;
  ok: boolean;
  ms: number;
  details?: unknown;
}

const now = () => performance.now();

/** Keep only JSON-safe data in the report (drops class instances such as the editing history). */
const safe = (v: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(v, (_k, x) => (x && typeof x === "object" && x.constructor && !["Object", "Array"].includes(x.constructor.name) ? `[${x.constructor.name}]` : x)));
  } catch {
    return String(v);
  }
};

const sha256 = async (data: Uint8Array): Promise<string> => {
  const d = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const buildSpikeProject = (): { history: History; compId: string } => {
  const { history, compId } = createSampleHistory();
  const p = history.project;
  const comp = p.compositions[compId]!;
  // A 3D scene seen "through" the door: the first step toward the tunnel/recess illusion.
  const portal = newLayer({ id: "layer-portal", name: "3D portal", source: { kind: "scene3d", sceneId: "demo" }, duration: comp.duration });
  // A lit, shadowed, spinning box stored in the project (a function of time: any frame in any order).
  const spin = { value: [0, 0, 0] as Vec3, keyframes: [0, 4].map((s, i) => ({ id: `spin${i}`, t: secondsToTime(s), v: [s * 60, s * 90, 0] as Vec3, in: "linear" as const, out: "linear" as const })) };
  const box = { ...boxObject("box", "Box", [1.2, 1.2, 1.2], [0, comp.height * 0.005, 0.8]), rotation: spin };
  history.apply({
    type: "scene3d.add",
    args: {
      scene: {
        id: "demo",
        name: "Portal",
        objectOrder: ["box", "key", "fill"],
        objects: { box, key: lightObject("key", "Key", { target: [0, comp.height * 0.005, 0] }, [3, 8, 6]), fill: lightObject("fill", "Fill", { type: "ambient", intensity: staticProp(0.4), castShadow: false }, [0, 0, 0]) },
        gravity: [0, -9.81, 0],
        cameraDistance: 1.6,
      },
    },
  });
  history.apply([
    {
      type: "layer.add",
      args: {
        compId,
        layer: {
          ...portal,
          masks: [{ id: "mask-door", name: "Door", source: { kind: "region", ref: { role: "door" } }, mode: "add", inverted: false, feather: staticProp(2), expansion: staticProp(0), opacity: staticProp(100) }],
        },
      },
    },
    { type: "recipe.apply", args: { instanceId: "rcp-lights", recipeId: "sequence-light-up", compId, targets: [{ role: "windows" }], startTime: frameToTime(6, comp.frameRate) } },
    { type: "recipe.apply", args: { instanceId: "rcp-trace", recipeId: "edge-trace", compId, targets: [{ role: "roofline" }, { role: "door" }], params: { lapSeconds: 2 } } },
  ]);
  // Point the projector somewhere off-axis: the output must be pre-warped to land on the facade.
  history.apply({
    type: "calibration.setPoints",
    args: {
      venueId: "venue-sample",
      projectorId: "projector-1",
      mode: "corner-pin",
      points: [
        { id: "c1", label: "1", content: [0, 0], output: [70, 40] },
        { id: "c2", label: "2", content: [1920, 0], output: [1870, 95] },
        { id: "c3", label: "3", content: [1920, 1080], output: [1815, 1050] },
        { id: "c4", label: "4", content: [0, 1080], output: [120, 1005] },
      ],
    },
  });
  return { history, compId };
};

const exportFrames = async (
  renderer: FrameRenderer,
  project: Project,
  comp: Composition,
  target: FrameTarget,
  preset: PresetId,
  output: string,
  frames: number,
  alpha: boolean,
): Promise<{ result: unknown; verify: unknown; msPerFrame: number; ok: boolean }> => {
  const high = preset.startsWith("prores");
  const width = target.kind === "projector" ? project.venues[target.venueId]!.projectors[target.projectorId]!.output.width : comp.width;
  const height = target.kind === "projector" ? project.venues[target.venueId]!.projectors[target.projectorId]!.output.height : comp.height;
  const { id } = await window.be.encode.start({ preset, output, width, height, frameRate: comp.frameRate });
  const t0 = now();
  for (let f = 0; f < frames; f++) {
    const px: PixelFrame = await renderer.renderPixels(project, comp.id, frameToTime(f, comp.frameRate), target, high ? "rgba16" : "rgba8");
    await window.be.encode.frame(id, high ? halfToU16(px.data) : px.data);
  }
  const result = await window.be.encode.finish(id);
  const msPerFrame = (now() - t0) / frames;
  const verify = result.ok ? await window.be.media.verify(result.output, { width, height, frameRate: comp.frameRate, frames, alpha, audio: false }) : null;
  return { result: { ...result, log: result.ok ? undefined : result.log.slice(-1500) }, verify, msPerFrame, ok: result.ok && !!verify?.ok };
};

const still = async (renderer: FrameRenderer, project: Project, comp: Composition, target: FrameTarget, t: number, output: string) => {
  const px = await renderer.renderPixels(project, comp.id, t, target, "rgba8");
  const { id } = await window.be.encode.start({ preset: "png-sequence", output, width: px.width, height: px.height, frameRate: comp.frameRate });
  await window.be.encode.frame(id, px.data);
  return window.be.encode.finish(id);
};

export const runSpike = async (): Promise<void> => {
  const steps: Step[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>, check: (v: T) => boolean = () => true): Promise<T | null> => {
    const t0 = now();
    try {
      const v = await fn();
      const ok = check(v);
      steps.push({ name, ok, ms: Math.round(now() - t0), details: safe(v) });
      window.be.app.log(`${ok ? "PASS" : "FAIL"} ${name} (${Math.round(now() - t0)} ms)`);
      return v;
    } catch (e) {
      steps.push({ name, ok: false, ms: Math.round(now() - t0), details: String((e as Error)?.stack ?? e) });
      window.be.app.log(`FAIL ${name}: ${String(e)}`);
      return null;
    }
  };

  const paths = await window.be.app.paths();
  const outDir = `${paths.renders}\\milestone-a`;
  const renderer = await step("GPU device (WebGPU, high-performance adapter)", async () => FrameRenderer.create());
  if (!renderer) return window.be.app.reportSpike({ ok: false, steps });
  steps[steps.length - 1]!.details = safe(renderer.gpu.info);

  const built = await step("Build project through operations (sample venue + 2 recipes + 3D portal)", async () => buildSpikeProject());
  if (!built) return window.be.app.reportSpike({ ok: false, steps });
  const project = built.history.project;
  const comp = project.compositions[built.compId]!;
  const master: FrameTarget = { kind: "master", keepAlpha: false };
  const projector: FrameTarget = { kind: "projector", venueId: "venue-sample", projectorId: "projector-1" };

  await step("Determinism: same frame, different render order → identical pixels", async () => {
    const order = [45, 10, 80, 45, 0, 45];
    const hashes: Record<number, string[]> = {};
    for (const f of order) {
      const px = await renderer.renderPixels(project, comp.id, frameToTime(f, comp.frameRate), master);
      (hashes[f] ??= []).push(await sha256(px.data));
    }
    const p = await renderer.renderPixels(project, comp.id, frameToTime(45, comp.frameRate), projector);
    const p2 = await renderer.renderPixels(project, comp.id, frameToTime(45, comp.frameRate), projector);
    return { hashes, projectorStable: (await sha256(p.data)) === (await sha256(p2.data)), differentFramesDiffer: hashes[10]![0] !== hashes[80]![0] };
  }, (v) => v.hashes[45]!.every((h) => h === v.hashes[45]![0]) && v.projectorStable && v.differentFramesDiffer);

  await step("Stills for visual review (master + projector output at 2.5 s)", async () => ({
    master: await still(renderer, project, comp, master, frameToTime(75, comp.frameRate), `${outDir}\\still-master`),
    projector: await still(renderer, project, comp, projector, frameToTime(75, comp.frameRate), `${outDir}\\still-projector`),
    projectorGrid: await still(renderer, project, comp, { ...projector, showGrid: true }, frameToTime(75, comp.frameRate), `${outDir}\\still-projector-grid`),
  }), (v) => v.master.ok && v.projector.ok && v.projectorGrid.ok);

  await step("Export master H.264 MP4, 1920×1080, 90 frames — verified", async () => exportFrames(renderer, project, comp, master, "h264", `${outDir}\\master-h264.mp4`, 90, false), (v) => v.ok);
  await step("Export transparent master ProRes 4444, 30 frames — alpha verified", async () => exportFrames(renderer, project, comp, { kind: "master", keepAlpha: true }, "prores-4444", `${outDir}\\master-prores4444.mov`, 30, true), (v) => v.ok);
  await step("Export projector output (calibrated warp) H.264, 90 frames — verified", async () => exportFrames(renderer, project, comp, projector, "h264", `${outDir}\\projector-1-h264.mp4`, 90, false), (v) => v.ok);
  await step("Export projector output HAP Q for media servers, 30 frames — verified", async () => exportFrames(renderer, project, comp, projector, "hap", `${outDir}\\projector-1-hapq.mov`, 30, false), (v) => v.ok);

  await step("Save and reopen project JSON round-trip", async () => {
    const json = JSON.stringify(project);
    const reopened = JSON.parse(json) as Project;
    const a = await renderer.renderPixels(project, comp.id, frameToTime(33, comp.frameRate), master);
    const b = await renderer.renderPixels(reopened, comp.id, frameToTime(33, comp.frameRate), master);
    await window.be.files.writeText(`${outDir}\\spike-project.beproj`, json);
    return { bytes: json.length, identical: (await sha256(a.data)) === (await sha256(b.data)) };
  }, (v) => v.identical);

  const ok = steps.every((s) => s.ok);
  await window.be.app.reportSpike({ ok, outDir, gpu: renderer.gpu.info, warnings: renderer.compositor.stats.warnings, steps });
};

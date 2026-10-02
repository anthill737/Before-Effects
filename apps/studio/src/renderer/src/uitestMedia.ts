/**
 * Journey steps with the person's own media and music: import a picture, a video and a song,
 * put the video in the windows, add text, add music, make the windows move with the beat,
 * hear it in preview, export with sound, and measure picture/sound timing in the exported file.
 */
import { secondsToTime } from "@be/core";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreview } from "./preview/settings.ts";
import { applyEffect, applyRecipeToSelection } from "./studio/actions.ts";
import { previewAudio } from "./studio/audioEngine.ts";
import { addAssetLayer, importMediaFiles } from "./studio/media.ts";
import { activeVenue, currentComp, useStudio } from "./studio/store.ts";

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
const st = () => useStudio.getState();
const assetsOf = (kind: string) => Object.values(st().project!.assets).filter((a) => a.kind === kind);
const windows = () => Object.values(activeVenue({ project: st().project! })!.regions).filter((r) => r.kind === "window").map((r) => r.id);

/** A 120 BPM click track with louder downbeats (stands in for the person's music). */
const clickTrack = (seconds: number, bpm = 120, sr = 48000): Uint8Array => {
  const n = seconds * sr;
  const pcm = new Int16Array(n * 2);
  const period = 60 / bpm;
  for (let b = 0; b * period < seconds; b++) {
    const t0 = Math.round(b * period * sr);
    const amp = b % 4 === 0 ? 0.9 : 0.55;
    for (let i = 0; i < sr * 0.04 && t0 + i < n; i++) {
      const v = amp * Math.sin((2 * Math.PI * 900 * i) / sr) * Math.exp((-i / sr) * 90) + amp * 0.6 * Math.sin((2 * Math.PI * 70 * i) / sr) * Math.exp((-i / sr) * 25);
      pcm[(t0 + i) * 2] = pcm[(t0 + i) * 2 + 1] = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
    }
  }
  const head = new DataView(new ArrayBuffer(44));
  const str = (o: number, s: string) => [...s].forEach((c, i) => head.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  head.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true);
  head.setUint16(22, 2, true);
  head.setUint32(24, sr, true);
  head.setUint32(28, sr * 4, true);
  head.setUint16(32, 4, true);
  head.setUint16(34, 16, true);
  str(36, "data");
  head.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(head.buffer), 0);
  out.set(new Uint8Array(pcm.buffer), 44);
  return out;
};

let exportedPath = "";

export const MEDIA_STEPS: Record<string, () => Promise<{ ok: boolean; note?: string; settle?: number }>> = {
  "import-media": async () => {
    const paths = await window.be.app.paths();
    const wav = `${paths.renders}\\ui-test\\click-120bpm.wav`;
    await window.be.files.writeBinary(wav, clickTrack(30));
    const video = `${paths.renders}\\milestone-a\\master-h264.mp4`;
    const image = `${paths.renders}\\ui-test\\test-photo-house.png`;
    const files = [image, wav, ...((await window.be.files.exists(video)) ? [video] : [])];
    const added = await importMediaFiles(files);
    const analysed = await until(() => (assetsOf("audio")[0]?.analysis?.bpm ?? 0) > 0, 20000);
    const bpm = assetsOf("audio")[0]?.analysis?.bpm ?? 0;
    return { ok: added.length === files.length && analysed && Math.abs(bpm - 120) < 2, note: `imported ${added.map((a) => `${a.kind} ${a.name}`).join(", ")}; beat found at ${bpm} BPM` };
  },
  "video-in-windows": async () => {
    const video = assetsOf("video")[0];
    if (!video) return { ok: false, note: "no test video available (run the spike once to create one)" };
    st().setPlaying(false);
    st().setTime(0);
    usePreview.getState().set({ view: "show", resolution: "half" });
    const id = applyRecipeToSelection("media-fill", windows(), { assetId: video.id });
    st().setPlaying(false);
    const samples: number[] = [];
    for (const sec of [0.6, 2.4]) {
      st().setTime(secondsToTime(sec));
      await sleep(1500); // let the frame decode
      samples.push((await currentPreviewLoop()!.sample()).mean);
    }
    const frames = (await import("./studio/engineHost.ts")).getMediaHost()?.stats().frames ?? 0;
    return { ok: !!id && samples[0]! > 0 && samples[0] !== samples[1], note: `video plays inside the six windows (${frames} decoded frames cached); preview brightness ${samples.join(" → ")}`, settle: 800 };
  },
  "text-on-window": async () => {
    const w = windows()[1]!;
    st().selectRegions([w]);
    const id = await applyEffect("text-on-surface");
    if (!id) return { ok: false };
    st().apply({ type: "recipe.update", args: { instanceId: id, params: { text: "Hello!" } } });
    const comp = currentComp(st())!;
    const layer = Object.values(comp.layers).find((l) => l.generatedBy?.recipeInstanceId === id);
    return { ok: layer?.source.kind === "text" && layer.source.doc.text === "Hello!", note: "text added to a window, then edited", settle: 800 };
  },
  "music-on-timeline": async () => {
    const song = assetsOf("audio")[0]!;
    const lid = addAssetLayer(song, 0);
    await sleep(1500);
    const wave = !!document.querySelector(".bar.sound canvas.waveform");
    return { ok: !!lid && wave, note: "music added from the start; waveform shown in the timeline", settle: 600 };
  },
  "move-with-beat": async () => {
    // Keep the timing check clean: hide the video and text layers, leave the beat flashes.
    const comp = currentComp(st())!;
    for (const l of Object.values(comp.layers)) if (l.source.kind === "footage" || l.source.kind === "text") st().apply({ type: "layer.update", args: { compId: comp.id, layerId: l.id, changes: { enabled: false } } });
    st().selectRegions(windows());
    const id = await applyEffect("move-with-beat");
    const inst = id ? st().project!.recipes[id] : undefined;
    const layer = inst ? currentComp(st())!.layers[Object.values(inst.generated)[0]!] : undefined;
    // For the timing measurement, only the beat flashes (and the music) stay visible/audible.
    const c2 = currentComp(st())!;
    for (const l of Object.values(c2.layers))
      if (l.enabled && l.id !== layer?.id && l.source.kind !== "audio") st().apply({ type: "layer.update", args: { compId: c2.id, layerId: l.id, changes: { enabled: false } } });
    const kfs = layer?.source.kind === "shape" ? (layer.source.contents[0]?.fill?.opacity.keyframes?.length ?? 0) : 0;
    return { ok: !!id && kfs > 40, note: `windows flash on every beat (${kfs} keyframes per window, generated from the detected beats)`, settle: 800 };
  },
  "audio-preview-sync": async () => {
    st().setTime(0);
    st().setPlaying(true);
    const started = await until(() => previewAudio.isRunning, 8000);
    await sleep(2000);
    const audioT = previewAudio.now() ?? 0;
    const picT = st().time;
    st().setPlaying(false);
    await sleep(200);
    return { ok: started && Math.abs(audioT - picT) < secondsToTime(0.06) && picT > secondsToTime(1.5), note: `sound plays during preview; picture follows the sound clock (difference ${Math.round(Math.abs(audioT - picT) / 705600)} ms)` };
  },
  "export-with-sound": async () => {
    click(byText(".route-step", "Export or play"));
    await until(() => !!(document.querySelector("dialog.export") as HTMLDialogElement | null)?.open);
    click(byText("dialog.export .outcome", "A video to share"));
    await until(() => !!byText("dialog.export h3", "A video to share"));
    const soundLine = byText("dialog.export dd", "Included")?.textContent ?? "";
    const before = (await window.be.render.list()).length;
    click(byText("dialog.export button", "Export"));
    await until(() => !!byText("dialog.export h3", "Exporting in the background"), 8000);
    click(document.querySelector('dialog.export button[aria-label="Close"]'));
    let job: Awaited<ReturnType<typeof window.be.render.list>>[number] | undefined;
    const ok = await until(() => {
      void window.be.render.list().then((l) => (job = l.length > before ? l[l.length - 1] : undefined));
      return job?.state === "done" || job?.state === "failed";
    }, 400_000);
    const checks = job?.verify?.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.actual}`).join(", ") ?? job?.error ?? "";
    exportedPath = job?.result ?? "";
    return { ok: ok && job?.state === "done" && checks.includes("Sound: yes") && !!soundLine, note: `${soundLine}; ${checks}` };
  },
  "av-timing-measured": async () => {
    const m = await window.be.media.measureAv(exportedPath);
    const rise = (xs: number[], thr: number) => xs.map((v, i) => (i > 0 && v - xs[i - 1]! > thr && v > thr ? i : -1)).filter((i) => i >= 0);
    const maxB = Math.max(...m.brightness);
    const flashes = rise(m.brightness, maxB * 0.15).filter((f, i, arr) => i === 0 || f - arr[i - 1]! > 3);
    const maxL = Math.max(...m.loudness);
    const clicks = rise(m.loudness, maxL * 0.2).filter((f, i, arr) => i === 0 || f - arr[i - 1]! > 3);
    // Pair each click with the nearest flash within ±3 frames; unmatched events are reported, not hidden.
    const pairs = clicks
      .map((c) => {
        const f = flashes.reduce((best, x) => (Math.abs(x - c) < Math.abs(best - c) ? x : best), flashes[0] ?? -999);
        return Math.abs(f - c) <= 3 ? f - c : null;
      })
      .filter((x): x is number => x !== null);
    const worst = pairs.length ? Math.max(...pairs.map(Math.abs)) : 99;
    const mean = pairs.reduce((a, b) => a + b, 0) / Math.max(1, pairs.length);
    const ms = (mean / m.fps) * 1000;
    return {
      ok: clicks.length > 20 && pairs.length >= clicks.length * 0.9 && worst <= 1,
      note: `${clicks.length} clicks, ${flashes.length} flashes in ${exportedPath.split("\\").pop()}; ${pairs.length} paired within 3 frames; flash−click offset mean ${mean.toFixed(2)} frames (${ms.toFixed(0)} ms), worst ${worst} frame at ${m.fps} fps`,
    };
  },
};

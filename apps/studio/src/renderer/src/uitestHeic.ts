/**
 * Journey steps with real HEIC photos (from "Test content\heic-samples" in the data folder): a new
 * show from a rotated HEIC photo, an area traced on it, HEIC pictures imported as content (with a
 * thumbnail, and one with transparency), shown in the preview, saved and reopened, and exported —
 * checking the exported frame has the picture in the area and none of the building photo.
 */
import { secondsToTime, timeToSeconds } from "@be/core";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreview } from "./preview/settings.ts";
import { createProjectFromPhoto } from "./space/actions.ts";
import { useTrace } from "./space/traceStore.ts";
import { assignMedia } from "./studio/assign.ts";
import { importMediaFiles } from "./studio/media.ts";
import { deserialize, serialize } from "./studio/persistence.ts";
import { activeVenue, useStudio } from "./studio/store.ts";

type Step = () => Promise<{ ok: boolean; note?: string; settle?: number }>;

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
const venue = () => activeVenue({ project: st().project! })!;
const pointer = (type: string, cx: number, cy: number) => {
  const svg = document.querySelector<SVGSVGElement>("svg.trace")!;
  const r = svg.getBoundingClientRect();
  const v = venue();
  svg.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: r.left + (cx / v.canvas.width) * r.width, clientY: r.top + (cy / v.canvas.height) * r.height, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1 }));
};
const pixels = async (path: string) => {
  const bmp = await createImageBitmap(new Blob([(await window.be.files.readFile(path)) as BlobPart]), { premultiplyAlpha: "none" });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return g.getImageData(0, 0, c.width, c.height);
};

let dir = "";
let skip = "";
let areaId = "";
let pictureId = "";
let savedPath = "";
/** The window area traced on the photo (canvas pixels); the photo itself spans x 600–1320. */
const AREA = { x: 700, y: 300, w: 500, h: 400 };
const OFF_AREA = { x: 1250, y: 900 };

const skipped = () => ({ ok: true, note: `SKIPPED: ${skip}` });

export const HEIC_STEPS: Record<string, Step> = {
  "heic-new-show": async () => {
    dir = `${(await window.be.app.paths()).renders.replace(/[\\/]Renders$/, "")}\\Test content\\heic-samples`;
    try {
      await window.be.files.readFile(`${dir}\\made-rotate90-autumn.heic`);
    } catch {
      skip = `no HEIC samples in ${dir}`;
      return skipped();
    }
    // 1440×960 photo stored with a 90° rotation: it should arrive upright as 960×1440.
    const ok = await createProjectFromPhoto({ path: `${dir}\\made-rotate90-autumn.heic`, dataUrl: "" });
    await until(() => !!document.querySelector(".photo-underlay"), 5000);
    const v = venue();
    const photo = st().project!.assets[v.photo!.assetId]!;
    const ref = st().project!.assets[v.referenceAssetId!]!;
    const img = await pixels(ref.path);
    const at = (x: number, y: number) => img.data[(y * img.width + x) * 4 + 3]!;
    // Fitted without stretching: 960×1440 in 1080 high → 720 wide, centred (bars either side).
    const fitted = at(100, 540) === 0 && at(960, 540) === 255 && at(610, 540) === 255 && at(590, 540) === 0;
    return {
      ok: ok && v.canvas.width === 1920 && v.canvas.height === 1080 && photo.meta.width === 960 && photo.meta.height === 1440 && /\.heic$/i.test(photo.sourceFile ?? "") && /\.png$/i.test(photo.path) && fitted,
      note: `show ${v.canvas.width}×${v.canvas.height}; photo upright ${photo.meta.width}×${photo.meta.height} (stored rotated 90°); original kept as ${photo.sourceFile?.split("\\").pop()}, decoded copy ${photo.path.split("\\").pop()}; fitted without stretching (bars left/right: ${fitted})`,
      settle: 900,
    };
  },
  "heic-trace-area": async () => {
    if (skip) return skipped();
    useTrace.getState().set({ tool: "rect" });
    await sleep(100);
    pointer("pointerdown", AREA.x, AREA.y);
    pointer("pointermove", AREA.x + AREA.w / 2, AREA.y + AREA.h / 2);
    pointer("pointermove", AREA.x + AREA.w, AREA.y + AREA.h);
    pointer("pointerup", AREA.x + AREA.w, AREA.y + AREA.h);
    await until(() => !!document.querySelector(".kind-chooser"));
    click(byText(".kind-chooser button", "Window"));
    const ok = await until(() => Object.values(venue().regions).some((r) => r.kind === "window"));
    areaId = Object.values(venue().regions).find((r) => r.kind === "window")?.id ?? "";
    return { ok, note: "window area traced over the HEIC photo" };
  },
  "heic-import-thumbnails": async () => {
    if (skip) return skipped();
    st().setStep("content");
    const assets = await importMediaFiles([`${dir}\\phone-image1.heic`, `${dir}\\phone-image4.heic`], { quiet: true });
    const ok = await until(() => document.querySelectorAll("img.media-thumb").length >= 2 && [...document.querySelectorAll<HTMLImageElement>("img.media-thumb")].every((i) => i.complete && i.naturalWidth > 0), 15000);
    pictureId = assets[0]?.id ?? "";
    const alpha = assets[1] ? await pixels(assets[1].path) : null;
    let clear = 0;
    if (alpha) for (let i = 3; i < alpha.data.length; i += 4) if (alpha.data[i]! < 250) clear++;
    return {
      ok: ok && assets.length === 2 && assets.every((a) => /\.heic$/i.test(a.sourceFile ?? "")) && clear > 0 && !!assets[1]?.meta.hasAlpha,
      note: `${assets.map((a) => `${a.name} → ${a.meta.width}×${a.meta.height}${a.meta.hasAlpha ? " with transparency" : ""}`).join("; ")}; thumbnails shown; ${clear} see-through pixels kept in the transparent one`,
      settle: 900,
    };
  },
  "heic-in-preview": async () => {
    if (skip) return skipped();
    usePreview.getState().set({ view: "show" });
    // Content starts at the playhead and fades in over 0.3 s: put it in at 0 s, look one second in.
    st().setPlaying(false);
    st().setTime(secondsToTime(1));
    await sleep(300);
    const before = await currentPreviewLoop()?.sample();
    st().setTime(0);
    const inst = assignMedia(pictureId, [areaId], "each");
    st().setTime(secondsToTime(1));
    let after = before;
    await until(() => {
      void currentPreviewLoop()?.sample().then((s) => (after = s));
      return !!after && after.mean > (before?.mean ?? 0) + 0.02;
    }, 8000);
    return { ok: !!inst && !!after && after.mean > (before?.mean ?? 0) + 0.02, note: `HEIC picture put in the window: preview brightness ${before?.mean.toFixed(3)} → ${after?.mean.toFixed(3)}`, settle: 900 };
  },
  "heic-save-reopen": async () => {
    if (skip) return skipped();
    savedPath = `${(await window.be.app.paths()).renders}\\ui-test\\HEIC test.beproj`;
    const saved = await window.be.files.saveProject(serialize(st().project!), savedPath);
    const opened = await window.be.files.openProject(savedPath);
    st().openProject(deserialize(opened!.json), savedPath);
    await sleep(500);
    const p = st().project!;
    const v = venue();
    const heics = Object.values(p.assets).filter((a) => a.sourceFile);
    const readable = await Promise.all(heics.flatMap((a) => [a.path, a.sourceFile!]).map((f) => window.be.files.readFile(f).then((b) => b.length > 0).catch(() => false)));
    return {
      ok: !!saved && heics.length === 3 && readable.every(Boolean) && !!v.regions[areaId] && !!v.photo,
      note: `saved and reopened: ${heics.length} HEIC files, each with its original and decoded copy on disk; area and photo placement kept`,
    };
  },
  "heic-export": async () => {
    if (skip) return skipped();
    const p = st().project!;
    const show = p.compositions[p.mainCompId!]!;
    const fps = show.frameRate.num / show.frameRate.den;
    const output = `${(await window.be.app.paths()).renders}\\ui-test\\HEIC test.mp4`;
    const id = await window.be.render.enqueue({
      name: "HEIC test",
      outcome: "share",
      preset: "h264",
      compId: show.id,
      target: { kind: "master", keepAlpha: false },
      output,
      width: show.width,
      height: show.height,
      frameRate: show.frameRate,
      startFrame: 0,
      frames: Math.round(fps * 2),
      alpha: false,
      withAudio: false,
      estimatedBytes: 4_000_000,
      snapshot: JSON.stringify(p),
    });
    let job: Awaited<ReturnType<typeof window.be.render.list>>[number] | undefined;
    const t0 = performance.now();
    while (performance.now() - t0 < 180_000) {
      job = (await window.be.render.list()).find((j) => j.id === id);
      if (job?.state === "done" || job?.state === "failed") break;
      await sleep(250);
    }
    const W = 480;
    const f = job?.state === "done" ? await window.be.media.decodeFrame(job.result!, Math.round(fps), fps, W, show.width, show.height) : null;
    const k = f ? f.width / show.width : 0;
    const px = (x: number, y: number) => (f ? [...f.data.slice((Math.round(y * k) * f.width + Math.round(x * k)) * 4, (Math.round(y * k) * f.width + Math.round(x * k)) * 4 + 3)] : [0, 0, 0]);
    const inArea = px(AREA.x + AREA.w / 2, AREA.y + AREA.h / 2);
    const onPhoto = px(OFF_AREA.x, OFF_AREA.y);
    const ok = job?.state === "done" && inArea.some((c) => c > 30) && onPhoto.every((c) => c < 12);
    return { ok, note: `exported ${timeToSeconds(show.duration) > 2 ? "2 s" : ""} at ${show.width}×${show.height}: picture in the area rgb(${inArea.join(",")}); building photo elsewhere not exported rgb(${onPhoto.join(",")}) → ${output}` };
  },
};

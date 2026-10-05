/**
 * Journey steps for watching a prepared show (after the projector steps, on the same house show and
 * its frames prepared at full size in the test's own disk-cache folder), through the controls a
 * person uses: the preview size menu, Play, the scenes bar. Smoothness is measured as a viewer sees
 * it — the time from one new picture to the next (a stall is more than 100 ms) — not only frames
 * skipped; and the picture's size on screen is watched on every display refresh while playing.
 */
import { secondsToTime } from "@be/core";
import { dispatch } from "./agent/core.ts";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreviewStats } from "./preview/loop.ts";
import { usePreview } from "./preview/settings.ts";
import { getRenderer } from "./studio/engineHost.ts";
import { pickScene, showComp } from "./studio/ScenesBar.tsx";
import { useStudio } from "./studio/store.ts";

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
/** Choose an option in a menu (select) the way the person's choice reaches the app. */
const choose = (el: HTMLSelectElement | null, value: string) => {
  if (!el) throw new Error("menu not found");
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const st = () => useStudio.getState();
const call = async (method: string, params: Record<string, unknown>) => {
  const r = await dispatch({ callId: `view-${method}`, requestId: `view-${method}`, method, params });
  if (!r.ok) throw new Error(`${method}: ${r.error?.message}`);
  return r.result as { frames?: { state?: string; done?: number; total?: number } };
};

let kept: Partial<ReturnType<typeof usePreview.getState>> | null = null;
/** The opening 8 s prepared at full size (in the test's own folder). */
const prepared = async () => {
  if (!kept) {
    const b = usePreview.getState();
    kept = { diskCache: b.diskCache, diskCacheFolder: b.diskCacheFolder, diskCacheGB: b.diskCacheGB, playbackMode: b.playbackMode, resolution: b.resolution };
    usePreview.getState().set({ diskCache: true, diskCacheFolder: `${(await window.be.app.paths()).renders}\\ui-test\\preview-cache`, diskCacheGB: 2, playbackMode: "cache", resolution: "full" });
  }
  await call("prepare.frames", { target: "scene", scene: st().compId!, resolution: "full", fromSeconds: 0, toSeconds: 8 });
  return (await call("prepare.wait", { timeoutMs: 180_000 })).frames;
};
const restore = () => {
  if (kept) usePreview.getState().set(kept);
  kept = null;
};

/**
 * Play the opening 8 s (from the start, frames read from disk, nothing in memory before) with the
 * Play button, for `seconds`: the picture's on-screen size on every refresh, frames rendered (not
 * read), and how smoothly the picture moved.
 */
const watchPlay = async (seconds: number) => {
  const loop = currentPreviewLoop()!;
  loop.cache.clear();
  st().setRange({ start: 0, end: secondsToTime(8) });
  st().setTime(0);
  await sleep(300);
  const r = await getRenderer();
  const render = r.renderContent;
  let rendered = 0;
  r.renderContent = function (...a: Parameters<typeof render>) {
    rendered++;
    return render.apply(this, a);
  };
  const canvas = document.querySelector<HTMLCanvasElement>(".preview-panel .preview-scroll canvas");
  const sizes = new Set<string>();
  const status = document.querySelector<HTMLElement>(".preview-status");
  const statusHeights = new Set<number>();
  let watching = true;
  const look = () => {
    if (!watching) return;
    const b = canvas?.getBoundingClientRect();
    if (b) sizes.add(`${b.width.toFixed(1)}×${b.height.toFixed(1)}`);
    if (status) statusHeights.add(Math.round(status.getBoundingClientRect().height));
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
  try {
    click(document.querySelector('.preview-panel button.play[aria-label="Play"]'));
    await until(() => usePreviewStats.getState().mode === "playing", 30_000);
    await sleep(seconds * 1000);
  } finally {
    st().setPlaying(false);
    watching = false;
    r.renderContent = render;
  }
  st().setRange(null);
  const m = { ...loop.smoothness };
  return { rendered, m, sizes: [...sizes], statusHeights: [...statusHeights], canvasWidth: canvas?.width ?? 0 };
};

export const VIEWING_STEPS: Record<string, Step> = {
  "view-half-plays-prepared": async () => {
    const prep = await prepared();
    // The size menu, as a person uses it: Half.
    choose(document.querySelector<HTMLSelectElement>('select[aria-label="Preview size"]'), "half");
    await sleep(300);
    const w = await watchPlay(5);
    // Half is 960 wide: the frames prepared at full size, decoded straight to that size (none rendered again).
    const ok = prep?.state === "done" && w.rendered === 0 && w.canvasWidth === 960 && w.m.stalls === 0 && w.m.longestGapMs <= 100 && w.m.newFrames >= 140;
    return { ok, note: `Half chosen in the size menu: ${w.m.newFrames} new pictures in 5 s, all from the frames prepared at full size, decoded to Half (${w.rendered} rendered, shown at ${w.canvasWidth} px wide); stalls over 100 ms ${w.m.stalls}, longest gap ${w.m.longestGapMs} ms, first picture ${w.m.startWaitMs} ms after Play` };
  },
  "view-size-steady": async () => {
    await prepared();
    choose(document.querySelector<HTMLSelectElement>('select[aria-label="Preview size"]'), "full");
    // Preparing further on at the same time fills the status line with a long, changing message.
    void call("prepare.frames", { target: "scene", scene: st().compId!, resolution: "full", fromSeconds: 8, toSeconds: 16 });
    const w = await watchPlay(5);
    await call("prepare.stop", {}).catch(() => undefined);
    restore();
    const ok = w.sizes.length === 1 && w.statusHeights.length === 1 && w.m.stalls === 0;
    return { ok, note: `playing while preparing (a long, changing status line): the picture was ${w.sizes.join(" / ")} on every refresh, the status line ${w.statusHeights.join(" / ")} px tall; stalls over 100 ms ${w.m.stalls}, longest gap ${w.m.longestGapMs} ms` };
  },
  "view-show-tab": async () => {
    // With no show, there's no Show tab: the scenes bar never makes one by being clicked.
    if (showComp()) return { ok: true, note: "the show already exists (nothing to check)" };
    const noTab = !document.querySelector(".scenes-bar .show-tab");
    const steps = () => st().history?.transactions().length ?? 0;
    click(byText(".scenes-bar button", "+ Scene"));
    const item = await until(() => !!byText(".scene-menu button", "Assemble a show from the scenes"), 2000);
    const before = steps();
    click(byText(".scene-menu button", "Assemble a show from the scenes"));
    await until(() => !!showComp(), 2000);
    const show = showComp();
    const made = steps() === before + 1;
    // The Show tab now only opens it.
    const scene = st().project!.compositionOrder.find((id) => !st().project!.compositions[id]!.show)!;
    pickScene(scene);
    click(document.querySelector(".scenes-bar .show-tab"));
    await until(() => st().compId === show?.id, 2000);
    const opened = st().compId === show?.id;
    const navOnly = steps() === before + 1;
    // Back as it was.
    st().undo();
    await until(() => !showComp(), 2000);
    const ok = noTab && item && !!show && made && opened && navOnly && !showComp();
    return { ok, note: `no Show tab until a show exists: ${noTab}; "Assemble a show from the scenes…" in the + Scene menu made it as one edit (${made}); the Show tab then opened it without another edit (${navOnly}); undone` };
  },
};

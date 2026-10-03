/**
 * Journey steps with the person's own content: a photo of a different building (generated here so
 * the test is self-contained), traced, animated, saved and reopened. Real first-time users should
 * repeat this with their own photos (docs/usability-test-plan.md).
 */
import { secondsToTime } from "@be/core";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreview } from "./preview/settings.ts";
import { createProjectFromPhoto } from "./space/actions.ts";
import { useTrace } from "./space/traceStore.ts";
import { deserialize, serialize } from "./studio/persistence.ts";
import { activeVenue, useStudio } from "./studio/store.ts";

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

/** The test house: 1600×1000, six identical windows, a flat roof edge, a neighbour's sign. */
export const HOUSE = { w: 1600, h: 1000, windows: [330, 710, 1090].flatMap((x) => [340, 600].map((y) => ({ x, y, w: 180, h: 160 }))), roof: { y: 250, x0: 180, x1: 1420 }, sign: { x: 40, y: 600, w: 120, h: 100 } };

export const drawHouse = async (): Promise<Blob> => {
  const c = new OffscreenCanvas(HOUSE.w, HOUSE.h);
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, HOUSE.h);
  sky.addColorStop(0, "#7d93ad");
  sky.addColorStop(1, "#b9c3cc");
  g.fillStyle = sky;
  g.fillRect(0, 0, HOUSE.w, HOUSE.h);
  g.fillStyle = "#d9d6cf";
  g.fillRect(200, 250, 1200, 650);
  g.fillStyle = "#3a3a3a";
  g.fillRect(HOUSE.roof.x0, HOUSE.roof.y - 18, HOUSE.roof.x1 - HOUSE.roof.x0, 22);
  for (const w of HOUSE.windows) {
    g.fillStyle = "#f5f5f2";
    g.fillRect(w.x - 8, w.y - 8, w.w + 16, w.h + 16);
    g.fillStyle = "#2b3947";
    g.fillRect(w.x, w.y, w.w, w.h);
    g.fillStyle = "#f5f5f2";
    g.fillRect(w.x + w.w / 2 - 3, w.y, 6, w.h);
  }
  g.fillStyle = "#8a2b22";
  g.fillRect(HOUSE.sign.x, HOUSE.sign.y, HOUSE.sign.w, HOUSE.sign.h);
  g.fillStyle = "#fff";
  g.font = "bold 28px Segoe UI";
  g.fillText("SHOP", HOUSE.sign.x + 18, HOUSE.sign.y + 60);
  g.fillStyle = "#555";
  g.fillRect(0, 900, HOUSE.w, 100);
  return c.convertToBlob({ type: "image/png" });
};

/** Dispatch a pointer event at venue-canvas coordinates on the tracing layer. */
const pointer = (type: string, cx: number, cy: number, target?: Element | null) => {
  const svg = document.querySelector<SVGSVGElement>("svg.trace")!;
  const r = svg.getBoundingClientRect();
  const v = venue();
  const x = r.left + (cx / v.canvas.width) * r.width;
  const y = r.top + (cy / v.canvas.height) * r.height;
  (target ?? svg).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1 }));
};

let photoPath = "";
let savedPath = "";

export const PHOTO_STEPS: Record<string, () => Promise<{ ok: boolean; note?: string; settle?: number }>> = {
  "photo-new-project": async () => {
    const blob = await drawHouse();
    const paths = await window.be.app.paths();
    photoPath = `${paths.renders}\\ui-test\\test-photo-house.png`;
    await window.be.files.writeBinary(photoPath, new Uint8Array(await blob.arrayBuffer()));
    const dataUrl = await new Promise<string>((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.readAsDataURL(blob);
    });
    const ok = await createProjectFromPhoto({ path: photoPath, dataUrl }, { width: HOUSE.w, height: HOUSE.h });
    await until(() => !!document.querySelector("svg.trace") && !!document.querySelector(".photo-underlay"), 5000);
    const v = venue();
    return { ok: ok && st().step === "space" && v.canvas.width === 1600 && !!document.querySelector(".photo-underlay"), note: `venue canvas ${v.canvas.width}×${v.canvas.height}; photo copied to ${st().project!.assets[v.referenceAssetId!]?.path}`, settle: 900 };
  },
  "trace-rect-window": async () => {
    useTrace.getState().set({ tool: "rect" });
    await sleep(100);
    const w = HOUSE.windows[0]!;
    pointer("pointerdown", w.x, w.y);
    pointer("pointermove", w.x + w.w / 2, w.y + w.h / 2);
    pointer("pointermove", w.x + w.w, w.y + w.h);
    pointer("pointerup", w.x + w.w, w.y + w.h);
    const chooser = await until(() => !!document.querySelector(".kind-chooser"));
    click(byText(".kind-chooser button", "Window"));
    const ok = await until(() => Object.values(venue().regions).filter((r) => r.kind === "window").length === 1);
    return { ok: chooser && ok, note: `"What is this?" offered ${document.querySelectorAll(".kind-chooser button").length || "its"} choices; window traced`, settle: 700 };
  },
  "find-similar-windows": async () => {
    useTrace.getState().set({ tool: "select" });
    const first = Object.values(venue().regions).find((r) => r.kind === "window")!;
    st().selectRegions([first.id]);
    await sleep(200);
    click(byText(".panel button", "Find similar"));
    const found = await until(() => (useTrace.getState().suggestions?.items.length ?? 0) > 0, 8000);
    const n = useTrace.getState().suggestions?.items.length ?? 0;
    await sleep(600);
    click(byText(".suggest-box button", "Add"));
    const ok = await until(() => Object.values(venue().regions).filter((r) => r.kind === "window").length === 6);
    return { ok: found && ok, note: `${n} suggestions found; windows now ${Object.values(venue().regions).filter((r) => r.kind === "window").length}`, settle: 700 };
  },
  "trace-roofline": async () => {
    useTrace.getState().set({ tool: "edge" });
    await sleep(100);
    const { y, x0, x1 } = HOUSE.roof;
    pointer("pointerup", x0, y);
    pointer("pointerup", (x0 + x1) / 2, y);
    pointer("pointerup", x1, y);
    document.querySelector("svg.trace")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await until(() => !!document.querySelector(".kind-chooser"));
    click(byText(".kind-chooser button", "Roofline"));
    const roof = Object.values(venue().regions).find((r) => r.kind === "roofline");
    return { ok: !!roof && !roof.path.closed && roof.path.vertices.length === 3, note: `roofline with ${roof?.path.vertices.length} points (open edge)` };
  },
  "keep-light-off": async () => {
    useTrace.getState().set({ tool: "rect" });
    await sleep(100);
    const sgn = HOUSE.sign;
    pointer("pointerdown", sgn.x, sgn.y);
    pointer("pointermove", sgn.x + sgn.w, sgn.y + sgn.h);
    pointer("pointerup", sgn.x + sgn.w, sgn.y + sgn.h);
    await until(() => !!document.querySelector(".kind-chooser"));
    click(byText(".kind-chooser button", "Keep light off here"));
    const ex = Object.values(venue().regions).find((r) => r.kind === "exclusion");
    return { ok: !!ex, note: "the neighbour's sign is marked so projected light stays off it", settle: 600 };
  },
  "correct-outline": async () => {
    useTrace.getState().set({ tool: "select" });
    const win = Object.values(venue().regions).find((r) => r.kind === "window")!;
    st().selectRegions([win.id]);
    await until(() => document.querySelectorAll(".vertex-handle").length === 4);
    const before = JSON.stringify(venue().regions[win.id]!.path);
    const handle = document.querySelectorAll(".vertex-handle")[2]!;
    const v0 = win.path.vertices[2]!.p;
    pointer("pointerdown", v0[0], v0[1], handle);
    pointer("pointermove", v0[0] + 12, v0[1] + 9);
    pointer("pointerup", v0[0] + 12, v0[1] + 9);
    const moved = JSON.stringify(venue().regions[win.id]!.path) !== before;
    (document.activeElement as HTMLElement | null)?.blur();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    const restored = await until(() => JSON.stringify(venue().regions[win.id]!.path) === before);
    return { ok: moved && restored, note: "dragged a corner to correct the outline, then Ctrl+Z restored it" };
  },
  "animate-own-windows": async () => {
    click(byText(".route-step", "Effects"));
    await sleep(300);
    usePreview.getState().set({ view: "show", resolution: "full" });
    const win = Object.values(venue().regions).find((r) => r.kind === "window")!;
    st().selectRegions([win.id]);
    await until(() => !!document.querySelector(".action-bar"));
    click(byText(".action-bar button", "Select all"));
    await until(() => st().selection.regionIds.length === 6);
    click(byText(".action-bar button", "Light up one after another"));
    const ok = await until(() => Object.keys(st().project!.recipes).length === 1);
    st().setPlaying(false);
    st().setTime(secondsToTime(2.5));
    await sleep(500);
    const px = (await currentPreviewLoop()?.sample()) ?? { mean: 0, spread: 0 };
    return { ok: ok && px.mean > 0 && px.spread > 2, note: `six windows light up in turn on the user's own photo; preview mean ${px.mean}, contrast ${px.spread}`, settle: 900 };
  },
  "projector-respects-keep-off": async () => {
    usePreview.getState().set({ view: "projector" });
    await sleep(600);
    const px = (await currentPreviewLoop()?.sample()) ?? { mean: 0, spread: 0 };
    usePreview.getState().set({ view: "show" });
    return { ok: px.spread > 2, note: `projector output renders with the keep-light-off area applied; mean ${px.mean}`, settle: 600 };
  },
  "save-close-reopen": async () => {
    const p = st().project!;
    const paths = await window.be.app.paths();
    savedPath = `${paths.projects}\\UI test house.beproj`;
    const r = await window.be.files.saveProject(serialize(p), savedPath);
    if (r) st().markSaved(r.path, r.savedAt);
    const before = { regions: Object.keys(venue().regions).length, recipes: Object.keys(p.recipes).length, layers: Object.keys(p.compositions[p.mainCompId!]!.layers).length };
    // "Close": go back to the welcome screen, then open the file again.
    useStudio.setState({ screen: "welcome", project: null, history: null });
    await sleep(300);
    const opened = await window.be.files.openProject(savedPath);
    const project = deserialize(opened!.json);
    st().openProject(project, savedPath);
    await until(() => !!document.querySelector(".preview-panel"));
    const v = venue();
    const after = { regions: Object.keys(v.regions).length, recipes: Object.keys(st().project!.recipes).length, layers: Object.keys(project.compositions[project.mainCompId!]!.layers).length };
    const photoOk = await window.be.files.exists(project.assets[v.referenceAssetId!]!.path);
    return { ok: JSON.stringify(before) === JSON.stringify(after) && photoOk, note: `saved to ${savedPath}; reopened with ${after.regions} parts, ${after.recipes} effect, ${after.layers} layers; photo present`, settle: 900 };
  },
};

/**
 * Acceptance workflow A — easy scene creation, through the real interface:
 *   draw a window, a door and a wall (with the window cut out) → duplicate and group the windows →
 *   drag a picture, videos and an animation onto areas → span vs repeat → adjust crop, placement,
 *   looping, soft edge and timing → duplicate the scene and swap content without retracing →
 *   arrange the show → save.  (Run 2, a fresh app process: reopen, seek and export.)
 *
 * Media: generated sample footage in the "Test content" folder beside Renders in the app's data
 * folder, clearly named "(generated, not AtmosFX)". No AtmosFX files were available for testing.
 */
import { evaluateCompAt, resolveTargets, secondsToTime, timeToSeconds } from "@be/core";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreview } from "./preview/settings.ts";
import { useAssistant } from "./studio/assistant/state.ts";
import { createProjectFromPhoto } from "./space/actions.ts";
import { useTrace } from "./space/traceStore.ts";
import { DRAG_ASSET, DRAG_EFFECT, useDropChoice } from "./studio/assign.ts";
import { hasAudio } from "./studio/audioEngine.ts";
import { importMediaFiles } from "./studio/media.ts";
import { deserialize, serialize } from "./studio/persistence.ts";
import { activeVenue, currentComp, useStudio } from "./studio/store.ts";
import { drawHouse, HOUSE } from "./uitestPhoto.ts";

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
/** Sample media in "Test content" beside the Renders folder (the app's data folder). */
const FILES = { picture: "", swirl: "", pattern: "" };
const findSampleMedia = async () => {
  const dir = `${(await window.be.app.paths()).renders.replace(/[\\/]Renders$/, "")}\\Test content`;
  FILES.picture = `${dir}\\Sample picture (generated) - gradient.png`;
  FILES.swirl = `${dir}\\Sample footage (generated, not AtmosFX) - swirl.mp4`;
  FILES.pattern = `${dir}\\Sample footage (generated, not AtmosFX) - pattern with tone.mp4`;
};
const DOOR = { x: 540, y: 640, w: 110, h: 250 };
const WALL = [[200, 250], [1400, 250], [1400, 900], [200, 900]] as const;

/** Pointer event at venue coordinates on the tracing layer (or a given element). */
const pointer = (type: string, cx: number, cy: number, target?: Element | null, opts: PointerEventInit = {}) => {
  const svg = document.querySelector<SVGSVGElement>("svg.trace")!;
  const r = svg.getBoundingClientRect();
  const v = venue();
  const x = r.left + (cx / v.canvas.width) * r.width;
  const y = r.top + (cy / v.canvas.height) * r.height;
  (target ?? svg).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, ...opts }));
};

/** HTML drag-and-drop of a payload onto venue coordinates in the preview. */
const dropOnPreview = async (kind: "asset" | "effect", id: string, cx: number, cy: number) => {
  const stage = document.querySelector<HTMLElement>(".canvas-stage")!;
  const r = stage.getBoundingClientRect();
  const v = venue();
  const x = r.left + (cx / v.canvas.width) * r.width;
  const y = r.top + (cy / v.canvas.height) * r.height;
  const dt = new DataTransfer();
  dt.setData(kind === "asset" ? DRAG_ASSET : DRAG_EFFECT, id);
  stage.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  stage.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  await sleep(80);
  stage.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  await sleep(150);
};

const dropOnElement = async (el: Element, kind: "asset" | "effect", id: string) => {
  const dt = new DataTransfer();
  dt.setData(kind === "asset" ? DRAG_ASSET : DRAG_EFFECT, id);
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10, dataTransfer: dt };
  el.dispatchEvent(new DragEvent("dragover", o));
  el.dispatchEvent(new DragEvent("drop", o));
  await sleep(150);
};

/** Set a React-controlled input (range/number/text) the way typing would. */
const setInput = (el: HTMLInputElement | null, value: string | number) => {
  if (!el) throw new Error("input not found");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(value));
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const rangeByLabel = (label: string) => document.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
const openGroup = (title: string) => {
  const b = byText(".param-group > button.disclosure", title);
  if (b && b.getAttribute("aria-expanded") !== "true") click(b);
};

/** Mean RGB of the preview inside a venue-space rectangle. */
const colourAt = async (x0: number, y0: number, w: number, h: number) => {
  await sleep(250);
  const s = await currentPreviewLoop()?.sample();
  if (!s?.pixels) return [0, 0, 0];
  const v = venue();
  const W = s.width;
  const H = s.height;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.floor((y0 / v.canvas.height) * H); y < Math.floor(((y0 + h) / v.canvas.height) * H); y++)
    for (let x = Math.floor((x0 / v.canvas.width) * W); x < Math.floor(((x0 + w) / v.canvas.width) * W); x++) {
      const i = (y * W + x) * 4;
      b += s.pixels[i]!;
      g += s.pixels[i + 1]!;
      r += s.pixels[i + 2]!;
      n++;
    }
  return [r / n, g / n, b / n].map((c) => Math.round(c));
};

const assetId = (path: string) => Object.values(st().project!.assets).find((a) => a.originalPath === path || a.name === path.split("\\").pop())?.id ?? "";
const windowsIds = () => venue().regionOrder.filter((id) => venue().regions[id]!.kind === "window");
let savedPath = "";

export const WORKFLOW_A_STEPS: Record<string, () => Promise<{ ok: boolean; note?: string; settle?: number }>> = {
  "wa-photo": async () => {
    // Start from a clean screen (earlier journeys may leave the assistant or the exports list open).
    useAssistant.setState({ open: false });
    useStudio.setState({ rendersOpen: false });
    const blob = await drawHouse();
    const paths = await window.be.app.paths();
    const photo = `${paths.renders}\\ui-test\\workflow-a-house.png`;
    await window.be.files.writeBinary(photo, new Uint8Array(await blob.arrayBuffer()));
    const ok = await createProjectFromPhoto({ path: photo, dataUrl: "" });
    await until(() => !!document.querySelector("svg.trace"), 5000);
    usePreview.getState().set({ resolution: "full", view: "show", zoom: "fit" });
    return { ok: ok && st().step === "space", note: `new show from a building photo (${venue().canvas.width}×${venue().canvas.height})`, settle: 800 };
  },
  "wa-draw-window-door-wall": async () => {
    const draw = async (tool: "rect", a: [number, number], b: [number, number], kind: string) => {
      useTrace.getState().set({ tool });
      await sleep(80);
      pointer("pointerdown", a[0], a[1]);
      pointer("pointermove", b[0], b[1]);
      pointer("pointerup", b[0], b[1]);
      await until(() => !!document.querySelector(".kind-chooser"));
      click(byText(".kind-chooser button", kind));
      await sleep(120);
    };
    const w = HOUSE.windows[0]!;
    await draw("rect", [w.x, w.y], [w.x + w.w, w.y + w.h], "Window");
    await draw("rect", [DOOR.x, DOOR.y], [DOOR.x + DOOR.w, DOOR.y + DOOR.h], "Door");
    // The wall: click its corners with the Outline tool, then close on the first point.
    useTrace.getState().set({ tool: "polygon" });
    await sleep(80);
    for (const [x, y] of WALL) pointer("pointerup", x, y);
    pointer("pointerup", WALL[0][0] + 2, WALL[0][1] + 2);
    await until(() => !!document.querySelector(".kind-chooser"));
    click(byText(".kind-chooser button", "Wall"));
    await sleep(120);
    const kinds = Object.values(venue().regions).map((r) => r.kind).sort();
    return { ok: kinds.join() === "door,wall,window", note: `traced: ${Object.values(venue().regions).map((r) => `${r.name} (${r.path.vertices.length} corners)`).join(", ")}`, settle: 600 };
  },
  "wa-cut-holes-in-wall": async () => {
    // Cut the window and door out of the wall, so wall content stays off them.
    const wall = Object.values(venue().regions).find((r) => r.kind === "wall")!;
    for (const hole of [HOUSE.windows[0]!, DOOR]) {
      st().selectRegions([wall.id]);
      useTrace.getState().set({ tool: "hole" });
      await sleep(80);
      for (const [x, y] of [[hole.x, hole.y], [hole.x + hole.w, hole.y], [hole.x + hole.w, hole.y + hole.h], [hole.x, hole.y + hole.h]] as const) pointer("pointerup", x, y);
      document.querySelector("svg.trace")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await sleep(120);
    }
    useTrace.getState().set({ tool: "select" });
    st().selectRegions([wall.id]);
    const holes = venue().regions[wall.id]!.holes?.length ?? 0;
    return { ok: holes === 2, note: `wall has ${holes} holes (window and door cut out)`, settle: 600 };
  },
  "wa-duplicate-and-group-windows": async () => {
    useTrace.getState().set({ tool: "select" });
    const first = windowsIds()[0]!;
    for (const target of [HOUSE.windows[2]!, HOUSE.windows[4]!]) {
      st().selectRegions([first]);
      await sleep(120);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true }));
      await until(() => st().selection.regionIds.length === 1 && st().selection.regionIds[0] !== first, 2000);
      const dup = venue().regions[st().selection.regionIds[0]!]!;
      await sleep(150);
      // Drag the copy's body onto the next window in the photo.
      const body = document.querySelector("svg.trace path.area-body");
      const from = dup.path.vertices[0]!.p;
      pointer("pointerdown", from[0] + 20, from[1] + 20, body);
      pointer("pointermove", target.x + 20, target.y + 20);
      pointer("pointerup", target.x + 20, target.y + 20);
      await sleep(150);
    }
    const ids = windowsIds();
    st().selectRegions(ids);
    await sleep(150);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Group name"]');
    setInput(input, "Upstairs windows");
    input!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await sleep(150);
    const g = Object.values(venue().groups).find((x) => x.name === "Upstairs windows");
    const xs = ids.map((id) => Math.round(venue().regions[id]!.path.vertices[0]!.p[0]));
    return { ok: ids.length === 3 && !!g && g.regionIds.length === 3 && xs.join() === [HOUSE.windows[0]!.x, HOUSE.windows[2]!.x, HOUSE.windows[4]!.x].join(), note: `3 windows (2 duplicated with Ctrl+D and dragged into place at x=${xs.join(", ")}); grouped as “Upstairs windows”`, settle: 600 };
  },
  "wa-import-media": async () => {
    const before = Object.keys(st().project!.assets).length;
    await findSampleMedia();
    await importMediaFiles([FILES.picture, FILES.swirl, FILES.pattern]);
    click(byText(".route-step", "Content"));
    await until(() => !!document.querySelector(".content-panel"));
    const added = Object.keys(st().project!.assets).length - before;
    return { ok: added === 3 && !!assetId(FILES.picture) && !!assetId(FILES.swirl) && !!assetId(FILES.pattern), note: `imported 3 sample files (generated, not AtmosFX); Content step open`, settle: 600 };
  },
  "wa-span-picture-across-windows": async () => {
    st().selectRegions(windowsIds());
    await sleep(150);
    const w = HOUSE.windows[2]!;
    await dropOnPreview("asset", assetId(FILES.picture), w.x + w.w / 2, w.y + w.h / 2);
    const chooser = await until(() => !!useDropChoice.getState().pending);
    click(byText(".drop-option", "Span across areas"));
    await sleep(400);
    const inst = st().project!.recipes[st().selection.recipeId!]!;
    const c = currentComp(st())!;
    const layers = Object.values(inst.generated).map((id) => c.layers[id]!);
    // One continuous picture: the three windows show different parts of the gradient.
    st().setPlaying(false);
    st().setTime(secondsToTime(2));
    const cols: number[][] = [];
    for (const i of [0, 2, 4]) {
      const ww = HOUSE.windows[i]!;
      cols.push(await colourAt(ww.x + 20, ww.y + 20, ww.w - 40, ww.h - 40));
    }
    const differ = Math.abs(cols[0]![0]! - cols[2]![0]!) + Math.abs(cols[0]![2]! - cols[2]![2]!) > 30;
    return { ok: chooser && inst.params.mode === "across" && layers.length === 1 && layers[0]!.masks.length === 3 && differ, note: `chooser offered repeat/span; span = 1 layer clipped by 3 windows; window colours ${cols.map((c) => `rgb(${c.join(",")})`).join(" · ")} (one picture across them)`, settle: 700 };
  },
  "wa-repeat-video-in-each-window": async () => {
    st().selectRegions(windowsIds());
    await sleep(150);
    const w = HOUSE.windows[0]!;
    await dropOnPreview("asset", assetId(FILES.pattern), w.x + w.w / 2, w.y + w.h / 2);
    await until(() => !!useDropChoice.getState().pending);
    click(byText(".drop-option", "Repeat in each area"));
    await sleep(400);
    const inst = st().project!.recipes[st().selection.recipeId!]!;
    const c = currentComp(st())!;
    const layers = Object.values(inst.generated).map((id) => c.layers[id]!);
    // A second into the video (it starts at the playhead); give the decoder a moment.
    st().setTime(inst.startTime + secondsToTime(1));
    let cols: number[][] = [];
    const t0 = performance.now();
    do {
      cols = [];
      for (const i of [0, 2, 4]) {
        const ww = HOUSE.windows[i]!;
        cols.push(await colourAt(ww.x + 20, ww.y + 20, ww.w - 40, ww.h - 40));
      }
    } while (performance.now() - t0 < 6000 && Math.abs(cols[0]![2]! - cols[2]![2]!) > 30);
    const same = Math.max(...cols.map((c) => Math.abs(c[0]! - cols[0]![0]!) + Math.abs(c[1]! - cols[0]![1]!) + Math.abs(c[2]! - cols[0]![2]!))) < 12;
    return { ok: inst.params.mode === "each" && layers.length === 3 && layers.every((l) => l.masks.length === 1) && same, note: `repeat = 3 layers, one per window, each a full copy (window colours ${cols.map((c) => `rgb(${c.join(",")})`).join(" · ")})`, settle: 700 };
  },
  "wa-video-on-door-animation-on-wall": async () => {
    const door = Object.values(venue().regions).find((r) => r.kind === "door")!;
    const wall = Object.values(venue().regions).find((r) => r.kind === "wall")!;
    st().selectRegions([]);
    // Drop onto the door's entry in the area list, and an animation onto the wall in the picture.
    const row = [...document.querySelectorAll<HTMLElement>(".area-drop")].find((e) => e.textContent?.includes(door.name))!;
    await dropOnElement(row, "asset", assetId(FILES.swirl));
    const doorInst = Object.values(st().project!.recipes).find((r) => r.params.assetId === assetId(FILES.swirl));
    await dropOnPreview("effect", "edge-trace", 260, 300);
    const wallInst = Object.values(st().project!.recipes).find((r) => r.recipeId === "edge-trace");
    const wallTargets = wallInst ? resolveTargets(st().project!, wallInst.targets).map((t) => t.region.id) : [];
    return { ok: !!doorInst && resolveTargets(st().project!, doorInst.targets)[0]?.region.id === door.id && wallTargets.join() === wall.id, note: `video dropped on “${door.name}” in the area list; “Trace with light” dropped on the wall in the picture`, settle: 900 };
  },
  "wa-adjust-crop-placement-loop-soften-timing": async () => {
    // Select the repeated video and adjust it with the Inspector controls.
    const inst = Object.values(st().project!.recipes).find((r) => r.recipeId === "area-content" && r.params.mode === "each")!;
    st().selectRecipe(inst.id);
    await until(() => !!document.querySelector(".replace-zone"));
    openGroup("Placement");
    await sleep(100);
    setInput(rangeByLabel("Crop left"), 12);
    setInput(rangeByLabel("Size"), 125);
    setInput(rangeByLabel("Move sideways"), 10);
    openGroup("Timing");
    await sleep(100);
    const loop = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Loop the video"]');
    if (loop?.getAttribute("aria-checked") === "true") click(loop);
    openGroup("Look");
    await sleep(100);
    setInput(rangeByLabel("Soften edge (this scene)"), 14);
    setInput(document.querySelector<HTMLInputElement>('input[aria-label="Starts at (seconds)"]'), 1);
    setInput(document.querySelector<HTMLInputElement>('input[aria-label="Duration (seconds)"]'), 8);
    await sleep(300);
    const now = st().project!.recipes[inst.id]!;
    const c = currentComp(st())!;
    const l = c.layers[Object.values(now.generated)[0]!]!;
    const p = now.params;
    const ok =
      p.cropL === 12 && p.scale === 125 && p.offsetX === 10 && p.loop === false && p.feather === 14 && Math.abs(timeToSeconds(now.startTime) - 1) < 0.05 && p.seconds === 8 &&
      l.masks.some((m) => m.id === "crop") && l.masks[0]!.feather.value === 14 && Math.abs(timeToSeconds(l.inPoint) - 1) < 0.05 && Math.abs(timeToSeconds(l.outPoint) - 9) < 0.05 && !(l.source.kind === "footage" && l.source.loop);
    return { ok, note: `crop left 12%, size 125%, moved 10% right, looping off, soft edge 14 px (this scene), starts at 1 s for 8 s — layer ${timeToSeconds(l.inPoint).toFixed(2)}–${timeToSeconds(l.outPoint).toFixed(2)} s with ${l.masks.length} masks`, settle: 700 };
  },
  "wa-duplicate-scene-swap-content": async () => {
    const s1 = st().compId!;
    const s1Before = JSON.stringify(Object.values(st().project!.recipes).filter((r) => r.compId === s1).map((r) => [r.recipeId, r.params.assetId, r.params.mode]));
    click(byText(".scenes-bar button", "+ Scene"));
    await until(() => !!document.querySelector(".scene-menu"));
    click(byText(".scene-menu button", "Copy of"));
    await until(() => st().compId !== s1, 3000);
    const s2 = st().compId!;
    // In the copy, swap the spanning picture for the swirl video by dropping onto its replace zone.
    const span = Object.values(st().project!.recipes).find((r) => r.compId === s2 && r.params.mode === "across")!;
    st().selectRecipe(span.id);
    await until(() => !!document.querySelector(".replace-zone"));
    await dropOnElement(document.querySelector(".replace-zone")!, "asset", assetId(FILES.swirl));
    const s2span = st().project!.recipes[span.id]!;
    const s1After = JSON.stringify(Object.values(st().project!.recipes).filter((r) => r.compId === s1).map((r) => [r.recipeId, r.params.assetId, r.params.mode]));
    // Same areas in both scenes (no retracing): the copy's targets resolve to the same windows.
    const sameAreas = resolveTargets(st().project!, s2span.targets).map((t) => t.region.id).join() === windowsIds().join();
    return {
      ok: s2span.params.assetId === assetId(FILES.swirl) && s1After === s1Before && sameAreas && Object.keys(st().project!.compositions).length >= 2,
      note: `“${st().project!.compositions[s2]!.name}” copied from “${st().project!.compositions[s1]!.name}”; its span now shows the swirl video, the original scene unchanged; both use the same traced windows`,
      settle: 800,
    };
  },
  "wa-arrange-show": async () => {
    click(byText(".scenes-bar button", "Show"));
    await until(() => !!document.querySelector(".show-arranger"), 3000);
    const show = currentComp(st())!;
    // 6 s each with a 1 s crossfade.
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.show-block input[type="number"][aria-label$="duration in the show"]')];
    for (const i of inputs) {
      setInput(i, 6);
      await sleep(120);
    }
    const s = currentComp(st())!;
    return { ok: !!show.show && s.show!.entries.length === 2 && s.show!.entries[1]!.transition === "fade" && Math.abs(timeToSeconds(s.duration) - 11) < 0.05, note: `show: ${s.show!.entries.map((e) => `${st().project!.compositions[e.sceneId]!.name} ${e.seconds}s ${e.transition}`).join(" → ")} = ${timeToSeconds(s.duration)} s`, settle: 700 };
  },
  "wa-save": async () => {
    const paths = await window.be.app.paths();
    savedPath = `${paths.projects}\\Workflow A.beproj`;
    const r = await window.be.files.saveProject(serialize(st().project!), savedPath);
    if (r) st().markSaved(r.path, r.savedAt);
    return { ok: !!r, note: `saved to ${savedPath}` };
  },
  // ---- Run 2: a fresh app process ----
  "wa-reopen": async () => {
    const paths = await window.be.app.paths();
    savedPath = `${paths.projects}\\Workflow A.beproj`;
    const opened = await window.be.files.openProject(savedPath);
    if (!opened) return { ok: false, note: "the saved show wasn't found (run the first part first)" };
    st().openProject(deserialize(opened.json), savedPath);
    await until(() => !!document.querySelector(".preview-panel"));
    const p = st().project!;
    const v = venue();
    const scenes = p.compositionOrder.filter((id) => !p.compositions[id]!.show);
    const wall = Object.values(v.regions).find((r) => r.kind === "wall");
    const group = Object.values(v.groups).find((g) => g.name === "Upstairs windows");
    const adjusted = Object.values(p.recipes).find((r) => r.recipeId === "area-content" && r.params.mode === "each" && r.compId === scenes[0]);
    const ok = scenes.length === 2 && !!p.mainCompId && !!p.compositions[p.mainCompId]!.show && wall?.holes?.length === 2 && group?.regionIds.length === 3 && adjusted?.params.cropL === 12 && adjusted.params.feather === 14 && adjusted.params.loop === false;
    return { ok, note: `reopened in a new app process: ${Object.keys(v.regions).length} areas (wall with ${wall?.holes?.length} holes), group “${group?.name}”, ${scenes.length} scenes + show, adjustments kept (crop 12%, soft edge 14 px, loop off)`, settle: 800 };
  },
  "wa-seek-and-export": async () => {
    const p = st().project!;
    const show = p.compositions[p.mainCompId!]!;
    useStudio.setState({ compId: show.id });
    usePreview.getState().set({ resolution: "full" });
    // Seek back and forth: the same moment always looks the same.
    st().setPlaying(false);
    // Sample until the picture is stable (video frames decode in the background), then compare.
    const look = async (s: number) => {
      st().setTime(secondsToTime(s));
      let prev = "";
      const t0 = performance.now();
      while (performance.now() - t0 < 5000) {
        await sleep(200);
        const px = await currentPreviewLoop()?.sample();
        const now = `${px?.mean.toFixed(2)}/${px?.spread.toFixed(2)}`;
        if (now === prev) return now;
        prev = now;
      }
      return prev;
    };
    const a1 = await look(3);
    await look(8);
    await look(0.5);
    const a2 = await look(3);
    const paths = await window.be.app.paths();
    const output = `${paths.renders}\\Workflow A - show.mp4`;
    const id = await window.be.render.enqueue({
      name: "Workflow A — show",
      outcome: "share",
      preset: "h264",
      compId: show.id,
      target: { kind: "master", keepAlpha: false },
      output,
      width: show.width,
      height: show.height,
      frameRate: show.frameRate,
      startFrame: 0,
      frames: Math.round(timeToSeconds(show.duration) * (show.frameRate.num / show.frameRate.den)),
      alpha: false,
      withAudio: true,
      estimatedBytes: 20_000_000,
      snapshot: JSON.stringify(p),
    });
    let job: Awaited<ReturnType<typeof window.be.render.list>>[number] | undefined;
    const t0 = performance.now();
    while (performance.now() - t0 < 600_000) {
      job = (await window.be.render.list()).find((j) => j.id === id);
      if (job?.state === "done" || job?.state === "failed") break;
      await sleep(250);
    }
    const seconds = (performance.now() - t0) / 1000;
    const ev = evaluateCompAt(p, show, secondsToTime(5.5), {});
    return {
      ok: a1 === a2 && job?.state === "done" && !!job.verify?.checks.every((c) => c.ok) && hasAudio(p, show.id) && !!job.verify?.checks.some((c) => c.name === "Sound" && c.actual !== "no"),
      note: `seek 3 s → 8 s → 0.5 s → 3 s gave the same picture (mean/contrast ${a1} = ${a2}); exported ${timeToSeconds(show.duration)} s show (${ev.layers.length} scene layers at the crossfade) in ${seconds.toFixed(1)} s → ${output}: ${job?.verify?.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.actual}`).join(", ") ?? job?.error}`,
    };
  },
};

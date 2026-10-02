/**
 * Journey steps for automatic house setup with a real house photo: the first photo in the data
 * folder's "Venue" folder (or BE_HOUSE_PHOTO). Find areas → correct an outline → remove a doubtful
 * one → split and join → accept → undo/redo. Skipped (and reported) when there's no photo.
 */
import { regionHoles, secondsToTime } from "@be/core";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreview } from "./preview/settings.ts";
import { createProjectFromPhoto } from "./space/actions.ts";
import { proposedAreas, useHouseSetup } from "./space/houseSetup.ts";
import { assignMedia } from "./studio/assign.ts";
import { getRenderer } from "./studio/engineHost.ts";
import { importMediaFiles } from "./studio/media.ts";
import { partFor, partsLayer } from "./studio/parts.ts";
import { deserialize, serialize } from "./studio/persistence.ts";
import { activeVenue, currentComp, useStudio } from "./studio/store.ts";

type Step = () => Promise<{ ok: boolean; note?: string; settle?: number }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, timeout = 5000) => {
  const t0 = performance.now();
  while (!fn()) {
    if (performance.now() - t0 > timeout) return false;
    await sleep(100);
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
const found = () => proposedAreas(venue());
const byName = (name: string) => Object.values(venue().regions).find((r) => r.name === name);
const toClient = (cx: number, cy: number) => {
  const svg = document.querySelector<SVGSVGElement>("svg.trace")!;
  const r = svg.getBoundingClientRect();
  return { clientX: r.left + (cx / venue().canvas.width) * r.width, clientY: r.top + (cy / venue().canvas.height) * r.height };
};
const pointer = (target: Element, type: string, cx: number, cy: number) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...toClient(cx, cy), pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1 }));

let skip = "";
/** The traced areas once accepted: moving parts must never change them. */
let mappingBefore = "";
let savedPath = "";
const mapping = () => JSON.stringify(Object.values(venue().regions).map((r) => [r.id, r.path, r.holes ?? [], r.cutouts ?? []]));
const centre = (name: string): [number, number] => {
  const r = byName(name)!;
  const xs = r.path.vertices.map((v) => v.p[0]), ys = r.path.vertices.map((v) => v.p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
};
/** Brightness (0-255) around canvas points in the preview at a time, once everything has loaded. */
const lumaAt = async (seconds: number, points: Array<[number, number]>) => {
  st().setPlaying(false);
  st().setTime(secondsToTime(seconds));
  const r = await getRenderer();
  let shot = await currentPreviewLoop()!.sample();
  const t0 = performance.now();
  while ((r.lastFrameIncomplete || !shot.pixels) && performance.now() - t0 < 20_000) {
    await sleep(150);
    shot = await currentPreviewLoop()!.sample();
  }
  const px = shot.pixels!;
  const k = shot.width / venue().canvas.width;
  return points.map(([cx, cy]) => {
    let sum = 0, n = 0;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const x = Math.round(cx * k) + dx, y = Math.round(cy * k) + dy;
        if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) continue;
        const i = (y * shot.width + x) * 4;
        sum += 0.0722 * px[i]! + 0.7152 * px[i + 1]! + 0.2126 * px[i + 2]!; // bgra
        n++;
      }
    return Math.round(sum / Math.max(1, n));
  });
};
const skipped = () => ({ ok: true, note: `SKIPPED: ${skip}` });

export const HOUSE_STEPS: Record<string, Step> = {
  "house-photo": async () => {
    const dir = `${(await window.be.app.paths()).renders.replace(/[\\/]Renders$/, "")}\\Venue`;
    const list = await window.be.files.findByName(dir, []).catch(() => ({}));
    void list;
    const photo = (window as unknown as { beHousePhoto?: string }).beHousePhoto;
    if (!photo) {
      skip = `no house photo (set BE_HOUSE_PHOTO or put one in ${dir})`;
      return skipped();
    }
    const ok = await createProjectFromPhoto({ path: photo, dataUrl: "" });
    await until(() => !!document.querySelector(".photo-underlay"), 8000);
    const v = venue();
    return { ok: ok && v.canvas.width === 1920 && v.canvas.height === 1080, note: `new show from ${photo.split("\\").pop()} (${st().project!.assets[v.photo!.assetId]!.meta.width}×${st().project!.assets[v.photo!.assetId]!.meta.height}) in a ${v.canvas.width}×${v.canvas.height} show`, settle: 900 };
  },
  "house-find-areas": async () => {
    if (skip) return skipped();
    const t0 = performance.now();
    click(byText(".house-setup button", "Find areas automatically"));
    await until(() => useHouseSetup.getState().phase !== "idle", 5000);
    if (useHouseSetup.getState().phase === "consent") return { ok: false, note: "the detection models aren't downloaded (the consent box is showing)" };
    const sawProgress = await until(() => !!document.querySelector(".house-setup .progress-bar"), 5000);
    await until(() => useHouseSetup.getState().phase !== "running", 180_000);
    const seconds = (performance.now() - t0) / 1000;
    const f = found();
    const kinds = new Set(f.map((r) => r.kind));
    const facade = f.find((r) => r.kind === "wall");
    const ok = useHouseSetup.getState().phase === "done" && ["garage", "door", "window", "roofline", "wall"].every((k) => kinds.has(k as never)) && (facade?.cutouts?.length ?? 0) >= 3 && sawProgress;
    return {
      ok,
      note: `found ${f.length} areas in ${seconds.toFixed(1)} s (${useHouseSetup.getState().summary?.device}): ${f.map((r) => `${r.name}${r.proposal!.uncertain ? " (check)" : ""}`).join(", ")}; facade has ${facade?.cutouts?.length ?? 0} openings cut out`,
      settle: 1200,
    };
  },
  "house-correct-outline": async () => {
    if (skip) return skipped();
    const win = found().find((r) => r.kind === "window")!;
    click(byText(".proposal-row button", win.name));
    await until(() => !!document.querySelector('rect.vertex-handle[aria-label="Corner 1"]'));
    const before = win.path.vertices[0]!.p;
    const handle = document.querySelector('rect.vertex-handle[aria-label="Corner 1"]')!;
    const svg = document.querySelector("svg.trace")!;
    pointer(handle, "pointerdown", before[0], before[1]);
    pointer(svg, "pointermove", before[0] - 4, before[1] - 3);
    pointer(svg, "pointermove", before[0] - 9, before[1] - 7);
    pointer(svg, "pointerup", before[0] - 9, before[1] - 7);
    await sleep(200);
    const after = byName(win.name)!.path.vertices[0]!.p;
    const facade = found().find((r) => r.kind === "wall")!;
    const hole = regionHoles(facade, venue()).find((h) => h.vertices.some((x) => x.p[0] === after[0] && x.p[1] === after[1]));
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1]) > 5;
    return { ok: moved && !!hole, note: `dragged a corner of “${win.name}” from (${before.map(Math.round).join(", ")}) to (${after.map(Math.round).join(", ")}); the facade's cut-out followed`, settle: 800 };
  },
  "house-remove-doubtful": async () => {
    if (skip) return skipped();
    const doubtful = found().find((r) => /decoration|may not be part/.test(r.proposal!.uncertain ?? ""));
    if (!doubtful) return { ok: true, note: "nothing flagged as doubtful to remove" };
    click(document.querySelector(`.proposal-row button[aria-label="Remove ${doubtful.name}"]`));
    const ok = await until(() => !venue().regions[doubtful.id]);
    return { ok, note: `removed “${doubtful.name}” (${doubtful.proposal!.uncertain})` };
  },
  "house-split-join": async () => {
    if (skip) return skipped();
    const win = found().find((r) => r.kind === "window")!;
    st().selectRegions([win.id]);
    await sleep(150);
    click(byText(".panel button", "Split ⇆"));
    const split = await until(() => found().filter((r) => r.kind === "window").length === 2);
    const panes = found().filter((r) => r.kind === "window");
    const facadeCuts = found().find((r) => r.kind === "wall")!.cutouts?.length ?? 0;
    st().selectRegions(panes.map((r) => r.id));
    await sleep(150);
    click(byText(".panel button", "Join 2 areas"));
    const joined = await until(() => found().filter((r) => r.kind === "window").length === 1);
    return { ok: split && joined && facadeCuts >= 4, note: `split “${win.name}” into its two panes (both cut out of the facade: ${facadeCuts} openings), then joined them again`, settle: 700 };
  },
  "house-accept": async () => {
    if (skip) return skipped();
    const n = found().length;
    click(byText(".suggest-box button", "Accept all"));
    const ok = await until(() => found().length === 0);
    const v = venue();
    const groups = Object.values(v.groups).map((g) => `${g.name} (${g.regionIds.length})`);
    const roles = st().project!.bindings[v.id]?.roles ?? {};
    return { ok: ok && !!roles.windows?.length && !!roles["garage doors"]?.length && groups.some((g) => g.startsWith("Openings")), note: `accepted ${n} areas; groups ${groups.join(", ")}; roles windows ${roles.windows?.length}, doors ${roles.doors?.length}, garage doors ${roles["garage doors"]?.length}`, settle: 900 };
  },
  "house-undo-redo": async () => {
    if (skip) return skipped();
    st().undo();
    const back = await until(() => found().length > 0);
    st().redo();
    const again = await until(() => found().length === 0);
    return { ok: back && again, note: "undo brings the proposals back for review; redo accepts them again" };
  },

  "house-animate-door": async () => {
    if (skip) return skipped();
    mappingBefore = mapping();
    st().setTime(0);
    st().selectRegions([byName("Front door")!.id]);
    await until(() => !!byText(".make-move button", "Swing open"));
    click(byText(".make-move button", "Swing open"));
    const ok = await until(() => !!partFor(partsLayer(currentComp(st()))?.scene, byName("Front door")!.id));
    const found = partsLayer(currentComp(st()))!;
    const part = partFor(found.scene, byName("Front door")!.id)!;
    const m = part.part!.motion;
    return {
      ok: ok && mapping() === mappingBefore && !!found.layer.masks.find((x) => x.id === "contain"),
      note: `"House parts (3D)" layer added (clipped to the house outline); the front door swings ${m.kind === "swing" ? `${m.direction} on its ${m.hinge} hinge` : m.kind}, ${part.part!.timing.start}-${part.part!.timing.start + part.part!.timing.move} s; traced areas unchanged`,
      settle: 900,
    };
  },
  "house-animate-window": async () => {
    if (skip) return skipped();
    st().setTime(0);
    st().selectRegions([byName("Window")!.id]);
    await until(() => !!byText(".make-move button", "Swing open"));
    click(byText(".make-move button", "Swing open"));
    const ok = await until(() => !!partFor(partsLayer(currentComp(st()))?.scene, byName("Window")!.id));
    const scene = partsLayer(currentComp(st()))!.scene;
    const stills = scene.objectOrder.filter((id) => scene.objects[id]!.name.endsWith("(still)")).map((id) => scene.objects[id]!.name);
    return { ok: ok && mapping() === mappingBefore && stills.length >= 1, note: `the window swings out; still in place: ${stills.join(", ")}; traced areas unchanged`, settle: 900 };
  },
  "house-parts-move": async () => {
    if (skip) return skipped();
    usePreview.getState().set({ view: "show" });
    const pts: Array<[number, number]> = [centre("Front door"), centre("Window"), centre("Garage door"), [5, 5]];
    const rest = await lumaAt(0.2, pts);
    const open = await lumaAt(2.2, pts);
    const back = await lumaAt(6, pts);
    // At rest the door shows its photo; open, its opening is the dark recess; outside the house nothing is lit.
    const ok = rest[0]! > 60 && open[0]! < rest[0]! * 0.35 && Math.abs(back[0]! - rest[0]!) < 12 && rest[2]! > 60 && rest[3]! < 4 && open[3]! < 4 && mapping() === mappingBefore;
    return { ok, note: `brightness at the door / window / garage / outside: rest ${rest.join("/")}, open (2.2 s) ${open.join("/")}, closed again (6 s) ${back.join("/")}`, settle: 600 };
  },
  "house-video-on-garage": async () => {
    if (skip) return skipped();
    const dir = `${(await window.be.app.paths()).renders.replace(/[\\/]Renders$/, "")}\\Test content`;
    const [video] = await importMediaFiles([`${dir}\\Sample footage (generated, not AtmosFX) - swirl.mp4`], { quiet: true });
    if (!video) return { ok: false, note: "sample video missing" };
    st().setTime(0);
    const inst = assignMedia(video.id, [byName("Garage door")!.id], "each");
    const [garage] = await lumaAt(2.2, [centre("Garage door")]);
    return { ok: !!inst && garage! > 10 && mapping() === mappingBefore, note: `sample video on the garage door (drawn over the 3D layer): brightness there at 2.2 s ${garage}`, settle: 900 };
  },
  "house-save-reopen": async () => {
    if (skip) return skipped();
    savedPath = `${(await window.be.app.paths()).renders}\\ui-test\\House demo.beproj`;
    const saved = await window.be.files.saveProject(serialize(st().project!), savedPath);
    const opened = await window.be.files.openProject(savedPath);
    st().openProject(deserialize(opened!.json), savedPath);
    await sleep(600);
    const found = partsLayer(currentComp(st()));
    const parts = found ? found.scene.objectOrder.filter((id) => found.scene.objects[id]!.part).length : 0;
    return { ok: !!saved && parts === 2 && mapping() === mappingBefore, note: `saved and reopened: ${parts} moving parts, video and areas intact` };
  },
  "house-export": async () => {
    if (skip) return skipped();
    const p = st().project!;
    const show = p.compositions[p.mainCompId!]!;
    const fps = show.frameRate.num / show.frameRate.den;
    const output = `${(await window.be.app.paths()).renders}\\ui-test\\House demo.mp4`;
    const seconds = 8;
    const id = await window.be.render.enqueue({ name: "House demo", outcome: "share", preset: "h264", compId: show.id, target: { kind: "master", keepAlpha: false }, output, width: show.width, height: show.height, frameRate: show.frameRate, startFrame: 0, frames: Math.round(fps * seconds), alpha: false, withAudio: false, estimatedBytes: 20_000_000, snapshot: JSON.stringify(p) });
    let job: Awaited<ReturnType<typeof window.be.render.list>>[number] | undefined;
    const t0 = performance.now();
    while (performance.now() - t0 < 300_000) {
      job = (await window.be.render.list()).find((j) => j.id === id);
      if (job?.state === "done" || job?.state === "failed") break;
      await sleep(300);
    }
    const took = (performance.now() - t0) / 1000;
    if (job?.state !== "done") return { ok: false, note: `export ${job?.state}: ${job?.error ?? ""}` };
    const luma = async (sec: number, pt: [number, number]) => {
      const f = await window.be.media.decodeFrame(job!.result!, Math.round(sec * fps), fps, 480, show.width, show.height);
      if (!f) return -1;
      const k = f.width / show.width;
      const i = (Math.round(pt[1] * k) * f.width + Math.round(pt[0] * k)) * 4;
      return Math.round(0.2126 * f.data[i]! + 0.7152 * f.data[i + 1]! + 0.0722 * f.data[i + 2]!);
    };
    const doorRest = await luma(0.2, centre("Front door")), doorOpen = await luma(2.2, centre("Front door")), outside = await luma(2.2, [8, 8]);
    const ok = doorRest > 60 && doorOpen < doorRest * 0.4 && outside < 8 && !!job.verify?.checks.every((c) => c.ok);
    return { ok, note: `exported ${seconds} s at ${show.width}x${show.height} in ${took.toFixed(1)} s -> ${output}; door ${doorRest} at rest, ${doorOpen} open; outside the house ${outside}; ${job.verify?.checks.map((c) => `${c.ok ? "ok" : "FAILED"} ${c.name}`).join(", ")}` };
  },
};

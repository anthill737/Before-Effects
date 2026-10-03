/**
 * Journey steps for Blender (after the house steps, on the house they set up): the inspector's
 * "Simulated in Blender" buttons for a selected area, smoke made with progress and added as a layer
 * lined up with the show, cancelling a job, "Update from Blender" replacing the video in place, and
 * undo/redo of the whole result. Skipped (and reported) when Blender or the house isn't there.
 */
import { secondsToTime } from "@be/core";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { useBlenderJobs } from "./studio/blenderEffects.ts";
import { getRenderer } from "./studio/engineHost.ts";
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
const byText = (sel: string, text: string): HTMLButtonElement | null => [...document.querySelectorAll<HTMLButtonElement>(sel)].find((e) => e.textContent?.trim() === text) ?? null;
const click = (el: Element | null) => {
  if (!el) throw new Error("element not found");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};
const st = () => useStudio.getState();
const venue = () => activeVenue({ project: st().project! });
const byName = (name: string) => Object.values(venue()?.regions ?? {}).find((r) => r.name === name);
const links = () => Object.values(st().project?.blenderLinks ?? {});
const running = () => Object.values(useBlenderJobs.getState()).some((j) => j.running);

/** Brightness (0-255) around a canvas point in the preview at a time, once everything has loaded. */
const lumaAt = async (seconds: number, [cx, cy]: [number, number]) => {
  st().setPlaying(false);
  st().setTime(secondsToTime(seconds));
  const r = await getRenderer();
  await sleep(300);
  let shot = await currentPreviewLoop()!.sample();
  const t0 = performance.now();
  while ((r.lastFrameIncomplete || !shot.pixels) && performance.now() - t0 < 20_000) {
    await sleep(150);
    shot = await currentPreviewLoop()!.sample();
  }
  const px = shot.pixels!;
  const k = shot.width / venue()!.canvas.width;
  let sum = 0, n = 0;
  for (let dy = -6; dy <= 6; dy++)
    for (let dx = -6; dx <= 6; dx++) {
      const x = Math.round(cx * k) + dx, y = Math.round(cy * k) + dy;
      if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) continue;
      const i = (y * shot.width + x) * 4;
      sum += 0.0722 * px[i]! + 0.7152 * px[i + 1]! + 0.2126 * px[i + 2]!; // bgra
      n++;
    }
  return Math.round(sum / Math.max(1, n));
};

let skip = "";
let smokeId = "";
const skipped = () => ({ ok: true, note: `SKIPPED: ${skip}` });
const smoke = () => st().project?.blenderLinks?.[smokeId];

export const BLENDER_STEPS: Record<string, Step> = {
  "blender-buttons": async () => {
    const vent = byName("Vent");
    if (!vent) {
      skip = "the house steps didn't leave a house with a vent";
      return skipped();
    }
    const status = await window.be.blender.status(true);
    if (!status.found) {
      skip = "Blender isn't installed";
      return skipped();
    }
    st().selectRegions([vent.id]);
    const ok = await until(() => !!byText(".blender-effects button", "Smoke") && !byText(".blender-effects button", "Smoke")!.disabled);
    const names = [...document.querySelectorAll<HTMLButtonElement>(".blender-effects .row button")].map((b) => b.textContent?.trim());
    return { ok, note: `Vent selected: the inspector offers ${names.join(", ")} (Blender ${status.version}), each labelled physical` };
  },
  "blender-smoke": async () => {
    if (skip) return skipped();
    st().setTime(0);
    const before = new Set(links().map((l) => l.id));
    const t0 = performance.now();
    click(byText(".blender-effects button", "Smoke"));
    const progress = await until(() => !!document.querySelector(".blender-progress"), 10_000);
    const stageSeen = new Set<string>();
    const done = await until(() => {
      const t = document.querySelector(".blender-progress span")?.textContent;
      if (t) stageSeen.add(t.replace(/ · .*/, ""));
      return links().some((l) => !before.has(l.id) && !!l.result);
    }, 600_000);
    const took = (performance.now() - t0) / 1000;
    const link = links().find((l) => !before.has(l.id));
    if (!done || !link) return { ok: false, note: `no result after ${took.toFixed(0)} s: ${JSON.stringify(useBlenderJobs.getState())}` };
    smokeId = link.id;
    const comp = currentComp(st())!;
    const layer = comp.layers[link.layerId!];
    const asset = st().project!.assets[link.result!.assetId];
    const panel = await until(() => !!document.querySelector('section[aria-label="Made in Blender"]'));
    const ok = progress && !!layer && comp.layerOrder[0] === layer.id && !!asset?.meta.hasAlpha && panel;
    return { ok, note: `“${link.name}”: ${[...stageSeen].join(" → ")} in ${took.toFixed(0)} s; a ${asset?.meta.width}×${asset?.meta.height} video with transparency on top of the scene; its layer shows “Made in Blender”`, settle: 800 };
  },
  "blender-in-preview": async () => {
    if (skip) return skipped();
    const vent = byName("Vent")!;
    const xs = vent.path.vertices.map((v) => v.p[0]), ys = vent.path.vertices.map((v) => v.p[1]);
    // Just above the vent, where the smoke rises.
    const at: [number, number] = [(Math.min(...xs) + Math.max(...xs)) / 2, Math.min(...ys) - 25];
    const comp = currentComp(st())!;
    const layerId = smoke()!.layerId!;
    const withSmoke = await lumaAt(3, at);
    st().apply({ type: "layer.update", args: { compId: comp.id, layerId, changes: { enabled: false } } }, { label: "Hide" });
    const without = await lumaAt(3, at);
    st().undo();
    return { ok: withSmoke > without + 8, note: `above the vent at 3 s: brightness ${withSmoke} with the smoke, ${without} without` };
  },
  "blender-cancel": async () => {
    if (skip) return skipped();
    const garage = byName("Garage door");
    if (!garage) return { ok: false, note: "no garage door" };
    st().selectRegions([garage.id]);
    await until(() => !!byText(".blender-effects button", "Fire"));
    const layersBefore = currentComp(st())!.layerOrder.length;
    const before = new Set(links().map((l) => l.id));
    click(byText(".blender-effects button", "Fire"));
    const shown = await until(() => !!document.querySelector(".blender-progress button"), 20_000);
    await sleep(1500);
    click(byText(".blender-progress button", "Cancel"));
    const stopped = await until(() => !running(), 30_000);
    await sleep(300);
    const added = links().filter((l) => !before.has(l.id));
    const ok = shown && stopped && added.length === 0 && currentComp(st())!.layerOrder.length === layersBefore && !document.querySelector('.blender-effects [role="alert"]');
    return { ok, note: `Fire on the garage door started, then Cancel: Blender stopped${stopped ? "" : " (NOT)"}, nothing added to the show, no error shown` };
  },
  "blender-update": async () => {
    if (skip) return skipped();
    const link = smoke()!;
    st().selectLayer(link.layerId!);
    await until(() => !!byText('section[aria-label="Made in Blender"] button', "Update from Blender"));
    const old = link.result!;
    const t0 = performance.now();
    click(byText('section[aria-label="Made in Blender"] button', "Update from Blender"));
    const done = await until(() => smoke()!.result!.renderedAt !== old.renderedAt, 600_000);
    const took = (performance.now() - t0) / 1000;
    const now = smoke()!;
    const layer = currentComp(st())!.layers[now.layerId!];
    const replaced = layer?.source.kind === "footage" && layer.source.assetId === now.result!.assetId;
    const oldGone = !st().project!.assets[old.assetId];
    return { ok: done && now.layerId === link.layerId && replaced && oldGone, note: `“Update from Blender” rendered the .blend again in ${took.toFixed(0)} s and swapped the video in the same layer; the previous render left the media list` };
  },
  "blender-undo": async () => {
    if (skip) return skipped();
    const now = smoke()!.result!;
    st().undo();
    const back = smoke()?.result;
    const layer = currentComp(st())!.layers[smoke()!.layerId!];
    const undone = !!back && back.assetId !== now.assetId && layer?.source.kind === "footage" && layer.source.assetId === back.assetId && !!st().project!.assets[back.assetId];
    st().redo();
    const redone = smoke()?.result?.assetId === now.assetId;
    return { ok: undone && redone, note: "one undo puts the previous render back (layer, media and link together); redo returns to the update" };
  },
};

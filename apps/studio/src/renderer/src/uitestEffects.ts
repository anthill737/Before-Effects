/**
 * Journey steps for effect settings (after the house steps): every setting of an animation can be
 * adjusted in the inspector. Particles (kind, areas, amount), Melt (its effect settings with ◆),
 * a light effect's newer settings and its areas, explode/crumble presets, and the Blender settings
 * panel (when a Blender layer exists). Skipped when the house isn't there.
 */
import { FLICKS_PER_SECOND } from "@be/core";
import { applyEffect } from "./studio/actions.ts";
import { activeVenue, currentComp, useStudio } from "./studio/store.ts";

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
/** Move a range input the way a person does (React sees an input event). */
const slide = (el: HTMLInputElement | null, value: number) => {
  if (!el) throw new Error("slider not found");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(value));
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const st = () => useStudio.getState();
const venue = () => activeVenue({ project: st().project! });
const byName = (name: string) => Object.values(venue()?.regions ?? {}).find((r) => r.name === name);
const comp = () => currentComp(st())!;
const topLayer = () => comp().layers[comp().layerOrder[0]!]!;
const sceneOf = (layerId: string) => {
  const l = comp().layers[layerId];
  return l?.source.kind === "scene3d" ? st().project!.scenes3d?.[l.source.sceneId] : undefined;
};
const card = (title: string) => [...document.querySelectorAll<HTMLElement>(".anim-card")].find((c) => c.textContent?.startsWith(title)) ?? null;

let skip = "";
const skipped = () => ({ ok: true, note: `SKIPPED: ${skip}` });

export const EFFECT_STEPS: Record<string, Step> = {
  "fx-particles": async () => {
    const garage = byName("Garage door"), win = byName("Window");
    if (!garage || !win) {
      skip = "no house with a garage door and a window";
      return skipped();
    }
    useStudio.setState({ step: "content" });
    st().setTime(0);
    st().selectRegions([garage.id]);
    await until(() => !!card("Sparks"));
    click(card("Sparks"));
    const made = await until(() => topLayer().name.startsWith("Sparks"));
    const layerId = topLayer().id;
    useStudio.setState({ step: "animate" });
    st().selectLayer(layerId);
    await until(() => !!document.querySelector('section[aria-label="Edit Sparks"], .object-editor'));
    // Change the amount, then what they are and where they come from.
    await until(() => !!document.querySelector('input[type="range"][aria-label="Amount"]'));
    slide(document.querySelector<HTMLInputElement>('input[type="range"][aria-label="Amount"]'), 500);
    const obj = () => Object.values(sceneOf(layerId)!.objects)[0]!;
    const amount = await until(() => obj().particles?.rate === 500);
    const sel = document.querySelector<HTMLSelectElement>('.object-editor select[aria-label="Particles"]');
    if (sel) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "embers");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const kind = await until(() => obj().particles?.kind === "embers");
    click(byText(".area-picker button", "Window"));
    const areas = await until(() => (obj().particles?.from?.regionIds ?? []).includes(win.id));
    return { ok: made && amount && kind && areas, note: `Sparks added on the garage door; amount set to 500/s, switched to embers, and the window added as a source — all from the inspector`, settle: 600 };
  },
  "fx-melt": async () => {
    if (skip) return skipped();
    useStudio.setState({ step: "content" });
    st().setTime(0);
    st().selectRegions([byName("Window")!.id]);
    await until(() => !!card("Melt"));
    click(card("Melt"));
    const made = await until(() => topLayer().name.startsWith("Melt"));
    const layer = topLayer();
    useStudio.setState({ step: "animate" });
    st().selectLayer(layer.id);
    const shown = await until(() => !!document.querySelector('input[type="range"][aria-label="Melt Slides down up to"]'));
    slide(document.querySelector<HTMLInputElement>('input[type="range"][aria-label="Melt Slides down up to"]'), 500);
    const e = () => comp().layers[layer.id]!.effects.find((x) => x.type === "melt")!;
    const distance = await until(() => e().params["distance"]!.value === 500);
    const keyed = (e().params["amount"]!.keyframes?.length ?? 0) === 2;
    // Add a blur too, from the same section.
    click(byText(".layer-effects button", "+ Blur"));
    const blur = await until(() => comp().layers[layer.id]!.effects.some((x) => x.type === "gaussian-blur"));
    const checks = { made, shown, distance, keyed, blur };
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    return { ok: failed.length === 0, note: `Melt on the window: its picture with a Melt effect ("Melted" animated 0→1, 2 keyframes); "Slides down up to" changed to 500 px and a Blur added in the layer's Effects section${failed.length ? ` — FAILED: ${failed.join(", ")} (distance now ${e().params["distance"]?.value})` : ""}`, settle: 600 };
  },
  "fx-recipe-settings": async () => {
    if (skip) return skipped();
    useStudio.setState({ step: "animate" });
    st().setTime(0);
    st().selectRegions([byName("Window")!.id]);
    const id = await applyEffect("pulse");
    if (!id) return { ok: false, note: "Pulse wasn't applied" };
    st().selectRecipe(id);
    await until(() => !!document.querySelector(".area-picker"));
    click(byText(".area-picker button", "Front door"));
    const inst = () => st().project!.recipes[id]!;
    const areas = await until(() => JSON.stringify(inst().targets).includes(byName("Front door")!.id));
    const more = byText("button.disclosure", "More controls");
    if (more) click(more);
    await until(() => !!document.querySelector('input[type="range"][aria-label="Glow size"]'));
    slide(document.querySelector<HTMLInputElement>('input[type="range"][aria-label="Glow size"]'), 250);
    const glow = await until(() => inst().params["glowSize"] === 250);
    const radius = Object.values(inst().generated).map((lid) => comp().layers[lid]!).flatMap((l) => l.effects).find((x) => x.type === "glow")?.params["radius"]?.value;
    return { ok: areas && glow && typeof radius === "number" && radius > 0, note: `Pulse on the window, front door added from the area chips; "Glow size" 250% gives a glow radius of ${Number(radius).toFixed(1)} px` };
  },
  "fx-break-presets": async () => {
    if (skip) return skipped();
    useStudio.setState({ step: "content" });
    st().setTime(0);
    st().selectRegions([byName("Garage door")!.id]);
    await until(() => !!card("Crumble (3D)"));
    click(card("Crumble (3D)"));
    const made = await until(() => topLayer().source.kind === "scene3d" && Object.values(sceneOf(topLayer().id)!.objects).some((o) => !!o.fracture?.stagger));
    const fr = Object.values(sceneOf(topLayer().id)!.objects).find((o) => o.fracture)!.fracture!;
    useStudio.setState({ step: "animate" });
    st().selectLayer(topLayer().id);
    const shown = await until(() => !!document.querySelector('input[type="range"][aria-label="Lets go over"]'));
    return { ok: made && shown && fr.rebuildAt === null, note: `Crumble (3D) on the garage door: real Rapier pieces letting go over ${fr.stagger} s from the top; its settings (incl. "Lets go over") are in the 3D panel`, settle: 600 };
  },
  "fx-blender-settings": async () => {
    if (skip) return skipped();
    const link = Object.values(st().project?.blenderLinks ?? {}).find((l) => l.effect && l.layerId && comp().layers[l.layerId]);
    if (!link) return { ok: true, note: "SKIPPED: no Blender layer in this scene (run the blender-* steps first)" };
    useStudio.setState({ step: "animate" });
    st().selectLayer(link.layerId!);
    await until(() => !!document.querySelector('[aria-label="Blender settings"]'));
    const sliders = document.querySelectorAll('[aria-label="Blender settings"] input[type="range"]').length;
    const again = byText('[aria-label="Blender settings"] button', "Simulate again") as HTMLButtonElement | null;
    const before = !!again?.disabled;
    slide(document.querySelector<HTMLInputElement>('[aria-label="Blender settings"] input[type="range"]'), 2);
    const enabled = await until(() => !(byText('[aria-label="Blender settings"] button', "Simulate again") as HTMLButtonElement | null)?.disabled);
    click(byText('[aria-label="Blender settings"] button', "Undo changes"));
    const lasts = link.seconds * FLICKS_PER_SECOND > 0;
    return { ok: before && enabled && sliders >= 4 && lasts, note: `“${link.name}”: ${sliders} Blender settings shown; changing one lights up “Simulate again” (not run here)` };
  },
};

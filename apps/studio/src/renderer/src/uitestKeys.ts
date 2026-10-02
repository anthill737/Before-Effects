/**
 * Journey steps for keyframes on an ordinary layer: ◆ to start animating opacity, change the value
 * later to add a second keyframe, see both diamonds on the layer's bar, pick an easing from the
 * diamond's menu, then open the custom curve and shape it.
 */
import { evalProp, FLICKS_PER_SECOND, keyCurve, keyEase, secondsToTime } from "@be/core";
import { addAssetLayer, importMediaFiles } from "./studio/media.ts";
import { currentComp, useStudio } from "./studio/store.ts";

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
/** Move a range input the way a person does (React sees an input event). */
const slide = (el: HTMLInputElement | null, value: number) => {
  if (!el) throw new Error("slider not found");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(value));
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const st = () => useStudio.getState();
let layerId = "";
const layer = () => currentComp(st())!.layers[layerId]!;
const diamonds = () => [...document.querySelectorAll<HTMLElement>(".key-diamond")].filter((d) => d.getAttribute("aria-label")?.startsWith(`${layer().name} opacity keyframe`));
const openMenu = (d: HTMLElement) => {
  const r = d.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1 };
  d.dispatchEvent(new PointerEvent("pointerdown", o));
  d.dispatchEvent(new PointerEvent("pointerup", o));
};

export const KEY_STEPS: Record<string, Step> = {
  "keys-layer": async () => {
    const dir = `${(await window.be.app.paths()).renders.replace(/[\\/]Renders$/, "")}\\Test content`;
    const [pic] = await importMediaFiles([`${dir}\\Sample picture (generated) - gradient.png`], { quiet: true });
    if (!pic) return { ok: false, note: "sample picture missing" };
    st().setTime(0);
    layerId = addAssetLayer(pic, 0) ?? "";
    st().selectLayer(layerId);
    const ok = await until(() => !!document.querySelector('button[aria-label="Add a opacity keyframe at the playhead"]'));
    return { ok, note: `picture layer “${layer().name}” selected; its inspector offers ◆ on opacity, size, position and turn` };
  },
  "keys-add": async () => {
    st().setPlaying(false);
    st().setTime(0);
    await sleep(100);
    click(document.querySelector('button[aria-label="Add a opacity keyframe at the playhead"]'));
    await until(() => (layer().transform.opacity.keyframes?.length ?? 0) === 1);
    st().setTime(secondsToTime(2));
    await sleep(150);
    slide(document.querySelector<HTMLInputElement>('input[type="range"][aria-label="Opacity"]'), 20);
    const two = await until(() => (layer().transform.opacity.keyframes?.length ?? 0) === 2);
    const shown = await until(() => diamonds().length === 2);
    const k = layer().transform.opacity.keyframes!;
    return { ok: two && shown && k[0]!.v === 100 && k[1]!.v === 20, note: `◆ at 0 s, then opacity 20% at 2 s added a second keyframe; ${diamonds().length} diamonds on the layer's bar`, settle: 600 };
  },
  "keys-ease": async () => {
    openMenu(diamonds()[0]!);
    await until(() => !!document.querySelector(".key-menu"));
    click(byText(".key-menu button", "Steady"));
    const p = () => layer().transform.opacity;
    const ok = await until(() => keyEase(p(), p().keyframes![0]!.id) === "linear");
    const mid = evalProp(p(), FLICKS_PER_SECOND);
    return { ok: ok && Math.abs((mid as number) - 60) < 0.5, note: `“Steady” from the diamond's menu: halfway (1 s) is ${(mid as number).toFixed(1)}% (linear)` };
  },
  "keys-curve": async () => {
    openMenu(diamonds()[0]!);
    await until(() => !!document.querySelector(".key-menu"));
    click(byText(".key-menu button", "Custom curve"));
    await until(() => !!document.querySelector('.custom-curve input[aria-label="Slow leaving"]'));
    slide(document.querySelector<HTMLInputElement>('.custom-curve input[type="range"][aria-label="Slow leaving"]'), 80);
    const p = () => layer().transform.opacity;
    const ok = await until(() => Math.abs(keyCurve(p(), p().keyframes![0]!.id).leave - 0.8) < 0.01);
    const early = evalProp(p(), FLICKS_PER_SECOND / 2) as number;
    const picture = !!document.querySelector(".custom-curve .curve-picture");
    click(byText(".key-menu button", "Close"));
    // Slow leaving: a quarter of the way in, it has barely started to fade.
    return { ok: ok && picture && early > 85, note: `custom curve: slow leaving 80% (with a picture of the curve); at 0.5 s opacity is still ${early.toFixed(1)}%`, settle: 500 };
  },
};

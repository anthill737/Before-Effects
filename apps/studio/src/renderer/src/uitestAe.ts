/**
 * After Effects import journey: open a real .aep (no After Effects needed), read the
 * compatibility report, start working; then open the exporter's JSON with its media found next to
 * the file (relinking), and check text and media came across.
 */
import { evaluateCompAt, secondsToTime } from "@be/core";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { openAfterEffectsProject, useAeImport } from "./studio/aeImport.ts";
import { findMissingInFolder, missingAssets } from "./studio/relink.ts";
import { currentComp, useStudio } from "./studio/store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, timeout = 5000) => {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
};
const repo = () => (window as unknown as { beRepo?: string }).beRepo ?? "";
const st = () => useStudio.getState();

export const AE_STEPS: Record<string, () => Promise<{ ok: boolean; note?: string; settle?: number }>> = {
  "ae-open-aep": async () => {
    if (!repo()) return { ok: true, note: "skipped (sample projects are only available in the development build)" };
    const ok = await openAfterEffectsProject(`${repo()}\\packages\\aep\\test\\fixtures\\versions\\ae2026\\complete.aep`);
    const a = useAeImport.getState();
    const shown = await until(() => !!document.querySelector("dialog.ae-import[open] .ae-counts"));
    const counts = a.report?.counts;
    return {
      ok: ok && a.phase === "done" && shown && counts?.compositions === 6 && counts.layers === 33,
      note: `report: ${JSON.stringify(counts)}; ${a.report?.notes.length} notes listed by kind; opened “${currentComp(st())?.name}”`,
      settle: 500,
    };
  },
  "ae-report-and-original-kept": async () => {
    if (!repo()) return { ok: true, note: "skipped" };
    const a = useAeImport.getState();
    const reportOk = !!a.reportPath && (await window.be.files.exists(a.reportPath));
    const copyOk = !!a.keptCopy && (await window.be.files.exists(a.keptCopy));
    const text = reportOk ? new TextDecoder().decode(await window.be.files.readFile(a.reportPath!)) : "";
    (document.querySelector("dialog.ae-import button.primary") as HTMLButtonElement | null)?.click();
    await until(() => !document.querySelector("dialog.ae-import[open]"));
    // The imported show plays: evaluate and draw a moment with the keyframed and expression layers.
    const comp = currentComp(st())!;
    st().setTime(secondsToTime(2));
    const ev = evaluateCompAt(st().project!, comp, secondsToTime(2), {});
    await sleep(300);
    const px = await currentPreviewLoop()?.sample();
    return {
      ok: reportOk && copyOk && /compared with After Effects frame by frame/.test(text) && /drawn with approximations/.test(text) && ev.layers.length > 0 && (px?.mean ?? 0) > 0,
      note: `report saved (${text.split("\n").length} lines) and the original .aep kept at ${a.keptCopy}; ${ev.layers.length} layers active at 2 s; preview mean ${px?.mean}`,
      settle: 400,
    };
  },
  "ae-find-missing-files": async () => {
    if (!repo()) return { ok: true, note: "skipped" };
    const paths = await window.be.app.paths();
    const dir = `${paths.renders}\\ui-test\\ae-media`;
    // Two of the three missing files are somewhere in a folder tree (as after copying a project).
    const video = `${paths.renders}\\milestone-a\\master-h264.mp4`;
    const wav = `${paths.renders}\\ui-test\\click-120bpm.wav`;
    if (!(await window.be.files.exists(video)) || !(await window.be.files.exists(wav))) return { ok: true, note: "skipped (test media not present)" };
    await window.be.files.writeBinary(`${dir}\\footage\\clips\\mov_480.mov`, await window.be.files.readFile(video));
    await window.be.files.writeBinary(`${dir}\\audio\\wav.wav`, await window.be.files.readFile(wav));
    const before = missingAssets().length;
    const r = await findMissingInFolder(dir);
    const p = st().project!;
    const mov = Object.values(p.assets).find((a) => a.name === "mov_480.mov");
    const snd = Object.values(p.assets).find((a) => a.name === "wav.wav");
    return {
      ok: before === 3 && r?.found === 2 && missingAssets().length === 1 && !!mov && !mov.missing && !!snd && !snd.missing && !!snd.audioPath,
      note: `missing before: ${before}; searched a folder tree and found ${r?.found} of ${r?.total} (mov_480.mov, wav.wav); still missing: ${missingAssets().map((a) => a.name).join(", ")}`,
    };
  },
  "ae-open-exporter-json-relinks-media": async () => {
    if (!repo()) return { ok: true, note: "skipped" };
    const paths = await window.be.app.paths();
    const dir = `${paths.renders}\\ui-test\\ae-export`;
    const json = await window.be.files.readFile(`${repo()}\\tools\\ae-exporter\\test\\fixtures\\complete-ae2026.json`);
    await window.be.files.writeBinary(`${dir}\\complete.beforeeffects.json`, json);
    // The project's media path (C:\Footage\…) doesn't exist here; put the file next to the export instead.
    const video = `${paths.renders}\\milestone-a\\master-h264.mp4`;
    const haveVideo = await window.be.files.exists(video);
    if (haveVideo) await window.be.files.writeBinary(`${dir}\\mov_480.mov`, await window.be.files.readFile(video));
    const ok = await openAfterEffectsProject(`${dir}\\complete.beforeeffects.json`);
    const a = useAeImport.getState();
    const p = st().project!;
    const main = currentComp(st())!;
    const text = Object.values(main.layers).find((l) => l.name === "Text_Styled")?.source;
    const mov = Object.values(p.assets).find((x) => x.name === "mov_480.mov");
    (document.querySelector("dialog.ae-import button.primary") as HTMLButtonElement | null)?.click();
    return {
      ok: ok && a.report?.route === "after-effects-exporter" && text?.kind === "text" && text.doc.text === "Hello projection" && (!haveVideo || (!!mov && !mov.missing && mov.path.includes("Media"))),
      note: `text “${text?.kind === "text" ? text.doc.text : "?"}”; mov_480.mov ${mov?.missing ? "still missing" : `found next to the export and copied into the show (${mov?.path})`}; media to relink: ${a.report?.counts.mediaMissing}`,
      settle: 300,
    };
  },
};

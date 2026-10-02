/**
 * Open an After Effects project: an .aep file directly (no After Effects needed) or the JSON from
 * the Before Effects exporter script run inside After Effects. Media is found where After Effects
 * saved it or next to the project, then copied into the show like any imported media. The original
 * file is never changed; a copy and the compatibility report are kept with the show.
 */
import { type AeImportReport, type AeJsonProject, type Asset, importAeProject, secondsToTime } from "@be/core";
import { create } from "zustand";
import { readAepBytes } from "./aepReader.ts";
import { useStudio } from "./store.ts";

interface AeImportState {
  phase: "idle" | "reading" | "media" | "done" | "failed";
  fileName: string;
  detail: string;
  report: AeImportReport | null;
  keptCopy: string | null;
  reportPath: string | null;
  error: string | null;
}

export const useAeImport = create<AeImportState>(() => ({ phase: "idle", fileName: "", detail: "", report: null, keptCopy: null, reportPath: null, error: null }));

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dir = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

const LEVEL_TITLE: Record<string, string> = {
  approximated: "Approximated",
  kept: "Kept, not shown yet",
  missing: "Missing",
  "not-imported": "Not imported yet",
  exact: "Notes",
};

export const reportText = (r: AeImportReport, keptCopy: string | null): string => {
  const c = r.counts;
  const lines = [
    `After Effects import report — ${r.sourceName}`,
    `Read ${r.route === "aep-file" ? "directly from the .aep file" : "from the Before Effects exporter (run inside After Effects)"} on ${new Date().toLocaleString()}.`,
    "",
    `Compositions ${c.compositions} · Layers ${c.layers} · Keyframes ${c.keyframes} · Masks ${c.masks} · Effects ${c.effects} (${c.effectsRendered} shown now) · Expressions ${c.expressions} · Media files ${c.media} (${c.mediaMissing} to relink)`,
    `Layers: ${r.layerFidelity.drawn} drawn with nothing reported missing · ${r.layerFidelity.approximated} drawn with approximations · ${r.layerFidelity.preservedNotDrawn} kept but not drawn · ${r.layerFidelity.notImported} not imported`,
    "Reading the file isn't the same as matching After Effects: nothing here has been compared with After Effects frame by frame.",
  ];
  for (const level of ["missing", "not-imported", "kept", "approximated", "exact"]) {
    const ns = r.notes.filter((n) => n.level === level);
    if (!ns.length) continue;
    lines.push("", `${LEVEL_TITLE[level]} (${ns.length})`);
    for (const n of ns) lines.push(`  • ${n.where}: ${n.text}`);
  }
  if (keptCopy) lines.push("", `Your original file is unchanged. A copy is kept with this show: ${keptCopy}`);
  return lines.join("\r\n");
};

export const openAfterEffectsProject = async (given?: string): Promise<boolean> => {
  const file = given ?? (await window.be.files.chooseFiles("aep"))[0];
  if (!file) return false;
  const set = (s: Partial<AeImportState>) => useAeImport.setState(s);
  set({ phase: "reading", fileName: base(file), detail: "Reading the project…", report: null, keptCopy: null, reportPath: null, error: null });
  try {
    const bytes = await window.be.files.readFile(file);
    let ae: AeJsonProject;
    let route: AeImportReport["route"];
    if (/\.json$/i.test(file)) {
      ae = JSON.parse(new TextDecoder().decode(bytes)) as AeJsonProject;
      if (!Array.isArray(ae?.items)) throw new Error("This file isn't an After Effects export. Choose the .aep file, or the .beforeeffects.json made by the exporter script.");
      route = "after-effects-exporter";
    } else if (/\.aepx$/i.test(file)) {
      throw new Error("XML projects (.aepx) can't be opened yet. In After Effects, save the project as .aep, or run the Before Effects exporter script.");
    } else {
      ae = await readAepBytes(bytes);
      route = "aep-file";
    }

    // Find media where After Effects saved it, or next to the project (projects are often moved).
    set({ detail: "Finding the media…" });
    const near = dir(file);
    const byPath = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const it of ae.items) {
      if (it.itemType !== "FootageItem" || it.mainSource?.sourceType !== "FileSource") continue;
      const f = it.mainSource.file;
      const name = f ? base(f) : it.name;
      for (const c of [f, `${near}\\${name}`, `${near}\\(Footage)\\${name}`, `${near}\\Footage\\${name}`]) {
        if (c && (await window.be.files.exists(c))) {
          if (f) byPath.set(f, c);
          else byName.set(it.name, c);
          break;
        }
      }
    }
    const result = importAeProject(ae, {
      sourceName: base(file),
      route,
      resolveMedia: (p) => (byPath.has(p) ? { path: byPath.get(p)!, missing: false } : { path: p, missing: true }),
    });
    let project = result.project;

    // Copy found media into the show and read its real details (sound, frame rate, size).
    const assets: Record<string, Asset> = { ...project.assets };
    const usable = Object.values(assets).filter((a) => !a.missing || byName.has(a.name));
    let n = 0;
    for (const a of usable) {
      set({ detail: `Copying media into the show (${++n} of ${usable.length})…` });
      const src = a.missing ? byName.get(a.name)! : a.path;
      try {
        const m = await window.be.media.import(src, project.id);
        assets[a.id] = {
          ...a,
          path: m.path,
          originalPath: a.originalPath ?? src,
          ...(m.audioPath ? { audioPath: m.audioPath } : {}),
          meta: {
            ...a.meta,
            ...(m.width ? { width: m.width } : {}),
            ...(m.height ? { height: m.height } : {}),
            ...(m.frameRate ? { frameRate: m.frameRate } : {}),
            ...(m.frameCount ? { frameCount: m.frameCount } : {}),
            ...(m.durationSeconds ? { duration: secondsToTime(m.durationSeconds) } : {}),
            ...(m.hasAlpha !== undefined ? { hasAlpha: m.hasAlpha } : {}),
          },
        };
        delete (assets[a.id] as { missing?: boolean }).missing;
      } catch (e) {
        assets[a.id] = { ...a, missing: true };
        (result.report.notes as { level: string; where: string; text: string }[]).push({ level: "missing", where: `Project › ${a.name}`, text: `The file was found but couldn't be read (${String((e as Error)?.message ?? e)}).` });
      }
    }
    const stillMissing = Object.values(assets).filter((a) => a.missing).length;
    const report: AeImportReport = { ...result.report, counts: { ...result.report.counts, mediaMissing: stillMissing } };
    project = { ...project, assets };

    // Keep the original next to the show's media, untouched, with the report.
    set({ detail: "Saving the report…" });
    const keptCopy = (await window.be.files.importAsset(file, project.id)).path;
    const reportPath = `${dir(keptCopy)}\\After Effects import report.txt`;
    await window.be.files.writeBinary(reportPath, new TextEncoder().encode(reportText(report, keptCopy)));

    useStudio.getState().openProject(project, null);
    set({ phase: "done", report, keptCopy, reportPath, detail: "" });
    window.be.app.log(`after effects import: ${base(file)} (${route}) ${JSON.stringify(report.counts)}`);
    return true;
  } catch (e) {
    set({ phase: "failed", error: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), detail: "" });
    return false;
  }
};

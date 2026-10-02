/**
 * Reconnect missing media: look for the files by name in a folder (and its subfolders), or pick one
 * file; found files are copied into the show like any import and the media item points at them.
 */
import { type Asset, secondsToTime } from "@be/core";
import { useStudio } from "./store.ts";

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export const missingAssets = (): Asset[] => Object.values(useStudio.getState().project?.assets ?? {}).filter((a) => a.missing);

const relinkTo = async (a: Asset, src: string): Promise<boolean> => {
  const s = useStudio.getState();
  if (!s.project) return false;
  try {
    const m = await window.be.media.import(src, s.project.id);
    const meta = {
      ...(m.width ? { width: m.width } : {}),
      ...(m.height ? { height: m.height } : {}),
      ...(m.frameRate ? { frameRate: m.frameRate } : {}),
      ...(m.frameCount ? { frameCount: m.frameCount } : {}),
      ...(m.durationSeconds ? { duration: secondsToTime(m.durationSeconds) } : {}),
      ...(m.hasAlpha !== undefined ? { hasAlpha: m.hasAlpha } : {}),
    };
    return !!s.apply({ type: "asset.relink", args: { assetId: a.id, path: m.path, originalPath: src, ...(m.audioPath ? { audioPath: m.audioPath } : {}), meta } }, { label: `Relink ${a.name}` });
  } catch (e) {
    s.toast({ kind: "error", text: `“${base(src)}” was found but couldn't be read.`, details: String((e as Error)?.message ?? e) });
    return false;
  }
};

/** Search a folder for every missing file; returns how many were found, or null if cancelled. */
export const findMissingInFolder = async (folder?: string): Promise<{ found: number; total: number } | null> => {
  const missing = missingAssets();
  if (!missing.length) return { found: 0, total: 0 };
  const dir = folder ?? (await window.be.files.chooseFolder("Where are the missing files? Choose a folder to search"));
  if (!dir) return null;
  const names = [...new Set(missing.flatMap((a) => [base(a.originalPath ?? a.path), a.name]))];
  const hits = await window.be.files.findByName(dir, names);
  let found = 0;
  for (const a of missing) {
    const src = hits[base(a.originalPath ?? a.path)] ?? hits[a.name];
    if (src && (await relinkTo(a, src))) found++;
  }
  const s = useStudio.getState();
  s.toast({ kind: found ? "success" : "info", text: found ? `Found ${found} of ${missing.length} missing file${missing.length > 1 ? "s" : ""}.` : `None of the ${missing.length} missing files are in that folder.` });
  return { found, total: missing.length };
};

/** Pick the file for one missing media item. */
export const findOne = async (a: Asset): Promise<boolean> => {
  const [file] = await window.be.files.chooseFiles("media");
  return file ? relinkTo(a, file) : false;
};

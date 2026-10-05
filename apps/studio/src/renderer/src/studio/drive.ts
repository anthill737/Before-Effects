/**
 * Google Drive in the editor: bring media in from anywhere in Drive (each file copied to the local
 * media folder, nothing moved or copied within Drive), save and open show packages, and copy any
 * media the show still reads straight from Drive to the local media folder before it's played or
 * rendered.
 */
import type { Asset } from "@be/core";
import { driveRelative } from "../../../shared/drive.ts";
import { importMediaFiles } from "./media.ts";
import { deserialize, serialize } from "./persistence.ts";
import { useStudio } from "./store.ts";

export const plainError = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Pick pictures, video or sound anywhere in Google Drive and add them (local copies). */
export const importFromDrive = async (paths?: string[]): Promise<Asset[]> => {
  const files = paths ?? (await window.be.drive.chooseFiles("media"));
  return files.length ? importMediaFiles(files) : [];
};

/** Media the show reads straight from a file in Google Drive (from an After Effects import or an older show). */
export const driveMediaInUse = async (): Promise<Array<{ asset: Asset; rel: string }>> => {
  const p = useStudio.getState().project;
  const root = p ? (await window.be.drive.status()).myDrive : null;
  if (!p || !root) return [];
  return Object.values(p.assets).flatMap((asset) => {
    const rel = driveRelative(root, asset.path);
    return rel === null ? [] : [{ asset, rel }];
  });
};

/** Copy media the show reads from Google Drive into the local media folder and use the copies. */
export const localizeDriveMedia = async (): Promise<{ copied: string[]; failed: Array<{ name: string; error: string }> }> => {
  const copied: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const { asset, rel } of await driveMediaInUse()) {
    const s = useStudio.getState();
    try {
      const m = await window.be.media.import(asset.path, s.project!.id);
      s.apply({ type: "asset.relink", args: { assetId: asset.id, path: m.path, originalPath: asset.path, drive: m.drive ?? rel, ...(m.audioPath ? { audioPath: m.audioPath } : {}) } }, { label: `Copy “${asset.name}” from Google Drive` });
      copied.push(asset.name);
    } catch (e) {
      failed.push({ name: asset.name, error: plainError(e) });
    }
  }
  return { copied, failed };
};

/** The open show and every file it uses, as a package in Before Effects/Projects in Drive. */
export const savePackageToDrive = async (name?: string) => {
  const p = useStudio.getState().project;
  if (!p) throw new Error("There's no show open.");
  return window.be.drive.packageSave(serialize(p), name ?? p.name);
};

/** A package from Drive: its media copied to the local media folder, the show to the local projects folder, then opened. */
export const openPackageFromDrive = async (where?: string): Promise<{ project: string; files: number; bytes: number } | null> => {
  const pick = where ?? (await window.be.drive.chooseFiles("package"))[0];
  if (!pick) return null;
  // A show file opens where it is (in Drive): nothing is copied anywhere.
  if (/\.beproj$/i.test(pick)) {
    const opened = await window.be.files.openProject(pick);
    if (!opened) throw new Error(`Couldn't open ${pick}.`);
    useStudio.getState().openProject(deserialize(opened.json), opened.path);
    return { project: opened.path, files: 1, bytes: opened.json.length };
  }
  const r = await window.be.drive.packageOpen(pick);
  const opened = await window.be.files.openProject(r.project);
  if (!opened) throw new Error(`The package was copied to ${r.project} but couldn't be opened.`);
  useStudio.getState().openProject(deserialize(opened.json), opened.path);
  return r;
};

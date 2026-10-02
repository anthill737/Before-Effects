/** Save, open, autosave and recovery. Saves are atomic on disk (see main process). */
import { PROJECT_SCHEMA_VERSION, type Project } from "@be/core";
import { useStudio } from "./store.ts";

interface ProjectFile {
  readonly format: "before-effects-show";
  readonly schemaVersion: number;
  readonly savedAt: string;
  readonly project: Project;
}

export const serialize = (project: Project): string =>
  JSON.stringify({ format: "before-effects-show", schemaVersion: PROJECT_SCHEMA_VERSION, savedAt: new Date().toISOString(), project } satisfies ProjectFile);

/** Parse and migrate a saved show. Never silently drops data: unknown future versions are refused. */
export const deserialize = (json: string): Project => {
  const f = JSON.parse(json) as Partial<ProjectFile>;
  if (f.format !== "before-effects-show" || !f.project) throw new Error("This file isn't a Before Effects show.");
  if ((f.schemaVersion ?? 0) > PROJECT_SCHEMA_VERSION) throw new Error("This show was saved by a newer version of Before Effects. Update the app to open it.");
  return f.project;
};

export const saveProject = async (saveAs: boolean): Promise<void> => {
  const s = useStudio.getState();
  if (!s.project) return;
  try {
    const r = await window.be.files.saveProject(serialize(s.project), saveAs ? undefined : (s.filePath ?? undefined));
    if (!r) return;
    s.markSaved(r.path, r.savedAt);
    await window.be.files.clearAutosave();
    s.toast({ kind: "success", text: `Saved “${r.path.split(/[\\/]/).pop()}”.` });
  } catch (e) {
    s.toast({ kind: "error", text: "The show couldn't be saved. Try a different folder.", details: String(e) });
  }
};

export const openProjectFile = async (): Promise<void> => {
  const s = useStudio.getState();
  try {
    const r = await window.be.files.openProject();
    if (!r) return;
    s.openProject(deserialize(r.json), r.path);
  } catch (e) {
    s.toast({ kind: "error", text: String((e as Error).message ?? e) });
  }
};

/** Back up unsaved work every few seconds after a change; restored on the next launch after a crash. */
export const startAutosave = (): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastVersion = -1;
  const unsub = useStudio.subscribe((s) => {
    if (!s.project || !s.dirty || s.version === lastVersion) return;
    lastVersion = s.version;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const cur = useStudio.getState();
      if (cur.project) void window.be.files.autosave(serialize(cur.project)).catch(() => undefined);
    }, 2500);
  });
  return () => {
    unsub();
    if (timer) clearTimeout(timer);
  };
};

export const checkRecovery = async (): Promise<{ project: Project; savedAt: string } | null> => {
  try {
    const r = await window.be.files.recoverAutosave();
    if (!r) return null;
    return { project: deserialize(r.json), savedAt: r.savedAt };
  } catch {
    return null;
  }
};

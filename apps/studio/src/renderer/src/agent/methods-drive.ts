/**
 * Agent methods for Google Drive (through Google Drive for desktop): Before Effects' folder in My Drive
 * (by default "Before Effects", with Media, Projects and Exports), listing and bringing in media from
 * anywhere in Drive, saving files and finished exports into it, and show packages.
 *
 * Whatever comes from Drive is copied to the local data drive before it's used; caches stay local.
 * "Copied" means the whole file is in the Drive folder — Drive for desktop uploads it afterwards and
 * Before Effects can't see when Google has it, so results carry `confirmed: false` and a note.
 */
import { z } from "zod";
import { driveResolve } from "../../../shared/drive.ts";
import { driveMediaInUse, localizeDriveMedia, openPackageFromDrive, plainError, savePackageToDrive } from "../studio/drive.ts";
import { importMediaFiles } from "../studio/media.ts";
import { useStudio } from "../studio/store.ts";
import { AgentError, currentRevision, method } from "./core.ts";

const ready = async () => {
  const s = await window.be.drive.status();
  if (!s.myDrive) throw new AgentError("unavailable", s.problem ?? "Google Drive isn't available on this computer.");
  return s as typeof s & { myDrive: string };
};
/** A place in My Drive ("Effects library/Ghosts/a.mp4") or a full path inside it, as a full path. */
const full = (myDrive: string, p: string) => {
  if (/^[a-zA-Z]:[\\/]/.test(p)) return p;
  const r = driveResolve(myDrive, p);
  if (!r) throw new AgentError("invalid_params", `“${p}” isn't a place in My Drive.`);
  return r;
};
const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AgentError) throw e;
    throw new AgentError("rejected", plainError(e));
  }
};

method({
  name: "drive.status",
  summary: "Google Drive: whether Google Drive for desktop is running, where My Drive is, Before Effects' folder in it (Media, Projects, Exports), and the local cache folder (never in Drive).",
  params: z.object({}),
  run: () => window.be.drive.status(),
});

method({
  name: "drive.setFolder",
  summary:
    "Where things go in Google Drive. kind folder (default): Before Effects' folder (Media, Projects and Exports are made inside it). kind exports, projects or media: that kind's own folder instead of its subfolder. folder: a place in My Drive (\"Before Effects\", \"Shows/Exports\") or a full path inside it; null puts it back to the default.",
  params: z.object({ folder: z.string().min(1).nullable(), kind: z.enum(["folder", "exports", "projects", "media"]).optional() }),
  run: (p) => wrap(() => window.be.drive.setFolder(p.folder, p.kind)),
});

method({
  name: "drive.setMyDrive",
  summary: "Where My Drive is, when it isn't found by itself (Drive for desktop puts it at G:\\My Drive or in the home folder). null: find it again.",
  params: z.object({ path: z.string().nullable() }),
  run: (p) => wrap(() => window.be.drive.setMyDrive(p.path)),
});

method({
  name: "drive.list",
  summary: "What's in a folder in Google Drive (default Before Effects' folder): name, place in My Drive, kind, size. Any folder in My Drive can be listed; listing doesn't download anything.",
  params: z.object({
    folder: z.string().optional().describe("a place in My Drive ('Effects library/Ghosts') or a full path in it"),
    recursive: z.boolean().optional(),
    kind: z.enum(["folder", "video", "image", "audio", "project", "package", "other"]).optional(),
    max: z.number().int().min(1).max(5000).optional(),
  }),
  long: true,
  run: (p) =>
    wrap(async () => {
      const s = await ready();
      const r = await window.be.drive.list(p.folder ? full(s.myDrive, p.folder) : undefined, { ...(p.recursive ? { recursive: true } : {}), ...(p.max ? { max: p.max } : {}) });
      return { ...r, entries: p.kind ? r.entries.filter((e) => e.kind === p.kind) : r.entries };
    }),
});

method({
  name: "drive.import",
  summary: "Bring pictures, video or sound in from anywhere in Google Drive: each file is copied to the local media folder (Drive for desktop downloads it) and added to the show, remembering its place in Drive. Nothing in Drive is moved or duplicated.",
  params: z.object({ paths: z.array(z.string()).min(1).max(100).describe("places in My Drive or full paths in it") }),
  mutates: true,
  long: true,
  run: (p) =>
    wrap(async () => {
      const s = await ready();
      const added = await importMediaFiles(p.paths.map((x) => full(s.myDrive, x)), { quiet: true });
      if (!added.length) throw new AgentError("rejected", "None of those files could be brought in (missing, not downloaded, or not a picture, video or sound).");
      return { imported: added.map((a) => ({ id: a.id, name: a.name, kind: a.kind, local: a.path, drive: a.drive })), revision: currentRevision() };
    }),
});

method({
  name: "drive.fetch",
  summary: "Copy any file from Google Drive to the local cache (to read it); returns the local path.",
  params: z.object({ path: z.string().describe("a place in My Drive or a full path in it") }),
  long: true,
  run: (p) => wrap(async () => window.be.drive.fetch(full((await ready()).myDrive, p.path))),
});

method({
  name: "drive.save",
  summary: "Copy a finished local file into Before Effects' folder in Drive (to: exports, media or projects; or folder: any place in My Drive). Returns confirmed: false — Drive for desktop uploads it afterwards and Before Effects can't confirm when Google has it.",
  params: z.object({
    path: z.string().describe("the local file"),
    to: z.enum(["exports", "media", "projects"]).optional(),
    name: z.string().optional(),
    folder: z.string().optional().describe("a place in My Drive instead of Before Effects' subfolder"),
  }),
  long: true,
  run: (p) =>
    wrap(async () => {
      const s = await ready();
      if (!(await window.be.files.exists(p.path))) throw new AgentError("not_found", `No file at ${p.path}.`);
      return window.be.drive.copyInto(p.path, p.to ?? "exports", p.name, p.folder ? full(s.myDrive, p.folder) : undefined);
    }),
});

method({
  name: "drive.sendExport",
  summary: "Send a finished export (job id) to Before Effects' Exports folder in Drive (or folder). After a failure, call again: it copies the same file, never renders again. The job's delivery then says copied (confirmed: false) or failed (why).",
  params: z.object({ job: z.string(), folder: z.string().optional() }),
  long: true,
  run: (p) =>
    wrap(async () => {
      const folder = p.folder ? full((await ready()).myDrive, p.folder) : undefined;
      try {
        await window.be.deliver.copyToDrive(p.job, folder);
      } catch (e) {
        const j = (await window.be.render.list()).find((x) => x.id === p.job);
        throw new AgentError("rejected", plainError(e), { delivery: j?.delivery });
      }
      const j = (await window.be.render.list()).find((x) => x.id === p.job);
      return { job: p.job, delivery: j?.delivery };
    }),
});

method({
  name: "drive.savePackage",
  summary: "Save the open show as a package in Drive (Before Effects/Projects/<name>/): the show file, every media file it uses, and a manifest of sizes so an incomplete copy is noticed. Unchanged files aren't copied again.",
  params: z.object({ name: z.string().optional() }),
  long: true,
  run: (p) => wrap(() => savePackageToDrive(p.name)),
});

method({
  name: "drive.openPackage",
  summary: "Open a show package from Drive (its folder or package.json): checks every file has arrived, copies the media to the local media folder and the show to the local projects folder, then opens it. Refuses if the open show has unsaved changes unless discardChanges.",
  params: z.object({ path: z.string(), discardChanges: z.boolean().optional() }),
  mutates: true,
  long: true,
  run: (p) =>
    wrap(async () => {
      if (useStudio.getState().dirty && !p.discardChanges) throw new AgentError("unsaved_changes", "The open show has unsaved changes. Save it first (project.save) or pass discardChanges: true.");
      const r = await openPackageFromDrive(full((await ready()).myDrive, p.path));
      return { ...r, revision: currentRevision() };
    }),
});

method({
  name: "drive.localize",
  summary: "Media the show reads straight from Google Drive (e.g. from an After Effects import): list it (dryRun) or copy it to the local media folder and use the copies, so playback and rendering never read from Drive.",
  params: z.object({ dryRun: z.boolean().optional() }),
  mutates: true,
  long: true,
  run: (p) =>
    wrap(async () => {
      if (p.dryRun) return { inDrive: (await driveMediaInUse()).map(({ asset, rel }) => ({ id: asset.id, name: asset.name, drive: rel })) };
      return { ...(await localizeDriveMedia()), revision: currentRevision() };
    }),
});

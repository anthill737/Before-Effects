/**
 * Google Drive through Google Drive for desktop (the synced "My Drive" folder): Before Effects' own
 * folder in it (by default "My Drive/Before Effects" with Media, Projects and Exports), listing and
 * bringing in files from anywhere in Drive, sending files (finished exports, project packages, media)
 * into it, and opening packages from it.
 *
 * Everything that comes from Drive is copied to the local data drive before it's used (played,
 * rendered, opened); exports are finished locally before they're copied in. Caches, prepared frames
 * and working files stay local and are never put in Drive. Drive for desktop does the uploading and
 * downloading; Before Effects can only see that a copy reached the Drive folder, not that Google has
 * it, and says so (DRIVE_UPLOAD_NOTE).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { DriveCopy, DriveEntry, DriveStatus } from "../shared/api.ts";
import {
  DRIVE_DEFAULT_FOLDER,
  DRIVE_SUBFOLDERS,
  DRIVE_UPLOAD_NOTE,
  type DriveSubfolder,
  driveKind,
  driveFolderInput,
  driveRelative,
  driveResolve,
  myDriveCandidates,
  PACKAGE_MANIFEST,
  type PackageManifest,
  packagePlan,
  packageProblems,
  projectForPackage,
  projectFromPackage,
  repeatedFolder,
  safeFolderName,
  untangleMyDrive,
} from "../shared/drive.ts";
import { paths } from "./files.ts";
import { log } from "./log.ts";

interface DriveSettings {
  /** Before Effects' folder, relative to My Drive. */
  folder: string;
  /** Where one kind of thing goes instead of its subfolder of `folder` (places in My Drive). */
  folders?: Partial<Record<DriveSubfolder, string>>;
  /** My Drive's location when it isn't found by itself (or a stand-in folder for tests). */
  myDrive?: string;
}
const settingsFile = () => join(app.getPath("userData"), "drive.json");
const writeSettings = (s: DriveSettings) => writeFileSync(settingsFile(), JSON.stringify(s, null, 1));
const detectMyDrive = () => myDriveCandidates(homedir()).find((c) => existsSync(c)) ?? null;
const readSettings = (): DriveSettings => {
  let s: DriveSettings;
  try {
    s = { folder: DRIVE_DEFAULT_FOLDER, ...JSON.parse(readFileSync(settingsFile(), "utf8")) };
  } catch {
    return { folder: DRIVE_DEFAULT_FOLDER };
  }
  // A folder inside My Drive saved as My Drive itself put everything one level too deep: it was meant
  // as Before Effects' folder.
  const fix = untangleMyDrive(detectMyDrive(), s.myDrive);
  if (fix) {
    const { myDrive: wrong, ...rest } = s;
    s = "folder" in fix ? { ...rest, folder: fix.folder } : rest;
    writeSettings(s);
    log(`drive: ${wrong} is inside My Drive, so it's now Before Effects' folder (${s.folder}), not My Drive`);
  }
  return s;
};

/** Journey tests only: My Drive is this folder (whether or not it exists, to test an unreachable Drive). */
let testMyDrive: string | null = null;
export const setTestMyDrive = (p: string | null) => {
  testMyDrive = p;
};

/** My Drive: the chosen location if it exists, else wherever Drive for desktop put it. */
export const myDrive = (): string | null => {
  if (testMyDrive !== null) return testMyDrive;
  const s = readSettings();
  if (s.myDrive && existsSync(s.myDrive)) return s.myDrive;
  return detectMyDrive();
};

/** Is Google Drive for desktop running (or at least installed)? */
const driveApp = (): Promise<DriveStatus["app"]> =>
  new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq GoogleDriveFS.exe", "/NH"], { windowsHide: true, timeout: 8000 }, (err, out) => {
      if (!err && /GoogleDriveFS\.exe/i.test(String(out))) return resolve("running");
      resolve(existsSync("C:\\Program Files\\Google\\Drive File Stream") ? "installed" : "missing");
    });
  });

const KINDS = Object.keys(DRIVE_SUBFOLDERS) as DriveSubfolder[];
const folderPaths = (root: string, s: DriveSettings) => {
  const base = driveResolve(root, s.folder) ?? join(root, DRIVE_DEFAULT_FOLDER);
  const at = (k: DriveSubfolder) => (s.folders?.[k] ? driveResolve(root, s.folders[k]!) : null) ?? join(base, DRIVE_SUBFOLDERS[k]);
  return { base, media: at("media"), projects: at("projects"), exports: at("exports") };
};

/** Where shows are saved when Google Drive is set up (its Projects folder), or null. */
export const driveShowsFolder = (): string | null => {
  const root = myDrive();
  return root ? folderPaths(root, readSettings()).projects : null;
};

export const driveStatus = async (notice?: string): Promise<DriveStatus> => {
  const s = readSettings();
  const root = myDrive();
  const appState = await driveApp();
  if (!root)
    return {
      app: appState,
      myDrive: null,
      folder: s.folder,
      ready: false,
      problem:
        appState === "missing"
          ? "Google Drive for desktop isn't installed. Install it from google.com/drive/download and sign in; your Drive then appears as a folder Before Effects can use."
          : "Google Drive for desktop is installed but My Drive isn't showing. Open it and sign in (and, in its settings, keep My Drive streamed or mirrored).",
    };
  const f = folderPaths(root, s);
  const rel = (p: string) => driveRelative(root, p) ?? p;
  const places = { base: rel(f.base), media: rel(f.media), projects: rel(f.projects), exports: rel(f.exports) };
  const warnings = [...new Set(Object.values(places).map(repeatedFolder).filter((x): x is string => !!x))].map(
    (x) => `“My Drive/${x}” is a folder inside another folder with the same name — usually picked by mistake. Choose the outer one if so.`,
  );
  return {
    app: appState,
    myDrive: root,
    folder: s.folder,
    ready: existsSync(f.base),
    paths: f,
    places,
    custom: Object.fromEntries(KINDS.map((k) => [k, !!s.folders?.[k]])) as Record<DriveSubfolder, boolean>,
    cache: paths().cache,
    uploadNote: DRIVE_UPLOAD_NOTE,
    ...(warnings.length ? { warnings } : {}),
    ...(notice ? { notice } : {}),
  };
};

/** Where things go: Before Effects' folder (`kind` "folder"), or one kind's own folder (null: back to its subfolder). */
export const driveSetFolder = async (input: string | null, kind: "folder" | DriveSubfolder = "folder"): Promise<DriveStatus> => {
  const root = myDrive();
  if (!root) throw new Error((await driveStatus()).problem ?? "Google Drive isn't available.");
  const s = readSettings();
  if (input === null) {
    if (kind === "folder") s.folder = DRIVE_DEFAULT_FOLDER;
    else if (s.folders) delete s.folders[kind];
  } else {
    const rel = driveFolderInput(root, input);
    if (rel === null) throw new Error(`Choose a folder inside your Google Drive (My Drive is ${root}).`);
    if (kind === "folder") s.folder = rel;
    else s.folders = { ...s.folders, [kind]: rel };
  }
  writeSettings(s);
  await ensureDriveFolders().catch(() => undefined);
  return driveStatus();
};

/** Before Effects' folder and its Media, Projects and Exports folders (made if missing). */
export const ensureDriveFolders = async () => {
  const root = myDrive();
  if (!root) throw new Error((await driveStatus()).problem ?? "Google Drive isn't available.");
  const f = folderPaths(root, readSettings());
  for (const d of [f.base, f.media, f.projects, f.exports]) await mkdir(d, { recursive: true });
  return f;
};

const inDrive = (p: string): { root: string; abs: string; rel: string } => {
  const root = myDrive();
  if (!root) throw new Error("Google Drive isn't available (Google Drive for desktop isn't running or signed in).");
  const abs = /^[a-zA-Z]:[\\/]/.test(p) ? p : (driveResolve(root, p) ?? "");
  const rel = abs ? driveRelative(root, abs) : null;
  if (rel === null) throw new Error(`“${p}” isn't in your Google Drive (My Drive is ${root}).`);
  return { root, abs, rel };
};

/** What's in a folder in Drive (by default Before Effects' own), optionally its subfolders too. */
export const driveList = async (where?: string, opts: { recursive?: boolean; max?: number } = {}): Promise<{ folder: string; entries: DriveEntry[]; more: boolean }> => {
  const f = await ensureDriveFolders();
  const { root, abs } = where ? inDrive(where) : { root: myDrive()!, abs: f.base };
  const max = Math.min(5000, opts.max ?? 500);
  const out: DriveEntry[] = [];
  let more = false;
  const walk = async (dir: string, depth: number) => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) return void (more = true);
      const p = join(dir, it.name);
      const rel = driveRelative(root, p) ?? it.name;
      if (it.isDirectory()) {
        out.push({ name: it.name, path: p, rel, kind: "folder" });
        if (opts.recursive && depth < 12) await walk(p, depth + 1);
      } else {
        // Sizes and dates come from Drive's own records; reading them doesn't download the file.
        const st = await stat(p).catch(() => null);
        out.push({ name: it.name, path: p, rel, kind: driveKind(it.name), size: st?.size ?? 0, modified: st?.mtime.toISOString() ?? "" });
      }
    }
  };
  await walk(abs, 0);
  return { folder: abs, entries: out, more };
};

/** Where a file goes: Before Effects' subfolder, or `folder` (a place in My Drive) when given. */
export const driveTarget = async (src: string, to: DriveSubfolder, opts: { name?: string; folder?: string } = {}): Promise<string> => {
  const dir = opts.folder ? inDrive(opts.folder).abs : (await ensureDriveFolders())[to];
  return join(dir, opts.name ? basename(opts.name) : basename(src));
};

/** Copy a finished local file into Before Effects' folder in Drive (verified by size). */
export const driveCopyInto = async (src: string, to: DriveSubfolder, name?: string, folder?: string): Promise<DriveCopy> => {
  const target = await driveTarget(src, to, { ...(name ? { name } : {}), ...(folder ? { folder } : {}) });
  await copyVerified(src, target);
  const size = (await stat(target)).size;
  log(`drive: copied ${src} → ${target}`);
  return { target, rel: driveRelative(myDrive()!, target) ?? basename(target), size, copiedAt: new Date().toISOString(), confirmed: false, note: DRIVE_UPLOAD_NOTE };
};

export const copyVerified = async (src: string, target: string) => {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(src, target);
  const [a, b] = await Promise.all([stat(src), stat(target)]);
  if (a.size !== b.size) throw new Error(`The copy of ${basename(src)} is incomplete (${b.size} of ${a.size} bytes).`);
};

/** Bring a file from anywhere in Drive to the local data drive (Drive downloads it as it's read). */
export const driveFetch = async (p: string): Promise<{ local: string; rel: string; size: number }> => {
  const { abs, rel } = inDrive(p);
  const local = join(paths().cache, "From Google Drive", ...rel.split("/"));
  await copyVerified(abs, local);
  return { local, rel, size: (await stat(local)).size };
};

// ---- Project packages -----------------------------------------------------------------------------------

type PackedProject = { name?: string; assets: Record<string, { id: string; path: string; audioPath?: string; proxyPath?: string; sourceFile?: string }> };
type ShowFile = { project?: PackedProject } & Record<string, unknown>;

/** Already there and unchanged (same size, not older), so it needn't be copied again. */
const sameFile = async (src: string, target: string) => {
  const [a, b] = await Promise.all([stat(src), stat(target).catch(() => null)]);
  return !!b && a.size === b.size && b.mtimeMs >= a.mtimeMs - 2000;
};

/** The project (its current state) and every file it uses, into Before Effects/Projects/<name>/ in Drive. */
export const drivePackageSave = async (projectJson: string, name: string): Promise<{ folder: string; rel: string; files: number; bytes: number; note: string }> => {
  const f = await ensureDriveFolders();
  // A saved show file ({ format, project }) or a bare project.
  const file = JSON.parse(projectJson) as ShowFile;
  const project = file.project ?? (file as unknown as PackedProject);
  const title = safeFolderName(name || project.name || "Project");
  const folder = join(f.projects, title);
  const plan = packagePlan(Object.values(project.assets ?? {}), (p) => existsSync(p));
  const files: PackageManifest["files"][number][] = [];
  let bytes = 0;
  for (const [src, rel] of plan) {
    const target = join(folder, ...rel.split("/"));
    if (!(await sameFile(src, target))) await copyVerified(src, target);
    const size = (await stat(target)).size;
    files.push({ rel, size });
    bytes += size;
  }
  const projFile = `${title}.beproj`;
  const packed = JSON.stringify(file.project ? { ...file, project: projectForPackage(project, plan) } : projectForPackage(project, plan), null, 1);
  await writeFile(join(folder, projFile), packed);
  files.push({ rel: projFile, size: Buffer.byteLength(packed) });
  const manifest: PackageManifest = { kind: "before-effects-package", version: 1, name: title, project: projFile, createdAt: new Date().toISOString(), files };
  await writeFile(join(folder, PACKAGE_MANIFEST), JSON.stringify(manifest, null, 1));
  log(`drive: package ${folder} (${files.length} files, ${bytes} bytes)`);
  return { folder, rel: driveRelative(myDrive()!, folder) ?? title, files: files.length, bytes, note: DRIVE_UPLOAD_NOTE };
};

/** A package from Drive, copied to the local data drive (media) and projects folder; returns the local project file. */
export const drivePackageOpen = async (where: string): Promise<{ project: string; files: number; bytes: number }> => {
  const { abs } = inDrive(where);
  const folder = abs.toLowerCase().endsWith(PACKAGE_MANIFEST) ? dirname(abs) : abs;
  const manifest = JSON.parse(await readFile(join(folder, PACKAGE_MANIFEST), "utf8")) as PackageManifest;
  if (manifest.kind !== "before-effects-package") throw new Error("That folder isn't a Before Effects package (no package.json from Before Effects).");
  const sizes = new Map<string, number | null>();
  for (const fl of manifest.files) sizes.set(fl.rel, await stat(join(folder, ...fl.rel.split("/"))).then((s) => s.size, () => null));
  const problems = packageProblems(manifest, (rel) => sizes.get(rel) ?? null);
  if (problems.length) throw new Error(`The package isn't complete in your Drive folder yet (${problems.slice(0, 3).join("; ")}${problems.length > 3 ? "; …" : ""}). If it was just saved from another computer, wait for Google Drive to finish syncing and try again.`);
  // Media to the local data drive, the project to the local projects folder.
  const localMedia = join(paths().media, `${safeFolderName(manifest.name)} (from Google Drive)`);
  let bytes = 0;
  const localOf = new Map<string, string>();
  for (const fl of manifest.files) {
    if (fl.rel === manifest.project) continue;
    const target = join(localMedia, ...fl.rel.split("/").slice(1));
    const src = join(folder, ...fl.rel.split("/"));
    if (!(await sameFile(src, target))) await copyVerified(src, target);
    localOf.set(fl.rel, target);
    bytes += fl.size;
  }
  const file = JSON.parse(await readFile(join(folder, manifest.project), "utf8")) as ShowFile;
  const toLocal = (pr: PackedProject) => projectFromPackage(pr, (rel) => localOf.get(rel) ?? join(localMedia, basename(rel)));
  const opened = file.project ? { ...file, project: toLocal(file.project) } : toLocal(file as unknown as PackedProject);
  let out = join(paths().projects, `${safeFolderName(manifest.name)}.beproj`);
  for (let n = 2; existsSync(out); n++) out = join(paths().projects, `${safeFolderName(manifest.name)} (${n}).beproj`);
  await writeFile(out, JSON.stringify(opened, null, 1));
  log(`drive: opened package ${folder} → ${out}`);
  return { project: out, files: manifest.files.length, bytes };
};

export const registerDriveIpc = () => {
  ipcMain.handle("drive:status", () => driveStatus());
  ipcMain.handle("drive:setFolder", (_e, folder: string | null, kind?: "folder" | DriveSubfolder) => driveSetFolder(folder, kind));
  ipcMain.handle("drive:setMyDrive", async (_e, p: string | null) => {
    // A folder inside the My Drive Drive for desktop made is where things should go, not My Drive itself.
    const fix = p ? untangleMyDrive(detectMyDrive(), p) : null;
    const s = readSettings();
    delete s.myDrive;
    if (p && !fix) s.myDrive = p;
    if (fix && "folder" in fix) s.folder = fix.folder;
    writeSettings(s);
    return driveStatus(fix && "folder" in fix ? `That folder is inside My Drive, so Before Effects keeps its things there (My Drive/${fix.folder}).` : undefined);
  });
  ipcMain.handle("drive:chooseFolder", async (e, kind: "folder" | DriveSubfolder = "folder") => {
    const root = myDrive();
    if (!root) throw new Error((await driveStatus()).problem ?? "Google Drive isn't available.");
    const f = folderPaths(root, readSettings());
    const current = kind === "folder" ? f.base : f[kind];
    const what = { folder: "Before Effects' folder", exports: "the folder for finished exports", projects: "the folder for show packages", media: "the folder for media you save to Drive" }[kind];
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, {
      title: `Choose ${what} in Google Drive`,
      buttonLabel: "Use this folder",
      defaultPath: existsSync(current) ? current : root,
      properties: ["openDirectory", "createDirectory", "promptToCreate"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return driveSetFolder(r.filePaths[0], kind);
  });
  ipcMain.handle("drive:list", (_e, where?: string, opts?: { recursive?: boolean; max?: number }) => driveList(where, opts));
  ipcMain.handle("drive:copyInto", (_e, src: string, to: DriveSubfolder, name?: string, folder?: string) => driveCopyInto(src, to, name, folder));
  ipcMain.handle("drive:fetch", (_e, p: string) => driveFetch(p));
  ipcMain.handle("drive:packageSave", (_e, json: string, name: string) => drivePackageSave(json, name));
  ipcMain.handle("drive:packageOpen", (_e, where: string) => drivePackageOpen(where));
  ipcMain.handle("drive:chooseFiles", async (e, kind: "media" | "package") => {
    const root = myDrive();
    const win = BrowserWindow.fromWebContents(e.sender);
    const start = root ? folderPaths(root, readSettings())[kind === "package" ? "projects" : "media"] : undefined;
    const r = await dialog.showOpenDialog(win!, {
      title: kind === "package" ? "Open a show from Google Drive (a show file, or a package's package.json)" : "Bring in media from Google Drive",
      ...(start && existsSync(start) ? { defaultPath: start } : root ? { defaultPath: root } : {}),
      properties: kind === "package" ? ["openFile"] : ["openFile", "multiSelections"],
      filters: kind === "package" ? [{ name: "Before Effects show or package", extensions: ["beproj", "json"] }] : [{ name: "Pictures, video and sound", extensions: ["png", "jpg", "jpeg", "webp", "heic", "heif", "gif", "bmp", "tif", "tiff", "mp4", "mov", "m4v", "webm", "mkv", "avi", "wav", "mp3", "m4a", "aac", "flac", "ogg", "aiff"] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
};

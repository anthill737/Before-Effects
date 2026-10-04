/** Files, dialogs, encoding and health checks for the UI. */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { availablePresets, EncodeSession, type EncodeSpec, findFfmpegSync, MediaError, probe, type VerifyExpectation, verifyOutput } from "@be/media";
import type { AppPaths, HealthReport } from "../shared/api.ts";
import { log, logDir } from "./log.ts";
import { decodeHeif, isHeif } from "./heic.ts";
import { running } from "./processes.ts";

export const paths = (): AppPaths => {
  // Renders and caches default to the roomiest drive (D: has ~800 GB on this machine).
  const base = existsSync("D:\\") ? "D:\\Before Effects" : join(homedir(), "Documents", "Before Effects");
  const p: AppPaths = {
    renders: join(base, "Renders"),
    projects: join(homedir(), "Documents", "Before Effects", "Projects"),
    autosave: join(app.getPath("userData"), "autosave"),
    media: join(base, "Media"),
    cache: join(base, "Cache"),
    logs: logDir(),
  };
  for (const d of [p.renders, p.projects, p.autosave, p.media, p.cache]) mkdirSync(d, { recursive: true });
  return p;
};

const atomicWrite = (target: string, data: string | Uint8Array) => {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.saving`;
  writeFileSync(tmp, data);
  if (existsSync(target)) copyFileSync(target, `${target}.bak`);
  renameSync(tmp, target);
};

const sessions = new Map<string, EncodeSession>();
/** The sound each export mixed for its encoder (a working file beside the video). */
const mixes = new Map<string, string>();
let sessionCounter = 0;

/** An export's mixed sound is only needed while it encodes: remove it (and any copy kept when it was
 *  overwritten) once the video is finished or cancelled, retrying while the encoder lets go of it. */
const dropMix = (path: string | undefined, tries = 5) => {
  if (!path) return;
  try {
    for (const p of [path, `${path}.bak`]) rmSync(p, { force: true });
  } catch {
    if (tries > 0) setTimeout(() => dropMix(path, tries - 1), 1500);
  }
};

const toUserError = (e: unknown): Error => {
  if (e instanceof MediaError) return new Error(`${e.userMessage} ${e.action}`);
  return e instanceof Error ? e : new Error(String(e));
};

export const cancelAllEncodes = () => {
  for (const s of sessions.values()) s.cancel();
  sessions.clear();
};

export const health = (): HealthReport => {
  const ff = findFfmpegSync();
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    ffmpeg: ff
      ? { ok: true, path: ff.ffmpeg }
      : { ok: false, fix: "Before Effects can't find FFmpeg, so it can't read or save videos. Reinstall Before Effects, or run: winget install Gyan.FFmpeg" },
    logDir: logDir(),
    children: running(),
  };
};

export const registerFileIpc = () => {
  ipcMain.handle("encode:start", async (_e, spec: EncodeSpec) => {
    try {
      const s = await EncodeSession.start(spec);
      const id = `enc${++sessionCounter}`;
      sessions.set(id, s);
      if (spec.audioPath) mixes.set(id, spec.audioPath);
      return { id, bytesPerFrame: s.bytesPerFrame };
    } catch (e) {
      throw toUserError(e);
    }
  });
  ipcMain.handle("encode:frame", async (_e, id: string, data: Uint8Array) => {
    const s = sessions.get(id);
    if (!s) throw new Error("That export was already finished or cancelled.");
    try {
      await s.write(data);
    } catch (e) {
      throw toUserError(e);
    }
  });
  ipcMain.handle("encode:finish", async (_e, id: string) => {
    const s = sessions.get(id);
    if (!s) throw new Error("That export was already finished or cancelled.");
    sessions.delete(id);
    try {
      return await s.finish();
    } finally {
      dropMix(mixes.get(id));
      mixes.delete(id);
    }
  });
  ipcMain.handle("encode:cancel", (_e, id: string) => {
    sessions.get(id)?.cancel();
    sessions.delete(id);
    dropMix(mixes.get(id));
    mixes.delete(id);
  });

  ipcMain.handle("media:presets", () => availablePresets());
  ipcMain.handle("media:probe", (_e, path: string) => probe(path));
  ipcMain.handle("media:verify", async (_e, path: string, expect: VerifyExpectation) => verifyOutput(await probe(path), expect));

  const autosaveFile = () => join(paths().autosave, "current.beproj.json");

  ipcMain.handle("files:saveProject", async (e, json: string, path?: string) => {
    let target = path;
    if (!target) {
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showSaveDialog(win!, {
        title: "Save show",
        defaultPath: join(paths().projects, "My show.beproj"),
        filters: [{ name: "Before Effects show", extensions: ["beproj"] }],
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    atomicWrite(target, json);
    log(`saved project ${target} (${json.length} bytes)`);
    return { path: target, savedAt: new Date().toISOString() };
  });

  ipcMain.handle("files:openProject", async (e, path?: string) => {
    let target = path;
    if (!target) {
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(win!, {
        title: "Open show",
        defaultPath: paths().projects,
        filters: [{ name: "Before Effects show", extensions: ["beproj", "json"] }],
        properties: ["openFile"],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      target = r.filePaths[0];
    }
    return { path: target, json: readFileSync(target, "utf8") };
  });

  ipcMain.handle("files:autosave", (_e, json: string) => {
    atomicWrite(autosaveFile(), json);
    return { path: autosaveFile(), savedAt: new Date().toISOString() };
  });
  ipcMain.handle("files:recoverAutosave", () => {
    const f = autosaveFile();
    if (!existsSync(f)) return null;
    const json = readFileSync(f, "utf8");
    let savedAt = new Date().toISOString();
    try {
      savedAt = (JSON.parse(json) as { savedAt?: string }).savedAt ?? savedAt;
    } catch {
      return null;
    }
    return { json, savedAt };
  });
  ipcMain.handle("files:clearAutosave", () => rmSync(autosaveFile(), { force: true }));
  ipcMain.handle("files:showInFolder", (_e, path: string) => shell.showItemInFolder(path));
  ipcMain.handle("files:openPath", (_e, path: string) => shell.openPath(path));
  ipcMain.handle("files:writeText", (_e, path: string, text: string) => atomicWrite(path, text));
  ipcMain.handle("files:writeBinary", (_e, path: string, data: Uint8Array) => atomicWrite(path, data));
  ipcMain.handle("files:readFile", (_e, path: string) => new Uint8Array(readFileSync(path)));
  ipcMain.handle("files:exists", (_e, path: string) => existsSync(path));

  ipcMain.handle("files:chooseImage", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, {
      title: "Choose a photo of your building or object",
      filters: [{ name: "Photos", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "heic", "heif", "hif"] }],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    // The photo is read through importAsset (which also decodes HEIC); no need to send it inline.
    return { path: p, dataUrl: "" };
  });

  // Copy an imported file into the project's media folder; the original is never modified.
  // HEIC/HEIF photos are kept as imported and decoded to a PNG working copy beside them.
  ipcMain.handle("files:importAsset", async (_e, src: string, projectId: string) => {
    const dir = join(paths().media, projectId.replace(/[^\w.-]+/g, "_"));
    mkdirSync(dir, { recursive: true });
    const base = basename(src) || "media";
    let target = join(dir, base);
    let n = 1;
    while (existsSync(target)) {
      const dot = base.lastIndexOf(".");
      target = join(dir, dot > 0 ? `${base.slice(0, dot)} (${++n})${base.slice(dot)}` : `${base} (${++n})`);
    }
    copyFileSync(src, target);
    log(`imported ${src} → ${target}`);
    if (isHeif(target)) {
      const png = join(dirname(target), `${basename(target, extname(target))} (decoded).png`);
      const r = await decodeHeif(target, png);
      return { path: r.path, sourceFile: target, width: r.width, height: r.height, hasAlpha: r.hasAlpha, decoder: r.decoder, notes: r.notes };
    }
    return { path: target };
  });

  ipcMain.handle("files:chooseFolder", async (e, title?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, { title: title ?? "Choose a folder", properties: ["openDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  // Look for files by name in a folder and its subfolders (relinking moved media). Bounded so a
  // whole drive can't stall the app.
  ipcMain.handle("files:findByName", (_e, folder: string, names: string[]) => {
    const wanted = new Map(names.map((n) => [n.toLowerCase(), n]));
    const found: Record<string, string> = {};
    const queue: Array<{ dir: string; depth: number }> = [{ dir: folder, depth: 0 }];
    let seen = 0;
    while (queue.length && seen < 60_000 && Object.keys(found).length < wanted.size) {
      const { dir, depth } = queue.shift()!;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        seen++;
        if (e.isDirectory()) {
          if (depth < 6 && !e.name.startsWith(".") && e.name !== "node_modules") queue.push({ dir: join(dir, e.name), depth: depth + 1 });
        } else {
          const key = wanted.get(e.name.toLowerCase());
          if (key && !found[key]) found[key] = join(dir, e.name);
        }
      }
    }
    return found;
  });

  ipcMain.handle("files:chooseFiles", async (e, kind: "media" | "image" | "audio" | "aep" | "model") => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const filters = {
      media: [{ name: "Images, videos, sound and 3D models", extensions: ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "hif", "mp4", "mov", "m4v", "webm", "mkv", "avi", "mxf", "wav", "mp3", "m4a", "aac", "flac", "ogg", "glb", "gltf"] }],
      model: [{ name: "3D models (glTF)", extensions: ["glb", "gltf"] }],
      image: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "heic", "heif", "hif"] }],
      audio: [{ name: "Sound", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg"] }],
      aep: [{ name: "After Effects project or export", extensions: ["aep", "aepx", "json"] }],
    }[kind];
    const r = await dialog.showOpenDialog(win!, kind === "aep" ? { title: "Open an After Effects project", filters, properties: ["openFile"] } : { title: "Add files", filters, properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : r.filePaths;
  });
};

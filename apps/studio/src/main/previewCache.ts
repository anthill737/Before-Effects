/**
 * Preview frames on disk: the second cache tier behind each preview window's graphics memory.
 * Windows send finished frames as compact images and read them back instead of rendering again
 * (renderer/src/preview/diskCache.ts). This process owns the files:
 *
 *   - they live only under the cache root: <data folder>\Cache\preview, or a "Before Effects
 *     preview frames" folder inside a folder the person picked. Names are made safe and every path
 *     is checked to be inside the root before anything is written or deleted; files that aren't
 *     ours are never touched,
 *   - beyond the size limit the least recently used frames are deleted,
 *   - edits delete exactly the frames they change. Each composition's folder also carries a stamp
 *     (a fingerprint of the show and of this build), checked before a window first uses its
 *     frames, so frames from another session, another version of the show or an older build of
 *     the app are deleted instead of shown,
 *   - nothing is written while the drive is nearly full.
 *
 * All file work is asynchronous. What's on disk (sizes, use order) is kept in memory and rebuilt
 * from the folder the first time it's needed after start-up.
 *
 * Also here: how much memory the computer and its graphics card have, for the preview settings.
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rmdir, stat, statfs, unlink, utimes, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { app, ipcMain } from "electron";
import type { CacheSpace, DiskCacheConfig, DiskCacheScope, DiskCacheStatus, DiskCacheUsage, MachineMemory } from "../shared/api.ts";
import { type DiskEntry, DiskIndex, frameFile, frameOfKey, keyOfFile, parseRegQuery, pickGraphicsCard, scopeDir } from "../shared/diskFrames.ts";
import { paths } from "./files.ts";
import { log } from "./log.ts";

const GB = 1024 ** 3;
/** Inside a folder the person picks, frames go in a folder of their own (so clearing never touches anything else). */
const PICKED_SUBFOLDER = "Before Effects preview frames";
const STAMP = "stamp.json";
/** Writing stops while the drive has less free space than this. */
const MIN_FREE = 2 * GB;

interface Stamp {
  readonly fingerprint: string;
  readonly build: string;
}

/** This build of the app: a rebuilt app may draw frames differently, so its frames start over. */
const BUILD = (() => {
  try {
    // Frames last while what draws them is unchanged (a fingerprint of the rendering code), so an app
    // update that only changes the editor keeps a prepared show. Older builds: their build time.
    if (app.isPackaged) {
      const info = JSON.parse(readFileSync(join(process.resourcesPath, "build-info.json"), "utf8")) as { builtAt?: string; renderHash?: string };
      return info.renderHash ? `render ${info.renderHash}` : String(info.builtAt ?? app.getVersion());
    }
    return `dev ${Math.round(statSync(fileURLToPath(import.meta.url)).mtimeMs)}`;
  } catch {
    return app.getVersion();
  }
})();

let config: DiskCacheConfig = { folder: null, limitBytes: 20 * GB };
let root: string | null = null;
let index = new DiskIndex();
let ready: Promise<void> | null = null;
/** The index reflects the folder (it has been read). */
let scanned = false;
let problem = "";
/** Per composition: its stamp, or null while edits since the last stamp haven't been confirmed. */
const stamps = new Map<string, Stamp | null>();
/** Writes in progress (frame id → token); an edit or clearing removes them so a late write is dropped. */
const pending = new Map<string, number>();
let token = 0;
/** Bumped when the folder changes or everything is cleared. */
let generation = 0;
let free: { bytes: number | null; at: number } = { bytes: null, at: 0 };

let defaultRoot: string | null = null;
/**
 * The folder for a configuration. A separate profile (a second copy of the app, e.g. a build being
 * tested) keeps its frames in the profile unless a folder is picked: another build opening the same
 * show must never find, and discard, the frames of the copy in use.
 */
const rootFor = (c: DiskCacheConfig): string =>
  resolve(c.folder ? join(c.folder, PICKED_SUBFOLDER) : (defaultRoot ??= process.env.BE_PROFILE_DIR ? join(app.getPath("userData"), "Cache", "preview") : join(paths().cache, "preview")));

/** A path under the root, or null if it would be anywhere else. */
const inside = (base: string, parts: readonly string[]): string | null => {
  const p = resolve(base, ...parts);
  return p.startsWith(base + sep) ? p : null;
};

const fileOf = (e: { scope: string; key: string }): string | null => {
  const parts = frameFile(e.scope, e.key);
  return parts && root ? inside(root, parts) : null;
};

const quietly = (p: Promise<unknown>) => void p.catch(() => undefined);
const deleteFiles = (entries: readonly DiskEntry[]) => {
  for (const e of entries) {
    const f = fileOf(e);
    if (f) quietly(unlink(f));
  }
};

const id = (scope: string, key: string) => `${scope}/${key}`;

/** Stamp files are written in order per composition (an edit's "unconfirmed" must not overtake a later stamp). */
const stampWrites = new Map<string, Promise<void>>();
const writeStamp = (scope: string, s: Stamp | null) => {
  const base = root;
  const file = base ? inside(base, [...scope.split("/"), STAMP]) : null;
  if (!file) return;
  const prev = stampWrites.get(scope) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      if (s) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(s));
      } else await unlink(file);
    })
    .catch(() => undefined);
  stampWrites.set(scope, next);
};

/** Read what's already in the folder (frames, oldest-used first, and stamps). */
const scan = async (base: string, gen: number) => {
  const list = async (dir: string) => {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const found: Array<{ scope: string; key: string; bytes: number; used: number }> = [];
  for (const p of await list(base)) {
    if (!p.isDirectory()) continue;
    for (const c of await list(join(base, p.name))) {
      if (!c.isDirectory()) continue;
      const scope = `${p.name}/${c.name}`;
      const compDir = join(base, p.name, c.name);
      for (const v of await list(compDir)) {
        if (v.isFile() && v.name === STAMP) {
          try {
            const s = JSON.parse(await readFile(join(compDir, STAMP), "utf8")) as Partial<Stamp>;
            if (typeof s.fingerprint === "string" && typeof s.build === "string") stamps.set(scope, { fingerprint: s.fingerprint, build: s.build });
          } catch {
            // unreadable stamp: the frames are checked as unconfirmed
          }
          continue;
        }
        if (!v.isDirectory()) continue;
        const dir = join(compDir, v.name);
        const files = (await list(dir)).filter((f) => f.isFile());
        await Promise.all(
          files.map(async (f) => {
            // Left over from a write that didn't finish.
            if (f.name.endsWith(".saving")) return quietly(unlink(join(dir, f.name)));
            const key = keyOfFile(v.name, f.name);
            if (!key) return;
            try {
              const st = await stat(join(dir, f.name));
              found.push({ scope, key, bytes: st.size, used: st.mtimeMs });
            } catch {
              // gone meanwhile
            }
          }),
        );
      }
    }
  }
  if (gen !== generation) return;
  found.sort((a, b) => a.used - b.used);
  for (const f of found) index.add(f.scope, f.key, f.bytes);
  log(`preview disk cache: ${index.files} frames, ${Math.round(index.bytes / 1024 ** 2)} MB in ${base}`);
};

/** The index for the configured folder, read from disk the first time it's needed. */
const whenReady = (): Promise<void> => {
  const want = rootFor(config);
  if (want === root && ready) return ready;
  root = want;
  const gen = ++generation;
  index = new DiskIndex();
  stamps.clear();
  pending.clear();
  free = { bytes: null, at: 0 };
  scanned = false;
  problem = "";
  ready = (async () => {
    try {
      await mkdir(want, { recursive: true });
      await scan(want, gen);
    } catch (e) {
      if (gen === generation) problem = `The folder can't be used: ${String((e as Error)?.message ?? e)}`;
    } finally {
      if (gen === generation) scanned = true;
    }
    if (gen === generation) deleteFiles(index.evict(config.limitBytes));
  })();
  return ready;
};

const refreshFree = async (force = false) => {
  if (!root || (!force && Date.now() - free.at < 10_000)) return;
  free.at = Date.now();
  try {
    const s = await statfs(root);
    free.bytes = Number(s.bavail) * Number(s.bsize);
  } catch {
    free.bytes = null;
  }
};

const usage = (): DiskCacheUsage => ({ bytes: index.bytes, files: index.files, limitBytes: config.limitBytes });

/** `read`: also read the folder if that hasn't happened yet (only once the disk cache is in use). */
const status = async (read: boolean): Promise<DiskCacheStatus> => {
  if (read) void whenReady();
  const current = root === rootFor(config);
  if (current) await refreshFree();
  return {
    ...(current ? usage() : { bytes: 0, files: 0, limitBytes: config.limitBytes }),
    root: rootFor(config),
    freeBytes: current ? free.bytes : null,
    scanning: !(current && scanned),
    ...(problem && current ? { problem } : {}),
  };
};

/** Delete our files and stamps, then any folders left empty (anything else in them stays). */
const clearAll = async () => {
  await whenReady();
  const base = root;
  generation++;
  pending.clear();
  deleteFiles(index.clear());
  const scopes = [...stamps.keys()];
  stamps.clear();
  if (!base) return;
  for (const s of scopes) {
    const f = inside(base, [...s.split("/"), STAMP]);
    if (f) await unlink(f).catch(() => undefined);
  }
  // Remove folders bottom-up; rmdir only removes empty ones.
  const sub = async (dir: string, depth: number) => {
    if (depth > 3) return;
    let items: import("node:fs").Dirent[] = [];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of items) if (d.isDirectory()) await sub(join(dir, d.name), depth + 1);
    if (dir !== base) await rmdir(dir).catch(() => undefined);
  };
  await sub(base, 0);
  await refreshFree(true);
};

// ---- the computer's memory ------------------------------------------------------------------

const DISPLAY_ADAPTERS = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
const regQuery = (value: string) =>
  new Promise<string>((done) => execFile("reg", ["query", DISPLAY_ADAPTERS, "/s", "/v", value], { windowsHide: true, timeout: 5000 }, (_e, out) => done(String(out ?? ""))));

let machine: Promise<MachineMemory> | null = null;
const readMachine = async (): Promise<MachineMemory> => {
  let gpu: MachineMemory["gpu"] = null;
  // Windows records each graphics card's own memory with its driver settings.
  if (process.platform === "win32") {
    try {
      const [mem, legacy, names] = await Promise.all([regQuery("HardwareInformation.qwMemorySize"), regQuery("HardwareInformation.MemorySize"), regQuery("DriverDesc")]);
      gpu = pickGraphicsCard(parseRegQuery(mem), parseRegQuery(names), parseRegQuery(legacy));
    } catch {
      gpu = null;
    }
  }
  log(`machine memory: ${Math.round(totalmem() / GB)} GB; graphics card ${gpu ? `${gpu.name}, ${Math.round(gpu.bytes / GB)} GB` : "memory unknown"}`);
  return { ramBytes: totalmem(), gpu, cpuCores: cpus().length };
};

/** The drive the frames go on (the folder itself may not exist yet). */
const space = async (): Promise<CacheSpace | null> => {
  const want = rootFor(config);
  let dir = want;
  for (let i = 0; i < 12; i++) {
    try {
      const s = await statfs(dir);
      const current = root === want && scanned;
      return { drive: parse(want).root, root: want, freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize), usedBytes: current ? index.bytes : 0, files: current ? index.files : 0 };
    } catch {
      if (dirname(dir) === dir) break;
      dir = dirname(dir);
    }
  }
  return null;
};

// ---- IPC --------------------------------------------------------------------------------------

export const registerPreviewCacheIpc = () => {
  ipcMain.handle("cache:machine", () => (machine ??= readMachine()));

  ipcMain.handle("cache:configure", (_e, c: DiskCacheConfig) => {
    const folder = typeof c?.folder === "string" && isAbsolute(c.folder) ? c.folder : null;
    const limit = Number(c?.limitBytes);
    config = { folder, limitBytes: Number.isFinite(limit) ? Math.max(256 * 1024 ** 2, limit) : config.limitBytes };
    // A smaller limit applies right away to a folder already read (otherwise when it's read).
    if (ready && root === rootFor(config)) void ready.then(() => deleteFiles(index.evict(config.limitBytes)));
    return status(false);
  });

  ipcMain.handle("cache:status", () => status(true));
  ipcMain.handle("cache:space", () => space());

  // Before a window uses a composition's frames: keep them only if they were made from this exact
  // show by this build. Returns the frames on disk.
  ipcMain.handle("cache:validate", async (_e, scope: DiskCacheScope, fp: string): Promise<string[]> => {
    await whenReady();
    const s = scopeDir(scope.project, scope.comp);
    const stamp = stamps.get(s);
    if (!stamp || stamp.fingerprint !== fp || stamp.build !== BUILD) {
      deleteFiles(index.removeScope(s));
      for (const k of [...pending.keys()]) if (k.startsWith(`${s}/`)) pending.delete(k);
      const next = { fingerprint: fp, build: BUILD };
      stamps.set(s, next);
      writeStamp(s, next);
    }
    return index.keys(s);
  });

  // A newer build: what a composition's frames were made from, so the window can keep the ones it
  // still draws the same (renderer/src/preview/diskCache.ts, carry-over).
  ipcMain.handle("cache:previous", async (_e, scope: DiskCacheScope): Promise<{ fingerprint: string; build: string; current: string } | null> => {
    await whenReady();
    const stamp = stamps.get(scopeDir(scope.project, scope.comp));
    return stamp ? { fingerprint: stamp.fingerprint, build: stamp.build, current: BUILD } : null;
  });

  // Read-only: the frames on disk (projector outputs play prepared frames, never changing them).
  ipcMain.handle("cache:keys", async (_e, scope: DiskCacheScope): Promise<string[]> => {
    await whenReady();
    return index.keys(scopeDir(scope.project, scope.comp));
  });

  // Keep frames an older build made from this same show, except the ones drawn differently now.
  ipcMain.handle("cache:carryOver", async (_e, scope: DiskCacheScope, fp: string, fromBuild: string, drop: Array<[number, number]>): Promise<number> => {
    await whenReady();
    const s = scopeDir(scope.project, scope.comp);
    const stamp = stamps.get(s);
    if (!stamp || stamp.fingerprint !== fp || stamp.build !== fromBuild || fromBuild === BUILD) return 0;
    const r = drop.map(([a, b]) => [Number(a), Number(b)] as const);
    const before = index.keys(s).length;
    deleteFiles(index.removeFrames(s, r));
    for (const k of [...pending.keys()]) {
      if (!k.startsWith(`${s}/`)) continue;
      const f = frameOfKey(k.slice(s.length + 1));
      if (r.some(([a, b]) => f >= a && f < b)) pending.delete(k);
    }
    const next = { fingerprint: fp, build: BUILD };
    stamps.set(s, next);
    writeStamp(s, next);
    const kept = index.keys(s).length;
    log(`preview frames: ${s}: kept ${kept} of ${before} frames made by build ${fromBuild} (drawn the same by ${BUILD}); ${before - kept} to make again`);
    return kept;
  });

  // After edits: the frames on disk now match this version of the show.
  ipcMain.handle("cache:stamp", async (_e, scope: DiskCacheScope, fp: string) => {
    await whenReady();
    const s = scopeDir(scope.project, scope.comp);
    const next = { fingerprint: fp, build: BUILD };
    stamps.set(s, next);
    writeStamp(s, next);
  });

  // An edit changed these frames (half-open frame ranges): delete them, and mark the composition
  // unconfirmed until the window stamps the new version.
  ipcMain.handle("cache:invalidate", async (_e, scope: DiskCacheScope, ranges: Array<[number, number]>): Promise<DiskCacheUsage> => {
    await whenReady();
    const s = scopeDir(scope.project, scope.comp);
    const r = ranges.map(([a, b]) => [Number(a), Number(b)] as const);
    deleteFiles(index.removeFrames(s, r));
    for (const k of [...pending.keys()]) {
      if (!k.startsWith(`${s}/`)) continue;
      const f = frameOfKey(k.slice(s.length + 1));
      if (r.some(([a, b]) => f >= a && f < b)) pending.delete(k);
    }
    stamps.set(s, null);
    writeStamp(s, null);
    return usage();
  });

  ipcMain.handle("cache:put", async (_e, scope: DiskCacheScope, key: string, data: Uint8Array): Promise<DiskCacheUsage | null> => {
    await whenReady();
    const s = scopeDir(scope.project, scope.comp);
    const file = fileOf({ scope: s, key });
    if (!file || !(data instanceof Uint8Array) || data.byteLength === 0) return null;
    // Registered before anything else is awaited, so an edit that arrives meanwhile can cancel it.
    const fid = id(s, key);
    const mine = ++token;
    const gen = generation;
    pending.set(fid, mine);
    await refreshFree();
    if (free.bytes !== null && free.bytes - data.byteLength < MIN_FREE) {
      if (pending.get(fid) === mine) pending.delete(fid);
      return null;
    }
    const tmp = `${file}.${mine}.saving`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(tmp, data);
      await rename(tmp, file);
    } catch (e) {
      quietly(unlink(tmp));
      if (pending.get(fid) === mine) pending.delete(fid);
      if (!problem) log(`preview disk cache: couldn't save a frame: ${String((e as Error)?.message ?? e)}`);
      return null;
    }
    // Changed or cleared while it was being written: it's out of date.
    if (gen !== generation || pending.get(fid) !== mine) {
      if (gen !== generation || !pending.has(fid)) quietly(unlink(file));
      return null;
    }
    pending.delete(fid);
    if (free.bytes !== null) free.bytes -= data.byteLength;
    index.add(s, key, data.byteLength);
    deleteFiles(index.evict(config.limitBytes));
    return usage();
  });

  ipcMain.handle("cache:get", async (_e, scope: DiskCacheScope, key: string): Promise<Uint8Array | null> => {
    await whenReady();
    const s = scopeDir(scope.project, scope.comp);
    const file = index.has(s, key) ? fileOf({ scope: s, key }) : null;
    if (!file) return null;
    const gen = generation;
    try {
      const buf = await readFile(file);
      // Remember the use across sessions too (start-up orders frames by file time).
      if (gen === generation && index.touch(s, key)) {
        const now = new Date();
        quietly(utimes(file, now, now));
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      if (gen === generation) index.remove(s, key);
      return null;
    }
  });

  ipcMain.handle("cache:clear", async () => {
    await clearAll();
    return status(true);
  });
};

/**
 * Preview frames on disk — the parts with no file access, shared by the desktop process (which owns
 * the files) and the preview (which asks for frames). Unit-tested in apps/studio/test.
 *
 *   Keys      the same as the graphics-memory FrameCache: frame, render fraction and effect quality,
 *             within a show (project id) and composition.
 *   Layout    <cache root>/<show>/<composition>/<fraction>_<quality>/<frame>.jpg, plus stamp.json per
 *             composition. Names are made safe, so nothing can land outside the cache root.
 *   Size      DiskIndex keeps sizes and use order. Past the limit it hands back the least recently
 *             used frames to delete, down to 90 % of the limit so deleting happens in batches.
 */

/** The frame part of a FrameCache key (the cache puts the composition id in front). */
export const frameKey = (frame: number, fraction: number, quality: string): string => `${frame}|${fraction.toFixed(5)}|${quality}`;

const KEY = /^(\d{1,9})\|(\d{1,3}\.\d{5})\|([a-z]{1,16})$/;

/** The frame number in a frame key (NaN for anything that isn't one). */
export const frameOfKey = (key: string): number => {
  const m = KEY.exec(key);
  return m ? Number(m[1]) : Number.NaN;
};

/** A string's 53-bit hash (cyrb53) in base 36. Not cryptographic: it tells versions of a show apart. */
const hash53 = (text: string, seed = 0): string => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

/** Fingerprint of a show's contents (its JSON): two independent hashes and the length. */
export const fingerprint = (text: string): string => `${text.length.toString(36)}-${hash53(text)}-${hash53(text, 0x9e3779b9)}`;

/**
 * A file or folder name for an id that came from a show file: letters, digits, "-", "_" and "."
 * only, never "." / ".." or a name Windows reserves. Ids that had to change get a hash so two
 * different ids can't end up sharing a folder.
 */
export const safeName = (id: string): string => {
  let s = id.replace(/[^\w.-]+/g, "_").replace(/\.+$/, "_").slice(0, 64);
  if (s === "" || /^\.+$/.test(s) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = `_${s}`;
  return s === id ? s : `${s}-${hash53(id)}`;
};

/** The folder of a composition's frames, relative to the cache root ("<show>/<composition>"). */
export const scopeDir = (project: string, comp: string): string => `${safeName(project)}/${safeName(comp)}`;

/** Path parts of a frame's file under the cache root, or null when the key isn't a frame key. */
export const frameFile = (scope: string, key: string): string[] | null => {
  const m = KEY.exec(key);
  const dirs = scope.split("/");
  if (!m || dirs.length !== 2 || dirs.some((d) => d === "" || d === "." || d === "..")) return null;
  return [...dirs, `${m[2]}_${m[3]}`, `${Number(m[1])}.jpg`];
};

/** Back from a file found on disk to its frame key (null for anything that isn't a frame file). */
export const keyOfFile = (variantDir: string, file: string): string | null => {
  const v = /^(\d{1,3}\.\d{5})_([a-z]{1,16})$/.exec(variantDir);
  const f = /^(\d{1,9})\.jpg$/.exec(file);
  return v && f ? `${Number(f[1])}|${v[1]}|${v[2]}` : null;
};

export interface DiskEntry {
  readonly scope: string;
  readonly key: string;
  readonly frame: number;
  readonly bytes: number;
}

/** What's on disk: sizes and use order (in memory; rebuilt from the folder at start-up). */
export class DiskIndex {
  /** Map order is use order: least recently used first. */
  private readonly entries = new Map<string, DiskEntry>();
  private readonly scopes = new Map<string, Set<string>>();
  private total = 0;

  private static id(scope: string, key: string): string {
    return `${scope}/${key}`;
  }

  get bytes(): number {
    return this.total;
  }

  get files(): number {
    return this.entries.size;
  }

  has(scope: string, key: string): boolean {
    return this.entries.has(DiskIndex.id(scope, key));
  }

  /** Record a frame (replacing an older copy); it becomes the most recently used. */
  add(scope: string, key: string, bytes: number): void {
    const frame = frameOfKey(key);
    if (!Number.isFinite(frame)) return;
    this.remove(scope, key);
    const id = DiskIndex.id(scope, key);
    this.entries.set(id, { scope, key, frame, bytes });
    this.total += bytes;
    let set = this.scopes.get(scope);
    if (!set) this.scopes.set(scope, (set = new Set()));
    set.add(id);
  }

  /** Mark a frame as just used. False when it isn't recorded. */
  touch(scope: string, key: string): boolean {
    const id = DiskIndex.id(scope, key);
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    this.entries.set(id, e);
    return true;
  }

  remove(scope: string, key: string): DiskEntry | null {
    const id = DiskIndex.id(scope, key);
    const e = this.entries.get(id);
    if (!e) return null;
    this.entries.delete(id);
    this.total -= e.bytes;
    const set = this.scopes.get(scope);
    set?.delete(id);
    if (set && set.size === 0) this.scopes.delete(scope);
    return e;
  }

  /** Frame keys recorded for a composition. */
  keys(scope: string): string[] {
    return [...(this.scopes.get(scope) ?? [])].map((id) => this.entries.get(id)!.key);
  }

  /** Forget every frame of a composition; returns them (to delete). */
  removeScope(scope: string): DiskEntry[] {
    return this.keys(scope).map((k) => this.remove(scope, k)!);
  }

  /** Forget a composition's frames in half-open frame ranges [from, to); returns them. */
  removeFrames(scope: string, ranges: ReadonlyArray<readonly [number, number]>): DiskEntry[] {
    const out: DiskEntry[] = [];
    for (const id of [...(this.scopes.get(scope) ?? [])]) {
      const e = this.entries.get(id)!;
      if (ranges.some(([a, b]) => e.frame >= a && e.frame < b)) out.push(this.remove(scope, e.key)!);
    }
    return out;
  }

  /** Past the limit: forget the least recently used frames down to 90 % of it; returns them (to delete). */
  evict(limitBytes: number): DiskEntry[] {
    const out: DiskEntry[] = [];
    if (this.total <= limitBytes) return out;
    for (const e of [...this.entries.values()]) {
      if (this.total <= limitBytes * 0.9) break;
      out.push(this.remove(e.scope, e.key)!);
    }
    return out;
  }

  clear(): DiskEntry[] {
    const all = [...this.entries.values()];
    this.entries.clear();
    this.scopes.clear();
    this.total = 0;
    return all;
  }
}

/** Values from `reg query <key> /s /v <name>` output, by the subkey they were found in. */
export const parseRegQuery = (out: string): Map<string, string> => {
  const values = new Map<string, string>();
  let key = "";
  for (const line of out.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) key = line.trim();
    else {
      const m = /^\s+\S+\s+(REG_\w+)\s+(.*)$/.exec(line);
      if (m && key) values.set(key, `${m[1]} ${m[2]!.trim()}`);
    }
  }
  return values;
};

/** A registry number: REG_QWORD / REG_DWORD (hex) or REG_BINARY (little-endian bytes). */
const regNumber = (v: string | undefined): number => {
  const m = /^(REG_\w+) (\S+)$/.exec(v ?? "");
  if (!m) return 0;
  if (m[1] === "REG_BINARY") {
    const bytes = m[2]!.match(/../g) ?? [];
    return bytes.reduceRight((n, b) => n * 256 + parseInt(b, 16), 0);
  }
  const n = Number(m[2]);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The graphics card with the most memory of its own, from Windows' display-adapter settings
 * (on laptops with two, that's the one rendering). Null when none reports it.
 */
export const pickGraphicsCard = (memory: Map<string, string>, names: Map<string, string>, legacyMemory: Map<string, string> = new Map()): { name: string; bytes: number } | null => {
  let best: { name: string; bytes: number } | null = null;
  for (const key of new Set([...memory.keys(), ...legacyMemory.keys()])) {
    const bytes = regNumber(memory.get(key)) || regNumber(legacyMemory.get(key));
    if (bytes > (best?.bytes ?? 0)) best = { name: (names.get(key) ?? "").replace(/^REG_SZ /, "") || "Graphics card", bytes };
  }
  return best;
};

/** "512 MB", "1.5 GB", "12 GB", "1.25 GB", "640 GB". */
export const formatSize = (bytes: number): string => {
  const gb = bytes / 1024 ** 3;
  if (gb < 1) return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
  const digits = gb >= 100 ? 0 : gb >= 10 ? 1 : 2;
  return `${Number(gb.toFixed(digits))} GB`;
};

/** Preview frames on disk: keys, safe file layout, size accounting and least-recently-used eviction. */
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTag, diskKey, DiskIndex, fingerprint, formatSize, frameFile, frameKey, frameOfKey, isLegacyKey, keyOfFile, parseDiskKey, parseRegQuery, pickGraphicsCard, safeName, scopeDir, usable, usableKey } from "../src/shared/diskFrames.ts";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

describe("frame keys and file layout", () => {
  it("uses the frame cache's key and maps it to a file and back", () => {
    const key = frameKey(42, 0.5, "full");
    expect(key).toBe("42|0.50000|full");
    expect(frameOfKey(key)).toBe(42);
    const parts = frameFile(scopeDir("proj_abc", "comp_def"), key)!;
    expect(parts).toEqual(["proj_abc", "comp_def", "0.50000_full", "42.jpg"]);
    expect(keyOfFile(parts[2]!, parts[3]!)).toBe(key);
  });

  it("names a frame by what it's made from and the build that drew it, and back", () => {
    const tag = buildTag("render 31e6845873c4b4e0");
    expect(tag).toMatch(/^[0-9a-z]{4,16}$/);
    expect(buildTag("render 31e6845873c4b4e0")).toBe(tag);
    expect(buildTag("dev 1791145848738")).not.toBe(tag);
    const key = diskKey(42, 1, "full", "k3f9x2m1q8z7a0b4c6d5", tag);
    expect(isLegacyKey(key)).toBe(false);
    expect(parseDiskKey(key)).toEqual({ frame: 42, fraction: 1, quality: "full", signature: "k3f9x2m1q8z7a0b4c6d5", tag });
    expect(frameOfKey(key)).toBe(42);
    const parts = frameFile(scopeDir("proj_abc", "comp_def"), key)!;
    expect(parts).toEqual(["proj_abc", "comp_def", "1.00000_full", `42-k3f9x2m1q8z7a0b4c6d5-${tag}.jpg`]);
    expect(keyOfFile(parts[2]!, parts[3]!)).toBe(key);
    // Frames saved before signatures keep their old names and keys.
    const old = frameKey(42, 1, "full");
    expect(isLegacyKey(old)).toBe(true);
    expect(parseDiskKey(old)).toEqual({ frame: 42, fraction: 1, quality: "full" });
    expect(keyOfFile("1.00000_full", "42.jpg")).toBe(old);
    // Two versions of a frame are two files.
    const other = diskKey(42, 1, "full", "zzzz9x2m1q8z7a0b4c6d", tag);
    expect(frameFile("a/b", other)).not.toEqual(frameFile("a/b", key));
  });

  it("ignores anything that isn't a frame file", () => {
    expect(keyOfFile("0.50000_full", "42.jpg.7.saving")).toBeNull();
    expect(keyOfFile("0.50000_full", "notes.txt")).toBeNull();
    expect(keyOfFile("whatever", "42.jpg")).toBeNull();
    expect(keyOfFile("0.50000_full", "42-ab-cd.jpg")).toBeNull();
    expect(keyOfFile("0.50000_full", "42-../x-tag1.jpg")).toBeNull();
    expect(frameFile("a/b", "42|1.00000|full|../../x|tag1")).toBeNull();
    expect(frameFile("a/b", "not a key")).toBeNull();
    expect(frameOfKey("x|y|z")).toBeNaN();
  });

  it("never lets an id from a show file escape the cache folder", () => {
    for (const evil of ["..", ".", "../../Windows", "a/../../b", "C:\\Windows\\System32", "", "CON", "nul.txt", "x."]) {
      const name = safeName(evil);
      expect(name).toMatch(/^[\w.-]+$/);
      expect(name).not.toMatch(/^\.+$/);
      expect(name).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i);
      expect(name.endsWith(".")).toBe(false);
      const parts = frameFile(scopeDir(evil, evil), frameKey(1, 1, "full"))!;
      const p = posix.normalize(posix.join("/root", ...parts));
      expect(p.startsWith("/root/")).toBe(true);
      expect(parts).toHaveLength(4);
    }
    // Ordinary ids are kept as they are; ids that had to change can't collide.
    expect(safeName("comp_lq3x9k0001abcdefg")).toBe("comp_lq3x9k0001abcdefg");
    expect(safeName("a/b")).not.toBe(safeName("a_b"));
    expect(frameFile("../x", frameKey(1, 1, "full"))).toBeNull();
  });
});

describe("which build's frame is used", () => {
  const mine = buildTag("render new");
  const old = buildTag("render old"); // draws 3D differently from this build
  const twin = buildTag("render twin"); // draws everything the same
  const stranger = buildTag("render unlisted");
  const older = new Map<string, readonly string[]>([
    [old, ["3d"]],
    [twin, []],
  ]);
  // Whether a frame has none of the kinds a build draws differently: a 2D frame, a frame with 3D.
  const flat = () => true;
  const with3d = (changed: readonly string[]) => !changed.includes("3d");
  const pick = (keys: string[], drawsSame: (c: readonly string[]) => boolean) => usableKey(new Set(keys), 7, 1, "full", "sigaaaa", mine, older, drawsSame);
  const k = (tag: string, sig = "sigaaaa") => diskKey(7, 1, "full", sig, tag);

  it("takes this build's own frame first", () => {
    expect(pick([k(old), k(mine), k(twin)], with3d)).toBe(k(mine));
  });

  it("takes an earlier build's frame only where it draws the same", () => {
    expect(pick([k(old)], flat)).toBe(k(old));
    expect(pick([k(old)], with3d)).toBeNull(); // made again by this build
    expect(pick([k(old), k(twin)], with3d)).toBe(k(twin));
  });

  it("never takes a frame of an unlisted build, or of another version of the show", () => {
    expect(pick([k(stranger)], flat)).toBeNull();
    expect(pick([k(mine, "sigbbbb"), k(old, "sigbbbb")], flat)).toBeNull();
  });

  it("counts frames by the same rule", () => {
    for (const keys of [[k(mine)], [k(old)], [k(twin)], [k(stranger)], [k(mine, "sigbbbb")]])
      for (const drawsSame of [flat, with3d]) {
        const counted = keys.some((key) => usable(parseDiskKey(key)!, "sigaaaa", mine, older, drawsSame));
        expect(counted).toBe(pick(keys, drawsSame) !== null);
      }
  });
});

describe("DiskIndex", () => {
  it("adds up sizes, replaces older copies and forgets frames", () => {
    const ix = new DiskIndex();
    ix.add("p/c", frameKey(0, 1, "full"), 10 * MB);
    ix.add("p/c", frameKey(1, 1, "full"), 20 * MB);
    ix.add("p/c", frameKey(1, 1, "full"), 5 * MB); // saved again
    ix.add("p/d", frameKey(0, 1, "full"), 1 * MB);
    expect(ix.files).toBe(3);
    expect(ix.bytes).toBe(16 * MB);
    expect(ix.keys("p/c").sort()).toEqual([frameKey(0, 1, "full"), frameKey(1, 1, "full")]);
    expect(ix.remove("p/c", frameKey(0, 1, "full"))?.bytes).toBe(10 * MB);
    expect(ix.remove("p/c", frameKey(0, 1, "full"))).toBeNull();
    expect(ix.bytes).toBe(6 * MB);
    expect(ix.removeScope("p/c").map((e) => e.frame)).toEqual([1]);
    expect(ix.keys("p/c")).toEqual([]);
    expect(ix.bytes).toBe(1 * MB);
    expect(ix.clear()).toHaveLength(1);
    expect(ix.bytes).toBe(0);
    expect(ix.files).toBe(0);
  });

  it("evicts least recently used frames down to 90 % of the limit, counting reads as use", () => {
    const ix = new DiskIndex();
    for (let f = 0; f < 10; f++) ix.add("p/c", frameKey(f, 1, "full"), 10 * MB);
    expect(ix.evict(100 * MB)).toEqual([]); // exactly at the limit: nothing to do
    ix.touch("p/c", frameKey(0, 1, "full")); // frame 0 was just watched
    ix.add("p/c", frameKey(10, 1, "full"), 10 * MB); // 110 MB now
    const gone = ix.evict(100 * MB);
    // Down to ≤ 90 MB: the two oldest unused frames (1, 2) go; 0 stays because it was read.
    expect(gone.map((e) => e.frame)).toEqual([1, 2]);
    expect(ix.bytes).toBe(90 * MB);
    expect(ix.has("p/c", frameKey(0, 1, "full"))).toBe(true);
    expect(ix.has("p/c", frameKey(1, 1, "full"))).toBe(false);
    expect(ix.touch("p/c", frameKey(1, 1, "full"))).toBe(false);
  });

  it("forgets exactly the frames an edit changed", () => {
    const ix = new DiskIndex();
    for (let f = 0; f < 10; f++) {
      ix.add("p/c", frameKey(f, 1, "full"), MB);
      ix.add("p/c", frameKey(f, 0.5, "draft"), MB);
      ix.add("p/other", frameKey(f, 1, "full"), MB);
    }
    const gone = ix.removeFrames("p/c", [
      [2, 4],
      [8, Number.MAX_SAFE_INTEGER],
    ]);
    expect([...new Set(gone.map((e) => e.frame))].sort((a, b) => a - b)).toEqual([2, 3, 8, 9]);
    expect(gone).toHaveLength(8); // both sizes and qualities
    expect(ix.keys("p/other")).toHaveLength(10);
    expect(ix.bytes).toBe(22 * MB);
  });
});

describe("show fingerprints", () => {
  it("is stable and tells versions apart", () => {
    const a = JSON.stringify({ id: "p", layers: [1, 2, 3] });
    const b = JSON.stringify({ id: "p", layers: [1, 2, 4] });
    expect(fingerprint(a)).toBe(fingerprint(a));
    expect(fingerprint(a)).not.toBe(fingerprint(b));
    expect(fingerprint("")).not.toBe(fingerprint(" "));
  });
});

describe("graphics card memory from Windows", () => {
  const CLASS = "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
  const memory = `\r\n${CLASS}\\0001\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x2fc300000\r\n\r\nEnd of search: 1 match(es) found.\r\n`;
  const names = `\r\n${CLASS}\\0000\r\n    DriverDesc    REG_SZ    Intel(R) Graphics\r\n\r\n${CLASS}\\0001\r\n    DriverDesc    REG_SZ    NVIDIA GeForce RTX 5070 Ti Laptop GPU\r\n\r\nEnd of search: 2 match(es) found.\r\n`;

  it("picks the card with the most memory of its own", () => {
    const card = pickGraphicsCard(parseRegQuery(memory), parseRegQuery(names));
    expect(card?.name).toBe("NVIDIA GeForce RTX 5070 Ti Laptop GPU");
    expect(card?.bytes).toBe(0x2fc300000);
    expect(formatSize(card!.bytes)).toBe("11.9 GB");
  });

  it("reads older drivers' 32-bit and binary values, and copes with nothing", () => {
    const legacy = `${CLASS}\\0000\r\n    HardwareInformation.MemorySize    REG_BINARY    00000080\r\n`;
    expect(pickGraphicsCard(new Map(), parseRegQuery(names), parseRegQuery(legacy))).toEqual({ name: "Intel(R) Graphics", bytes: 0x80000000 });
    const dword = `${CLASS}\\0002\r\n    HardwareInformation.MemorySize    REG_DWORD    0x40000000\r\n`;
    expect(pickGraphicsCard(new Map(), new Map(), parseRegQuery(dword))).toEqual({ name: "Graphics card", bytes: GB });
    expect(pickGraphicsCard(parseRegQuery(""), parseRegQuery(""))).toBeNull();
  });
});

describe("sizes in words", () => {
  it("uses MB below a gigabyte and trims decimals above", () => {
    expect(formatSize(512 * MB)).toBe("512 MB");
    expect(formatSize(1.5 * GB)).toBe("1.5 GB");
    expect(formatSize(1.25 * GB)).toBe("1.25 GB");
    expect(formatSize(12 * GB)).toBe("12 GB");
    expect(formatSize(640.4 * GB)).toBe("640 GB");
  });
});

/**
 * Google Drive through Google Drive for desktop: the pure parts (no files touched here).
 *
 * Drive is for exchanging things — media, project packages and finished exports — through a folder of
 * Before Effects' own in "My Drive" (by default "Before Effects", with Media, Projects and Exports
 * inside). Media can also be brought in from anywhere else in Drive without moving or copying the
 * collection: only the files a show uses are copied, into the local media folder, before they are
 * played or rendered. Caches, prepared frames and working files stay on the local data drive and are
 * never put in Drive.
 *
 * Plain string work (no Node modules), so the UI can use it too.
 */

export const DRIVE_DEFAULT_FOLDER = "Before Effects";
export const DRIVE_SUBFOLDERS = { media: "Media", projects: "Projects", exports: "Exports" } as const;
export type DriveSubfolder = keyof typeof DRIVE_SUBFOLDERS;

/** Google Drive for desktop can't report when Google has the file; Before Effects says so rather than guess. */
export const DRIVE_UPLOAD_NOTE =
  "Copied into your Google Drive folder. Google Drive for desktop uploads it in the background; Before Effects can't confirm when the upload has finished — check the Google Drive app or drive.google.com.";

/** Where "My Drive" can be: Drive for desktop's drive letter (streaming), or a mirrored folder in the home folder. */
export const myDriveCandidates = (home: string, letters = "GHIJKLMNOPQRSTUVWXYZ"): string[] => {
  const h = norm(home);
  return [...[...letters].map((d) => `${d}:\\My Drive`), `${h}\\Google Drive\\My Drive`, `${h}\\My Drive`, `${h}\\Google Drive`];
};

/** A Windows path with backslashes, "." and ".." worked out, and no trailing separator. */
const norm = (p: string) => {
  const parts: string[] = [];
  for (const x of p.split(/[\\/]+/))
    if (x === "..") parts.length > 1 && parts.pop();
    else if (x !== "." && (x || !parts.length)) parts.push(x);
  return parts.join("\\");
};

/** `p` relative to My Drive ("Effects library/Ghosts/a.mp4"), or null when it isn't inside My Drive. */
export const driveRelative = (myDrive: string, p: string): string | null => {
  const root = norm(myDrive).toLowerCase();
  const full = norm(p);
  if (full.toLowerCase() !== root && !full.toLowerCase().startsWith(`${root}\\`)) return null;
  const rel = full.slice(root.length).replace(/^[\\/]+/, "");
  return rel.split(/[\\/]+/).filter(Boolean).join("/");
};

/** A path inside My Drive from its relative form; refuses anything that would step outside it. */
export const driveResolve = (myDrive: string, rel: string): string | null => {
  const parts = rel.split(/[\\/]+/).filter((x) => x && x !== ".");
  if (parts.some((x) => x === ".." || /^[a-zA-Z]:$/.test(x))) return null;
  return [norm(myDrive), ...parts].join("\\");
};

/**
 * A folder someone typed or picked, as a place in My Drive ("Before Effects/Exports"), or null when it
 * isn't inside My Drive (or is My Drive itself). A typed "My Drive/…" means the same place as "…".
 */
export const driveFolderInput = (myDrive: string, input: string): string | null => {
  const t = input.trim();
  if (/^[a-zA-Z]:|^[\\/]{2}/.test(t)) return driveRelative(myDrive, t) || null;
  const parts = t.split(/[\\/]+/).filter((x) => x && x !== ".");
  if (parts[0]?.toLowerCase() === "my drive") parts.shift();
  return parts.length && driveResolve(myDrive, parts.join("/")) ? parts.join("/") : null;
};

/** The first folder name repeated straight inside itself ("Before Effects/Before Effects"), usually a mistake. */
export const repeatedFolder = (rel: string): string | null => {
  const parts = rel.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) if (parts[i]!.toLowerCase() === parts[i - 1]!.toLowerCase()) return parts.slice(0, i + 1).join("/");
  return null;
};

/**
 * A folder inside My Drive saved as My Drive's own location (picked by mistake for Before Effects'
 * folder) makes everything land one level too deep. Given where My Drive really is, the setting meant:
 * that folder is Before Effects' folder. Returns the corrected setting, or null when it's fine.
 */
export const untangleMyDrive = (found: string | null, chosen: string | undefined): { folder: string } | { myDrive: null } | null => {
  if (!found || !chosen) return null;
  const rel = driveRelative(found, chosen);
  if (rel === null) return null;
  return rel === "" ? { myDrive: null } : { folder: rel };
};

/** What a file is, from its name (for listings). */
export const driveKind = (name: string): "video" | "image" | "audio" | "project" | "package" | "other" => {
  const ext = /\.[^./\\]+$/.exec(name.toLowerCase())?.[0] ?? "";
  if ([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mpg", ".mpeg"].includes(ext)) return "video";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif"].includes(ext)) return "image";
  if ([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".aiff", ".aif"].includes(ext)) return "audio";
  if (ext === ".beproj") return "project";
  if (name === PACKAGE_MANIFEST) return "package";
  return "other";
};

// ---- Project packages ---------------------------------------------------------------------------------
// A package is a folder: the project file (its media referenced as "media/<file>"), the media, and a
// manifest listing every file with its size, so an incomplete copy is noticed.

export const PACKAGE_MANIFEST = "package.json";
export const PACKAGE_MEDIA = "media";

export interface PackageFile {
  /** Path inside the package ("media/organ.mp4"). */
  readonly rel: string;
  readonly size: number;
}
export interface PackageManifest {
  readonly kind: "before-effects-package";
  readonly version: 1;
  readonly name: string;
  readonly project: string;
  readonly createdAt: string;
  readonly files: readonly PackageFile[];
}

/** A folder name that's safe on Windows and in Drive. */
export const safeFolderName = (name: string): string => {
  const s = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return s && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s) ? s.slice(0, 120) : "Project";
};

type AssetPaths = { readonly id: string; readonly path: string; readonly audioPath?: string; readonly proxyPath?: string; readonly sourceFile?: string };
const PATH_KEYS = ["path", "audioPath", "proxyPath", "sourceFile"] as const;

/**
 * Which local files go into a package and under what names: every file the project's assets use, each
 * once, named after the original (numbered when two share a name). Files that don't exist are left out
 * (`exists` says which do).
 */
export const packagePlan = (assets: readonly AssetPaths[], exists: (p: string) => boolean): Map<string, string> => {
  const plan = new Map<string, string>();
  const used = new Set<string>();
  for (const a of assets)
    for (const k of PATH_KEYS) {
      const p = a[k];
      if (!p || plan.has(p) || !exists(p)) continue;
      const base = p.split(/[\\/]/).pop() ?? p;
      const dot = base.lastIndexOf(".");
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
      used.add(name.toLowerCase());
      plan.set(p, `${PACKAGE_MEDIA}/${name}`);
    }
  return plan;
};

/** The project as it goes into a package: each asset path replaced by its place in the package. */
export const projectForPackage = <P extends { assets: Record<string, AssetPaths> }>(project: P, plan: ReadonlyMap<string, string>): P => {
  const assets: Record<string, AssetPaths> = {};
  for (const [id, a] of Object.entries(project.assets)) {
    const b: Record<string, unknown> = { ...a };
    for (const k of PATH_KEYS) if (a[k] && plan.has(a[k]!)) b[k] = plan.get(a[k]!);
    assets[id] = b as unknown as AssetPaths;
  }
  return { ...project, assets };
};

/** The project as it comes out of a package: package paths replaced by where the files were copied locally. */
export const projectFromPackage = <P extends { assets: Record<string, AssetPaths> }>(project: P, localOf: (rel: string) => string): P => {
  const assets: Record<string, AssetPaths> = {};
  for (const [id, a] of Object.entries(project.assets)) {
    const b: Record<string, unknown> = { ...a };
    for (const k of PATH_KEYS) if (a[k]?.startsWith(`${PACKAGE_MEDIA}/`)) b[k] = localOf(a[k]!);
    assets[id] = b as unknown as AssetPaths;
  }
  return { ...project, assets };
};

/** Files a package says it has that are missing or the wrong size (an upload or download still in progress, or cut off). */
export const packageProblems = (m: PackageManifest, sizeOf: (rel: string) => number | null): string[] =>
  m.files.flatMap((f) => {
    const s = sizeOf(f.rel);
    return s === null ? [`${f.rel} is missing`] : s !== f.size ? [`${f.rel} is ${s} bytes, expected ${f.size}`] : [];
  });

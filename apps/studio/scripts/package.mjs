/**
 * Package the studio as a standalone Windows app in <repo>/build/app ("Before Effects.exe"), or in
 * BE_PACKAGE_DIR when set (a separate test build).
 * Run via: pnpm --filter @be/studio package   (the root launcher runs this automatically).
 *
 * The bundles in out/ import only Electron and Node built-ins, except house detection, which runs
 * transformers.js and ONNX Runtime in its own process: just those packages (Windows x64 parts only)
 * are copied into node_modules, unpacked from the archive. FFmpeg is copied into resources/bin so
 * exporting works without separate installs.
 */
import { packager } from "@electron/packager";
import { execSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { renderHash as renderHashOf } from "../src/shared/renderHash.ts";

const studio = resolve(import.meta.dirname, "..");
const root = resolve(studio, "../..");
const buildDir = join(root, "build");
const stage = join(buildDir, ".stage");
// BE_PACKAGE_DIR: package somewhere else (a test build beside the installed app), leaving build/app alone.
const appDir = process.env.BE_PACKAGE_DIR ? resolve(process.env.BE_PACKAGE_DIR) : join(buildDir, "app");
const pkg = JSON.parse(readFileSync(join(studio, "package.json"), "utf8"));
const electronVersion = JSON.parse(readFileSync(join(studio, "node_modules", "electron", "package.json"), "utf8")).version;
const version = pkg.version === "0.0.0" ? "0.1.0" : pkg.version;

const step = (m) => console.log(`[package] ${m}`);

if (!existsSync(join(studio, "out", "main", "index.js"))) throw new Error("Run electron-vite build first (out/ is missing).");

step("staging app files");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(studio, "out"), join(stage, "out"), { recursive: true });
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: "before-effects", productName: "Before Effects", version, description: "Before Effects", main: "out/main/index.js", type: "module" }, null, 2),
);

// House detection's runtime: transformers.js and what it needs at run time (not install-time
// helpers, not the browser build of ONNX Runtime, which transformers.js already bundles).
step("staging the house-detection runtime");
const SKIP = new Set(["onnxruntime-web", "adm-zip", "global-agent"]);
const findDep = (from, name) => {
  for (let d = from; ; d = dirname(d)) {
    const c = join(d, "node_modules", name);
    if (existsSync(join(c, "package.json"))) return realpathSync(c);
    if (dirname(d) === d) return null;
  }
};
const runtime = new Map();
const collect = (name, from) => {
  if (runtime.has(name) || SKIP.has(name)) return;
  const dir = findDep(from, name);
  if (!dir) throw new Error(`House detection needs ${name}, which isn't installed (run pnpm install).`);
  runtime.set(name, dir);
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const d of Object.keys(pj.dependencies ?? {})) collect(d, dir);
  for (const d of Object.keys(pj.optionalDependencies ?? {})) if (/win32-x64/.test(d)) collect(d, dir);
};
collect("@huggingface/transformers", studio);
const unwanted = (name, rel) => {
  const r = rel.split(sep).join("/");
  if (/\.(map|d\.ts|d\.mts|d\.cts|md)$/i.test(r) && !/license/i.test(r)) return true;
  if (name === "onnxruntime-node") return /^(lib|script)\//.test(r) || (/^bin\/napi-v\d+\//.test(r) && !/^bin\/napi-v\d+(\/win32(\/x64(\/.*)?)?)?$/.test(r));
  if (name === "@huggingface/transformers") return /^(src|types)\//.test(r) || (/^dist\//.test(r) && !/^dist\/transformers\.node\.(mjs|cjs)$/.test(r));
  return false;
};
let runtimeBytes = 0;
for (const [name, dir] of runtime) {
  cpSync(dir, join(stage, "node_modules", name), {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const keep = !unwanted(name, relative(dir, src));
      if (keep && statSync(src).isFile()) runtimeBytes += statSync(src).size;
      return keep;
    },
  });
}
step(`  ${runtime.size} packages, ${(runtimeBytes / 1e6).toFixed(0)} MB: ${[...runtime.keys()].join(", ")}`);

step(`packaging with Electron ${electronVersion}`);
const [packaged] = await packager({
  dir: stage,
  name: "Before Effects",
  executableName: "Before Effects",
  platform: "win32",
  arch: "x64",
  out: join(buildDir, ".packager"),
  overwrite: true,
  // The assistant's MCP bridge runs as a separate Node process, so it must be a real file.
  // Scripts run as separate Node processes, and native modules, must be real files.
  asar: { unpack: "**/out/main/{mcp-bridge.js,assistant-test-cli.js,agent-mcp.js,agent-cli.js,heic-worker.js,detect-host.js,chunks/*.js}", unpackDir: "node_modules" },
  prune: false,
  icon: join(studio, "build", "icon.ico"),
  // The script that runs inside Blender for simulated effects (resources/blender).
  extraResource: [join(studio, "resources", "blender")],
  electronVersion,
  appVersion: version,
  appCopyright: "Personal use",
  quiet: true,
  win32metadata: { CompanyName: "Before Effects", FileDescription: "Before Effects", ProductName: "Before Effects", InternalName: "Before Effects" },
});

// Keep the (large) bundled FFmpeg from the previous build instead of copying it again.
const oldBin = join(appDir, "resources", "bin");
const newBin = join(packaged, "resources", "bin");
mkdirSync(newBin, { recursive: true });
for (const exe of ["ffmpeg.exe", "ffprobe.exe"]) {
  if (existsSync(join(oldBin, exe))) {
    try {
      renameSync(join(oldBin, exe), join(newBin, exe));
    } catch {
      /* copied below */
    }
  }
}

step("replacing previous build");
try {
  rmSync(appDir, { recursive: true, force: true });
} catch (e) {
  throw new Error(`Couldn't replace the previous build (${String(e.message ?? e)}). Close Before Effects and try again.`);
}
try {
  renameSync(packaged, appDir);
} catch (e) {
  // Another drive (BE_PACKAGE_DIR): copy instead.
  if (e.code !== "EXDEV") throw e;
  cpSync(packaged, appDir, { recursive: true });
  rmSync(packaged, { recursive: true, force: true });
}
rmSync(stage, { recursive: true, force: true });

// Find FFmpeg the same way the app does: PATH first, then winget's links folder.
const findFfmpegDir = () => {
  const dirs = [...(process.env.PATH ?? "").split(";"), join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links")];
  return dirs.find((d) => d && existsSync(join(d, "ffmpeg.exe")) && existsSync(join(d, "ffprobe.exe"))) ?? null;
};
const binDir = join(appDir, "resources", "bin");
const ffDir = findFfmpegDir();
for (const exe of ["ffmpeg.exe", "ffprobe.exe"]) {
  const dst = join(binDir, exe);
  if (!ffDir) {
    step(`WARNING: ${exe} not found; exports will ask the person to install FFmpeg`);
    continue;
  }
  const src = join(ffDir, exe);
  if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) {
    step(`bundling ${exe}`);
    copyFileSync(src, dst);
  }
}

let gitHead = "unknown";
try {
  gitHead = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
} catch {
  /* not a git checkout */
}
// What decides how preview frames look (shared with the app run from the repository).
const renderHash = renderHashOf(root);
writeFileSync(join(appDir, "resources", "build-info.json"), JSON.stringify({ builtAt: new Date().toISOString(), version, electron: electronVersion, gitHead, renderHash }, null, 2));
step(`done → ${join(appDir, "Before Effects.exe")}`);

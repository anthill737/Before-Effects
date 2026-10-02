/**
 * Package the studio as a standalone Windows app in <repo>/build/app ("Before Effects.exe").
 * Run via: pnpm --filter @be/studio package   (the root launcher runs this automatically).
 *
 * The bundles in out/ import only Electron and Node built-ins, so the packaged app needs no
 * node_modules. FFmpeg is copied into resources/bin so exporting works without separate installs.
 */
import { packager } from "@electron/packager";
import { execSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const studio = resolve(import.meta.dirname, "..");
const root = resolve(studio, "../..");
const buildDir = join(root, "build");
const stage = join(buildDir, ".stage");
const appDir = join(buildDir, "app");
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
  asar: { unpack: "**/out/main/{mcp-bridge,assistant-test-cli}.js" },
  prune: false,
  icon: join(studio, "build", "icon.ico"),
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
renameSync(packaged, appDir);
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
writeFileSync(join(appDir, "resources", "build-info.json"), JSON.stringify({ builtAt: new Date().toISOString(), version, electron: electronVersion, gitHead }, null, 2));
step(`done → ${join(appDir, "Before Effects.exe")}`);

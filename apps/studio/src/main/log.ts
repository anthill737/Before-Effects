/**
 * Main-process log file (%APPDATA%\Before Effects\logs\main.log), rotated at 5 MB — at start-up
 * and while running. The launcher shows its tail after a failed start. Logging never throws: a
 * closed console (EPIPE) just stops console output, and a full disk just stops file output.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

let file: string | null = null;
let consoleOk = true;
let writes = 0;
const LIMIT = 5_000_000;

export const logDir = (): string => join(app.getPath("userData"), "logs");

const rotate = () => {
  if (!file) return;
  try {
    if (existsSync(file) && statSync(file).size > LIMIT) renameSync(file, join(logDir(), "main.previous.log"));
  } catch {
    // rotation is best-effort
  }
};

export const initLog = (): string => {
  const dir = logDir();
  mkdirSync(dir, { recursive: true });
  file = join(dir, "main.log");
  rotate();
  process.stdout.on("error", () => (consoleOk = false));
  process.stderr.on("error", () => undefined);
  log(`---- Before Effects ${app.getVersion()} starting (pid ${process.pid}, ${process.platform} ${process.arch}, electron ${process.versions.electron}) ----`);
  return file;
};

export const log = (msg: string): void => {
  const line = `${new Date().toISOString()} ${msg}\n`;
  if (consoleOk && process.stdout.writable) {
    try {
      process.stdout.write(line);
    } catch {
      consoleOk = false;
    }
  }
  if (!file) return;
  try {
    if (++writes % 200 === 0) rotate();
    appendFileSync(file, line);
  } catch {
    // never let logging crash the app
  }
};

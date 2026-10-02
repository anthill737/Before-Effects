/**
 * Registry of background processes (FFmpeg sessions, assistant CLIs, sidecars). Everything
 * registered here is terminated when the app quits. The launcher's Windows job object is the
 * backstop if the app itself crashes.
 */
import type { ChildProcess } from "node:child_process";
import { log } from "./log.ts";

const children = new Set<{ name: string; proc: ChildProcess; stop?: () => void }>();

export const track = (name: string, proc: ChildProcess, stop?: () => void): void => {
  const entry = { name, proc, ...(stop ? { stop } : {}) };
  children.add(entry);
  proc.once("exit", () => children.delete(entry));
};

export const stopAll = (): void => {
  for (const c of children) {
    try {
      if (c.stop) c.stop();
      else c.proc.kill();
      log(`stopped background process ${c.name} (pid ${c.proc.pid})`);
    } catch (e) {
      log(`could not stop ${c.name}: ${String(e)}`);
    }
  }
  children.clear();
};

export const running = (): string[] => [...children].map((c) => `${c.name}#${c.proc.pid}`);

/** UI journey test runner: drives the real UI step by step and captures a screenshot after each step. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, type BrowserWindow } from "electron";
import { log } from "./log.ts";

export const runUiTest = async (win: BrowserWindow, rendersDir: string) => {
  const outDir = join(rendersDir, "ui-test");
  mkdirSync(outDir, { recursive: true });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(1500);
  const only = process.env.BE_UITEST_ONLY?.split(",");
  // Live assistant runs use the person's real subscriptions, so they only run when asked for.
  await win.webContents.executeJavaScript(`window.beLiveAi = ${JSON.stringify(process.env.BE_UITEST_LIVE_AI ?? "")}`);
  // Sample After Effects projects live in the repository (development builds only).
  if (!app.isPackaged) await win.webContents.executeJavaScript(`window.beRepo = ${JSON.stringify(join(app.getAppPath(), "..", ".."))}`);
  // The house photo for the house-setup journey: BE_HOUSE_PHOTO, else the first photo in <data folder>\Venue.
  const venueDir = join(dirname(rendersDir), "Venue");
  const housePhoto = process.env.BE_HOUSE_PHOTO ?? (existsSync(venueDir) ? readdirSync(venueDir).filter((f) => /\.(heic|heif|jpe?g|png)$/i.test(f)).sort((a, b) => Number(/\.hei[cf]$/i.test(b)) - Number(/\.hei[cf]$/i.test(a)))[0] : undefined);
  if (housePhoto) await win.webContents.executeJavaScript(`window.beHousePhoto = ${JSON.stringify(process.env.BE_HOUSE_PHOTO ? housePhoto : join(venueDir, housePhoto))}`);
  const steps = ((await win.webContents.executeJavaScript("window.__beTest.steps()")) as string[]).filter((s) => !only || only.includes(s));
  const results: Array<{ step: string; ok: boolean; note: string; file: string }> = [];
  for (const [i, step] of steps.entries()) {
    let ok = false;
    let note = "";
    try {
      const r = (await win.webContents.executeJavaScript(`window.__beTest.run(${JSON.stringify(step)})`)) as { ok: boolean; note?: string; settle?: number };
      ok = r.ok;
      note = r.note ?? "";
      await wait(r.settle ?? 700);
    } catch (e) {
      note = String(e);
    }
    const file = join(outDir, `${String(i + 1).padStart(2, "0")}-${step}.png`);
    writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    results.push({ step, ok, note, file });
    log(`${ok ? "PASS" : "FAIL"} ${step}${note ? ` — ${note}` : ""}`);
  }
  const allOk = results.every((r) => r.ok);
  writeFileSync(join(outDir, "ui-test-report.json"), JSON.stringify({ ok: allOk, at: new Date().toISOString(), results }, null, 2));
  log(`UI_TEST ${allOk ? "OK" : "FAILED"}`);
  app.exit(allOk ? 0 : 1);
};

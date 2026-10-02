/**
 * Corpus check for the .aep reader: runs readAep on every .aep in a sample corpus and compares the
 * result with the After Effects ground truth exported next to it (`<name>.json`, written by
 * ExtendScript inside After Effects), and — for mask/shape paths and text documents, which most
 * ground-truth files don't contain — with an oracle dump from py_aep (`oracle.json`, made by
 * `test/oracle/dump_py_aep.py`).
 *
 *   npx tsx packages/aep/test/compare.ts [corpusDir] [--oracle oracle.json] [--examples 8] [--json report.json]
 *
 * corpusDir defaults to $AEP_CORPUS. Prints per-field accuracy, the worst mismatches, and files
 * that fail to parse.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { AeJsonProject } from "@be/core";
import { readAep } from "../src/index.ts";
import { compareOracle, compareProject, getStats, resetStats, setFile } from "./ground-truth.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
const corpus = positional[0] ?? process.env["AEP_CORPUS"];
if (!corpus) {
  console.error("Usage: compare.ts <corpusDir> (or set AEP_CORPUS)");
  process.exit(2);
}
const oraclePath = flag("--oracle");
resetStats(Number(flag("--examples") ?? 6));
const reportPath = flag("--json");

/**
 * Ground-truth files that don't describe their .aep (exported from a different save: other comp
 * size, other solids). py_aep reads these .aep files the same way this reader does.
 */
const STALE_GROUND_TRUTH = new Set(["models/composition/selection_both_layers.aep", "models/selection/selection_dropshadow_enabled_opacity.aep"]);

// ---- main ---------------------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.toLowerCase().endsWith(".aep")) out.push(p);
  }
  return out;
}

const files = walk(corpus).sort();
const oracle: Record<string, Json[]> = oraclePath ? JSON.parse(readFileSync(oraclePath, "utf8")) : {};
const failures: string[] = [];
let parsed = 0;
let withGt = 0;
let staleSkipped = 0;
let worstMs = 0;
let worstMsFile = "";
let totalMs = 0;
for (const f of files) {
  const currentFile = relative(corpus, f).replace(/\\/g, "/");
  setFile(currentFile);
  let ours: AeJsonProject;
  const t0 = performance.now();
  try {
    ours = readAep(new Uint8Array(readFileSync(f)), { fileName: basename(f) });
  } catch (e) {
    failures.push(`${currentFile}: ${(e as Error).message}${(e as Error).cause ? ` (${String((e as Error).cause)})` : ""}`);
    continue;
  }
  const ms = performance.now() - t0;
  totalMs += ms;
  if (ms > worstMs) [worstMs, worstMsFile] = [ms, currentFile];
  parsed++;
  const jsonPath = f.replace(/\.aep$/i, ".json");
  let gt: Json | undefined;
  try {
    gt = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    gt = undefined;
  }
  if (gt && Array.isArray(gt.items) && STALE_GROUND_TRUTH.has(currentFile)) staleSkipped++;
  else if (gt && Array.isArray(gt.items)) {
    withGt++;
    compareProject(ours, gt);
  }
  const oe = oracle[currentFile];
  if (oe) compareOracle(ours, oe);
}

const rows = [...getStats().entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log(`\nFiles: ${files.length}  parsed OK: ${parsed}  failed: ${failures.length}  compared with ground truth: ${withGt}  (stale ground truth skipped: ${staleSkipped})`);
console.log(`Parse time: total ${totalMs.toFixed(0)} ms, slowest ${worstMs.toFixed(1)} ms (${worstMsFile})\n`);
console.log("field".padEnd(44) + "ok/total".padStart(18) + "   %");
for (const [k, s] of rows) console.log(k.padEnd(44) + `${s.ok}/${s.total}`.padStart(18) + `  ${((100 * s.ok) / Math.max(1, s.total)).toFixed(2).padStart(6)}  ${s.files.size ? `(${s.files.size} files)` : ""}`);
console.log("\nWorst mismatches:");
for (const [k, s] of rows) {
  if (s.ok === s.total) continue;
  console.log(`\n[${k}] ${s.total - s.ok} mismatches`);
  for (const e of s.examples) console.log("  - " + e);
}
if (failures.length) {
  console.log("\nFiles that failed to parse:");
  for (const f of failures) console.log("  - " + f);
}
if (reportPath) {
  writeFileSync(reportPath, JSON.stringify({ files: files.length, parsed, failures, withGroundTruth: withGt, fields: Object.fromEntries(rows.map(([k, s]) => [k, { ok: s.ok, total: s.total, files: [...s.files].slice(0, 50), examples: s.examples }])) }, null, 1));
}

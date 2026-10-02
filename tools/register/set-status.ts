/**
 * Update register entries' status and evidence with targeted text edits, leaving all other
 * formatting untouched.
 *   pnpm tsx tools/register/set-status.ts --status prototype --evidence "how to reproduce" id1 id2 ...
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTER_DIR, STATUSES } from "./load.ts";

const args = process.argv.slice(2);
const take = (flag: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args.splice(i, 2)[1]!), i--;
  return out;
};
const status = take("--status")[0];
const evidence = take("--evidence");
if (!status || !(STATUSES as readonly string[]).includes(status)) throw new Error(`--status must be one of ${STATUSES.join(", ")}`);
const ids = new Set(args);
const found = new Set<string>();
const quote = (s: string) => JSON.stringify(s);

for (const file of readdirSync(REGISTER_DIR).filter((f) => f.endsWith(".yaml"))) {
  const path = join(REGISTER_DIR, file);
  const text = readFileSync(path, "utf8");
  // Split into entry blocks at top-level "- id:" lines, keeping the file header.
  const parts = text.split(/(?=^- id: )/m);
  let changed = false;
  const out = parts.map((block) => {
    const m = /^- id: (\S+)/.exec(block);
    if (!m || !ids.has(m[1]!)) return block;
    found.add(m[1]!);
    changed = true;
    let b = block.replace(/^( {2}status: ).*$/m, `$1${status}`);
    const evLine = /^( {2}evidence:)(.*)$/m.exec(b);
    if (!evLine) return b;
    // Collect existing evidence (inline [] list or following "    - item" lines).
    const existing: string[] = [];
    const afterIdx = (evLine.index ?? 0) + evLine[0].length;
    const tail = b.slice(afterIdx);
    const listLines = /^((?:\n {4}- .*)*)/.exec(tail)?.[1] ?? "";
    for (const l of listLines.split("\n").filter(Boolean)) existing.push(JSON.parse(l.replace(/^ {4}- /, "").trim().startsWith('"') ? l.replace(/^ {4}- /, "").trim() : quote(l.replace(/^ {4}- /, "").trim())));
    const inline = evLine[2]!.trim();
    if (inline.startsWith("[") && inline !== "[]") for (const x of inline.slice(1, -1).split(",")) if (x.trim()) existing.push(x.trim().replace(/^"|"$/g, ""));
    for (const e of evidence) if (!existing.includes(e)) existing.push(e);
    const rendered = existing.length ? `  evidence:\n${existing.map((e) => `    - ${quote(e)}`).join("\n")}` : "  evidence: []";
    b = b.slice(0, evLine.index) + rendered + tail.slice(listLines.length);
    return b;
  });
  if (changed) writeFileSync(path, out.join(""));
}
const missing = [...ids].filter((i) => !found.has(i));
console.log(`Updated ${found.size} entries to ${status}.${missing.length ? ` Not found: ${missing.join(", ")}` : ""}`);

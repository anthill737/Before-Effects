/** Load and validate the capability register (docs/register/*.yaml). */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const REGISTER_DIR = resolve(import.meta.dirname, "../../docs/register");

const text = z.string().min(1);
const source = z.object({
  ref: text,
  item: z.string().optional(),
  category: z.string().optional(),
  adobe_support: z
    .object({
      gpu: z.boolean().nullable().optional(),
      bpc: z.array(z.number()).optional(),
      mfr: z.boolean().nullable().optional(),
    })
    .partial()
    .nullable()
    .optional(),
  checked: z.boolean(),
});

export const STATUSES = ["not-started", "designed", "prototype", "implemented", "verified"] as const;
export const DISPOSITIONS = ["required-equivalent", "required-integration", "deferred", "superseded", "unresolved", "excluded"] as const;
/** Dispositions that are in the active build scope (everything else is parked, replaced or undecided). */
export const ACTIVE_DISPOSITIONS: readonly string[] = ["required-equivalent", "required-integration"];
export const MILESTONES = ["A", "B", "C", "D", "E", "F"] as const;

export const entrySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$/, "id must be a dotted lowercase slug"),
  name: text,
  sources: z.array(source).min(1),
  artist_can: text,
  projection_example: text,
  controls: z
    .array(z.object({ name: text, type: z.string(), animatable: z.boolean() }).passthrough())
    .nullable()
    .default([]),
  animation: z.string().nullable().optional(),
  dependencies: z.array(z.string()).nullable().default([]),
  implementation: text,
  io: z.string().nullable().optional(),
  limitations: z.string().nullable().optional(),
  disposition: z.enum(DISPOSITIONS),
  superseded_by: z.string().nullable().optional(),
  exclusion_reason: z.string().nullable().optional(),
  deferred_reason: z.string().nullable().optional(),
  milestone: z.enum(MILESTONES),
  beginner: z.object({
    action: text,
    defaults: z.string().nullable().optional(),
    automation: z.string().nullable().optional(),
    usability_check: text,
  }),
  acceptance: z.string().nullable().optional(),
  status: z.enum(STATUSES),
  evidence: z.array(z.string()).nullable().default([]),
});

export type Entry = z.infer<typeof entrySchema> & { file: string };

export interface LoadResult {
  entries: Entry[];
  errors: string[];
  warnings: string[];
}

export const loadRegister = (dir = REGISTER_DIR): LoadResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const entries: Entry[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  for (const file of files) {
    let doc: unknown;
    try {
      doc = parse(readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      errors.push(`${file}: YAML does not parse — ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    if (!Array.isArray(doc)) {
      errors.push(`${file}: expected a list of entries`);
      continue;
    }
    doc.forEach((raw, i) => {
      const r = entrySchema.safeParse(raw);
      const where = `${file}#${i + 1}${raw && typeof raw === "object" && "id" in raw ? ` (${String((raw as { id: unknown }).id)})` : ""}`;
      if (!r.success) {
        for (const issue of r.error.issues) errors.push(`${where}: ${issue.path.join(".")} — ${issue.message}`);
        return;
      }
      entries.push({ ...r.data, file });
    });
  }
  const ids = new Map<string, string>();
  const byId = new Map<string, Entry>();
  for (const e of entries) {
    byId.set(e.id, e);
    const prev = ids.get(e.id);
    if (prev) errors.push(`Duplicate id ${e.id} in ${prev} and ${e.file}`);
    ids.set(e.id, e.file);
  }
  for (const e of entries) {
    for (const d of e.dependencies ?? []) if (!ids.has(d)) warnings.push(`${e.file} ${e.id}: dependency ${d} does not exist`);
    if (e.disposition === "superseded") {
      if (!e.superseded_by) errors.push(`${e.file} ${e.id}: superseded entries need superseded_by`);
      else if (!ids.has(e.superseded_by)) warnings.push(`${e.file} ${e.id}: superseded_by ${e.superseded_by} does not exist`);
    }
    if (e.disposition === "excluded" && !e.exclusion_reason) errors.push(`${e.file} ${e.id}: excluded entries need exclusion_reason and the user's agreement`);
    if (e.disposition === "deferred" && !e.deferred_reason) errors.push(`${e.file} ${e.id}: deferred entries need deferred_reason (why it is not needed for projection workflows now)`);
    // An entry in the active scope must not rely on a parked capability: un-defer the dependency or drop the edge.
    if (ACTIVE_DISPOSITIONS.includes(e.disposition))
      for (const d of e.dependencies ?? []) {
        const target = byId.get(d);
        if (target?.disposition === "deferred") warnings.push(`${e.file} ${e.id}: active entry depends on deferred ${d}`);
      }
    if ((e.status === "implemented" || e.status === "verified") && (e.evidence?.length ?? 0) === 0) errors.push(`${e.file} ${e.id}: status ${e.status} needs evidence`);
  }
  return { entries, errors, warnings };
};

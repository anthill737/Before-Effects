/**
 * The AI assistant's view of a show, and the tools it can use.
 *
 * The assistant never edits project data directly. Its tools turn plain requests into the same
 * typed operations the visual UI uses ("apply effect", "adjust effect", …), so every change is
 * validated, visible in the normal editors, and undoable. This module is pure: it describes the
 * show, lists what can be done, and resolves the assistant's loose references ("the selected
 * windows", "#3070ff", "all windows") into exact ids and values. The studio executes the tools.
 */
import { z } from "zod";
import type { Id, Project, RegionKind } from "./model.ts";
import type { OpRegistry } from "./ops.ts";
import { defaultParams, getRecipe, listRecipes, resolveTargets, type RecipeDef, type RecipeParamSpec } from "./recipes.ts";
import { rateToFps, timeToSeconds } from "./time.ts";

export interface AssistantContext {
  readonly compId: Id;
  readonly timeSeconds: number;
  readonly selectedRegionIds: readonly Id[];
  readonly selectedEffectId: Id | null;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
export const rgbaToHex = (c: readonly number[]): string => `#${hex2(c[0] ?? 0)}${hex2(c[1] ?? 0)}${hex2(c[2] ?? 0)}`;
export const hexToRgba = (s: string): [number, number, number, number] | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, 1];
};

/** Everyday name for a colour ("blue", "warm white"), for change summaries. */
export const colourName = (c: readonly number[]): string => {
  const [r = 0, g = 0, b = 0] = c;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  if (max < 0.12) return "black";
  if (sat < 0.18) return l > 0.8 ? "white" : l > 0.35 ? "grey" : "dark grey";
  let h = 0;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  const pale = l > 0.75 ? "light " : l < 0.3 ? "dark " : "";
  if (l >= 0.72 && max - min <= 0.55 && h >= 20 && h < 65) return "warm white";
  const names: Array<[number, string]> = [[15, "red"], [40, "orange"], [65, "yellow"], [160, "green"], [195, "teal"], [250, "blue"], [290, "purple"], [335, "pink"], [360, "red"]];
  return pale + names.find(([lim]) => h < lim)![1];
};

const KIND_PLURAL: Record<RegionKind, string> = {
  window: "windows",
  door: "doors",
  garage: "garage doors",
  wall: "walls",
  roof: "roofs",
  vent: "vents",
  light: "light fixtures",
  roofline: "rooflines",
  column: "columns",
  edge: "edges",
  exclusion: "no-light areas",
  custom: "regions",
};

/** Settings as the assistant sees them: colours as hex, everything else as stored. */
const showSettings = (def: RecipeDef | undefined, params: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(params).map(([k, v]) => {
      const spec = def?.params.find((p) => p.key === k);
      return [k, spec?.control === "color" && Array.isArray(v) ? rgbaToHex(v as number[]) : v];
    }),
  );

/** A compact, model-friendly description of the show. Ids are what tools accept. */
export const describeShow = (p: Project, ctx: AssistantContext) => {
  const comp = p.compositions[ctx.compId];
  const venue = p.activeVenueId ? p.venues[p.activeVenueId] : undefined;
  const groupsOf = (rid: Id) => Object.values(venue?.groups ?? {}).filter((g) => g.regionIds.includes(rid)).map((g) => g.name);
  const name = (rid: Id) => venue?.regions[rid]?.name ?? rid;
  const effects = Object.values(p.recipes)
    .filter((r) => r.compId === ctx.compId)
    .map((r) => {
      const def = getRecipe(r.recipeId);
      const parts = resolveTargets(p, r.targets).map((t) => ({ id: t.region.id, name: t.region.name }));
      const params = { ...(def ? defaultParams(def) : {}), ...r.params };
      return {
        id: r.id,
        name: r.label,
        effect: r.recipeId,
        parts,
        starts_at_seconds: round(timeToSeconds(r.startTime)),
        settings: showSettings(def, params),
        hand_edited: Object.keys(r.overrides).length > 0,
      };
    });
  const generated = new Set(Object.values(p.recipes).flatMap((r) => Object.values(r.generated)));
  const layers = comp
    ? comp.layerOrder
        .map((id) => comp.layers[id]!)
        .filter((l) => l && !generated.has(l.id))
        .map((l) => ({
          id: l.id,
          name: l.name,
          kind: l.source.kind,
          visible: l.enabled,
          from_seconds: round(timeToSeconds(l.inPoint)),
          to_seconds: round(timeToSeconds(l.outPoint)),
          ...("assetId" in l.source ? { media: p.assets[l.source.assetId]?.name } : {}),
        }))
    : [];
  return {
    show: comp
      ? { name: p.name, width: comp.width, height: comp.height, fps: round(rateToFps(comp.frameRate), 3), length_seconds: round(timeToSeconds(comp.duration)) }
      : { name: p.name },
    playhead_seconds: round(ctx.timeSeconds),
    selected: {
      parts: ctx.selectedRegionIds.map((id) => ({ id, name: name(id) })),
      effect: ctx.selectedEffectId && p.recipes[ctx.selectedEffectId] ? { id: ctx.selectedEffectId, name: p.recipes[ctx.selectedEffectId]!.label } : null,
    },
    parts: (venue?.regionOrder ?? []).map((id) => venue!.regions[id]!).filter(Boolean).map((r) => ({ id: r.id, name: r.name, kind: r.kind, groups: groupsOf(r.id) })),
    groups: Object.values(venue?.groups ?? {}).map((g) => ({ name: g.name, parts: g.regionIds })),
    effects,
    other_layers: layers,
    media: Object.values(p.assets).map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      ...(a.analysis ? { bpm: round(a.analysis.bpm, 1) } : {}),
      ...(a.missing ? { missing: true } : {}),
    })),
  };
};

const settingDoc = (s: RecipeParamSpec) => ({
  key: s.key,
  label: s.label,
  type: s.control === "color" ? "color (#rrggbb)" : s.control === "media" ? `media id (${(s.accepts ?? []).join("/")})` : s.control,
  default: s.control === "color" && Array.isArray(s.default) ? rgbaToHex(s.default as number[]) : s.default,
  ...(s.min !== undefined ? { min: s.min, max: s.max } : {}),
  ...(s.unit ? { unit: s.unit } : {}),
  ...(s.choices ? { choices: s.choices.map((c) => `${c.value} (${c.label})`) } : {}),
  ...(s.help ? { help: s.help } : {}),
});

/** Every effect the assistant can apply, with its settings. */
export const effectCatalog = () =>
  listRecipes().map((r) => ({
    effect: r.id,
    title: r.title,
    description: r.description,
    suits: r.suits.map((k) => KIND_PLURAL[k]),
    settings: r.params.map(settingDoc),
  }));

/** Every low-level operation, with its JSON Schema, for requests the effects don't cover. */
export const operationCatalog = (registry: OpRegistry) =>
  registry.list().map((d) => {
    let args: unknown;
    try {
      args = z.toJSONSchema(d.args, { unrepresentable: "any" });
    } catch {
      args = { type: "object" };
    }
    return { type: d.type, title: d.title, description: d.description, args };
  });

/**
 * Resolve loose part references to region ids: ids, names (any case), group names, "selected",
 * or a kind such as "windows" / "all windows". Unknown references are reported, never guessed.
 */
export const resolveParts = (p: Project, refs: readonly string[], ctx: AssistantContext): { ids: Id[]; unknown: string[] } => {
  const venue = p.activeVenueId ? p.venues[p.activeVenueId] : undefined;
  if (!venue) return { ids: [], unknown: [...refs] };
  const out: Id[] = [];
  const unknown: string[] = [];
  const add = (ids: readonly Id[]) => ids.forEach((id) => !out.includes(id) && venue.regions[id] && out.push(id));
  for (const raw of refs) {
    const ref = raw.trim();
    const lc = ref.toLowerCase().replace(/^(all|every|the)\s+/, "").trim();
    if (venue.regions[ref]) add([ref]);
    else if (/^(selected|selection|these|this|the selected parts?)$/.test(lc)) add(ctx.selectedRegionIds);
    else {
      const byName = venue.regionOrder.filter((id) => venue.regions[id]!.name.toLowerCase() === lc);
      const group = Object.values(venue.groups).find((g) => g.name.toLowerCase() === lc);
      const kind = (Object.keys(KIND_PLURAL) as RegionKind[]).find((k) => KIND_PLURAL[k] === lc || k === lc);
      if (byName.length) add(byName);
      else if (group) add(group.regionIds);
      else if (kind) add(venue.regionOrder.filter((id) => venue.regions[id]!.kind === kind));
      else unknown.push(raw);
    }
  }
  return { ids: out, unknown };
};

/**
 * Turn the assistant's settings into stored recipe params: hex colours become RGBA, numbers are
 * kept within range, choices are checked. Problems are explained instead of silently ignored.
 */
export const normalizeSettings = (def: RecipeDef, settings: Readonly<Record<string, unknown>> | undefined): { params: Record<string, unknown>; problems: string[] } => {
  const params: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(settings ?? {})) {
    const spec = def.params.find((p) => p.key === key || p.label.toLowerCase() === key.toLowerCase());
    if (!spec) {
      problems.push(`"${def.title}" has no setting "${key}" (settings: ${def.params.map((p) => p.key).join(", ")}).`);
      continue;
    }
    switch (spec.control) {
      case "color": {
        const c = typeof value === "string" ? hexToRgba(value) : Array.isArray(value) && value.length >= 3 && value.every((x) => typeof x === "number") ? [value[0], value[1], value[2], value[3] ?? 1] : null;
        if (c) params[spec.key] = c;
        else problems.push(`${spec.label}: use a colour like "#3070ff".`);
        break;
      }
      case "slider":
      case "seconds":
      case "seed": {
        const n = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(n)) problems.push(`${spec.label}: needs a number.`);
        else {
          const clamped = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, n));
          if (clamped !== n) problems.push(`${spec.label}: ${n} is outside ${spec.min}–${spec.max}; used ${clamped}.`);
          params[spec.key] = clamped;
        }
        break;
      }
      case "choice": {
        const v = String(value);
        const choice = spec.choices?.find((c) => c.value === v || c.label.toLowerCase() === v.toLowerCase());
        if (choice) params[spec.key] = choice.value;
        else problems.push(`${spec.label}: choose one of ${spec.choices?.map((c) => c.value).join(", ")}.`);
        break;
      }
      case "toggle":
        params[spec.key] = value === true || value === "true" || value === "on" || value === 1;
        break;
      default:
        params[spec.key] = value;
    }
  }
  return { params, problems };
};

const partsSchema = {
  type: "array",
  items: { type: "string" },
  description: 'Which parts: part ids or names from get_show, group names, a kind like "windows", or "selected" for the parts the person has selected.',
};
const settingsSchema = {
  type: "object",
  additionalProperties: true,
  description: 'Effect settings by key from list_effects. Colours as "#rrggbb", times in seconds.',
};

/** MCP tool definitions. Descriptions are written for the model; results are JSON text. */
export const ASSISTANT_TOOLS = [
  {
    name: "get_show",
    description:
      "Describe the current show: its parts (windows, doors, rooflines… with ids), groups, applied effects with their settings, other layers, imported media (music with its tempo), what the person has selected, and the playhead. Call this first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_effects",
    description: "List the effects that can be applied, what each does, which parts it suits and every setting with its range and default.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "apply_effect",
    description:
      "Apply an effect to parts of the building. Creates real, editable layers as one undoable step. For music-driven effects (move-with-beat) pass settings.musicId (a media id) or omit it to use the show's music.",
    inputSchema: {
      type: "object",
      properties: {
        effect: { type: "string", description: "Effect id from list_effects, e.g. 'pulse' or 'move-with-beat'." },
        parts: partsSchema,
        settings: settingsSchema,
        start_seconds: { type: "number", description: "When it starts. Defaults to the playhead (or 0 for music-driven effects)." },
        name: { type: "string", description: "Optional short name shown in the timeline." },
      },
      required: ["effect", "parts"],
    },
  },
  {
    name: "change_effect",
    description:
      "Change an applied effect: its settings, which parts it covers, its start time or name. Unchanged settings and the person's hand edits are kept. Use this for follow-ups like 'slower', 'bluer' or 'only these windows'.",
    inputSchema: {
      type: "object",
      properties: {
        effect_id: { type: "string", description: "Id of an applied effect from get_show." },
        settings: settingsSchema,
        parts: partsSchema,
        start_seconds: { type: "number" },
        name: { type: "string" },
      },
      required: ["effect_id"],
    },
  },
  {
    name: "remove_effect",
    description: "Remove an applied effect and the layers it created.",
    inputSchema: { type: "object", properties: { effect_id: { type: "string" } }, required: ["effect_id"] },
  },
  {
    name: "list_operations",
    description: "List the low-level editing operations (layers, keyframes, masks, timing…) with their argument schemas, for requests the effects can't express.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_operations",
    description: "Run low-level operations from list_operations as one undoable step. Times are in flicks (705600000 per second). All succeed or none do.",
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: { type: "object", properties: { type: { type: "string" }, args: { type: "object", additionalProperties: true } }, required: ["type", "args"] },
        },
        label: { type: "string", description: "Short plain description of the change, e.g. 'Fade the music out'." },
      },
      required: ["operations"],
    },
  },
  {
    name: "show_moment",
    description: "Move the playhead so the person sees the result (for example where a new effect starts).",
    inputSchema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
  },
] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number]["name"];

export const ASSISTANT_INSTRUCTIONS = `You are the assistant inside Before Effects, an app for making projection-mapping shows on buildings and objects.
The person describes what they want in everyday words; you make it happen with the tools, then reply briefly.

How to work:
- Call get_show first to see the parts, effects, media and what is selected. Use list_effects to choose an effect and its settings.
- "These", "this", "the selected ones" mean the parts the person has selected (get_show → selected). If nothing is selected, use what they name.
- Prefer apply_effect / change_effect. For follow-ups ("slower", "bluer", "only these windows") change the effect you made last instead of adding a new one.
- Music: "with the music" or "to the beat" means the move-with-beat effect using the show's music. If there is no music, say so and ask them to add it under Add content.
- Only change what was asked. Never remove or alter the person's other work unless they ask.
- Never invent ids; use ids from get_show. If a request is unclear or impossible, ask one short question instead of guessing.
- Finish with one or two plain sentences saying what you changed (no ids, no jargon, no markdown lists).`;

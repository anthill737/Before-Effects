/**
 * Executes the assistant's tool calls in the editor. Every change goes through the same typed
 * operations as the visual UI, grouped into one undo step per request, and is described in plain
 * words for the "What changed" list. Errors come back to the assistant as explanations it can act
 * on (wrong part name, unknown setting, no music yet), never as silent failures.
 */
import {
  type AssistantContext,
  colourName,
  describeShow,
  effectCatalog,
  getRecipe,
  newId,
  normalizeSettings,
  type Op,
  OpError,
  operationCatalog,
  type Project,
  resolveParts,
  secondsToTime,
  snapToFrame,
  timeToSeconds,
} from "@be/core";
import type { AssistantToolCall } from "../../../../shared/api.ts";
import { recipeOpsFor } from "../actions.ts";
import { addAssetLayer, analyseBeats, latestAsset } from "../media.ts";
import { activeVenue, currentComp, useStudio } from "../store.ts";
import { turnById, updateTurn } from "./state.ts";

type Result = { text: string; isError?: boolean };
const ok = (v: unknown): Result => ({ text: JSON.stringify(v) });
const err = (message: string): Result => ({ text: message, isError: true });

let currentRequest = "";
const ctx = (): AssistantContext => {
  const s = useStudio.getState();
  const frozen = turnById(currentRequest)?.selectedRegionIds;
  return { compId: s.compId ?? "", timeSeconds: timeToSeconds(s.time), selectedRegionIds: frozen ?? s.selection.regionIds, selectedEffectId: s.selection.recipeId };
};

const partNames = (p: Project, ids: readonly string[]) => {
  const v = activeVenue({ project: p });
  const names = ids.map((id) => v?.regions[id]?.name ?? id);
  return names.length > 4 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
};

const describeValue = (def: ReturnType<typeof getRecipe>, key: string, v: unknown) => {
  const spec = def?.params.find((x) => x.key === key);
  if (spec?.control === "color" && Array.isArray(v)) return colourName(v as number[]);
  if (spec?.choices) return spec.choices.find((c) => c.value === v)?.label ?? String(v);
  if (typeof v === "number") return `${Math.round(v * 100) / 100}${spec?.control === "seconds" ? " s" : spec?.unit ? ` ${spec.unit}` : ""}`;
  return String(v);
};

/** Apply ops as part of this request's single undo step; returns a plain error message on failure. */
const commit = (requestId: string, ops: Op[], label: string, change: string, effectId?: string): string | null => {
  const s = useStudio.getState();
  const h = s.history;
  if (!h) return "No show is open.";
  const turn = turnById(requestId);
  try {
    const tx = h.apply(ops, { source: "assistant", group: requestId, label: turn ? `Assistant: ${turn.prompt.slice(0, 48)}` : label });
    updateTurn(requestId, (t) => {
      if (!t.txIds.includes(tx.id)) t.txIds.push(tx.id);
      t.changes.push(change);
      if (effectId && !t.effectIds.includes(effectId)) t.effectIds.push(effectId);
    });
    return null;
  } catch (e) {
    return e instanceof OpError ? `${e.userMessage}${e.message !== e.userMessage ? ` (${e.message})` : ""}` : String((e as Error)?.message ?? e);
  }
};

/** Music for "move with the beat": named, or the show's music; added to the timeline and beat-analysed if needed. */
const musicFor = async (requestId: string, wanted?: unknown): Promise<{ id: string } | { error: string }> => {
  const s = useStudio.getState();
  const p = s.project!;
  const comp = currentComp(s)!;
  const inComp = Object.values(comp.layers).flatMap((l) => ((l.source.kind === "audio" || l.source.kind === "footage") && p.assets[l.source.assetId]?.kind === "audio" ? [l.source.assetId] : []));
  const asset = typeof wanted === "string" && p.assets[wanted] ? p.assets[wanted] : (inComp[0] ? p.assets[inComp[0]] : latestAsset(["audio"]));
  if (!asset || asset.kind !== "audio") return { error: "There's no music in this show yet. Tell the person to add music under Add content → Music, then ask again." };
  if (!inComp.includes(asset.id)) addAssetLayer(asset, 0, { source: "assistant", group: requestId, select: false });
  if (!useStudio.getState().project!.assets[asset.id]?.analysis) {
    updateTurn(requestId, (t) => t.steps.push(`Finding the beat of “${asset.name}”`));
    if (!(await analyseBeats(asset))) return { error: `The beat couldn't be found in "${asset.name}".` };
  }
  return { id: asset.id };
};

const applyEffect = async (requestId: string, a: Record<string, unknown>): Promise<Result> => {
  const s = useStudio.getState();
  const p = s.project;
  const comp = currentComp(s);
  if (!p || !comp) return err("No show is open.");
  const def = getRecipe(String(a.effect ?? ""));
  if (!def) return err(`There's no effect "${String(a.effect)}". Call list_effects for the ids.`);
  const refs = Array.isArray(a.parts) ? a.parts.map(String) : ["selected"];
  const { ids, unknown } = resolveParts(p, refs, ctx());
  if (unknown.length) return err(`These parts don't exist: ${unknown.join(", ")}. Use names or ids from get_show.`);
  if (!ids.length) return err(refs.some((r) => /select|these|this/i.test(r)) ? "Nothing is selected in the editor. Ask the person which parts they mean, or name them." : "No parts matched.");
  const { params, problems } = normalizeSettings(def, a.settings as Record<string, unknown> | undefined);
  if (def.params.some((x) => x.key === "musicId")) {
    const m = await musicFor(requestId, params.musicId);
    if ("error" in m) return err(m.error);
    params.musicId = m.id;
  }
  if (def.params.some((x) => x.key === "assetId") && !params.assetId) {
    const media = latestAsset(["image", "video"]);
    if (!media) return err("There's no picture or video in this show yet. Tell the person to add one under Add content.");
    params.assetId = media.id;
  }
  const instanceId = newId("rcp");
  const planned = recipeOpsFor(def.id, ids, instanceId, params);
  if (!planned) return err("That effect couldn't be planned for those parts.");
  const ops = planned.ops.map((o) => (o.type === "recipe.apply" ? { ...o, args: { ...(o.args as object), ...(typeof a.start_seconds === "number" ? { startTime: snapToFrame(secondsToTime(Math.max(0, a.start_seconds)), comp.frameRate) } : {}), ...(a.name ? { label: String(a.name) } : {}) } } : o)) as Op[];
  const colour = params.color ? ` in ${colourName(params.color as number[])}` : "";
  const failed = commit(requestId, ops, def.title, `Added “${a.name ? String(a.name) : def.title}” to ${partNames(p, ids)}${colour}.`, instanceId);
  if (failed) return err(failed);
  const start = (ops.find((o) => o.type === "recipe.apply")!.args as { startTime: number }).startTime;
  useStudio.setState({ selection: { regionIds: [], recipeId: instanceId, layerId: null } });
  return ok({ effect_id: instanceId, effect: def.title, parts: partNames(p, ids), starts_at_seconds: Math.round(timeToSeconds(start) * 100) / 100, ...(problems.length ? { notes: problems } : {}) });
};

const changeEffect = async (requestId: string, a: Record<string, unknown>): Promise<Result> => {
  const s = useStudio.getState();
  const p = s.project;
  const comp = currentComp(s);
  if (!p || !comp) return err("No show is open.");
  const inst = p.recipes[String(a.effect_id ?? "")];
  if (!inst) return err(`There's no applied effect "${String(a.effect_id)}". Use effect ids from get_show.`);
  const def = getRecipe(inst.recipeId);
  if (!def) return err("That effect isn't available in this version.");
  const { params, problems } = normalizeSettings(def, a.settings as Record<string, unknown> | undefined);
  if (params.musicId !== undefined) {
    const m = await musicFor(requestId, params.musicId);
    if ("error" in m) return err(m.error);
    params.musicId = m.id;
  }
  const ops: Op[] = [];
  const said: string[] = [];
  let targets: unknown;
  if (Array.isArray(a.parts)) {
    const { ids, unknown } = resolveParts(p, a.parts.map(String), ctx());
    if (unknown.length) return err(`These parts don't exist: ${unknown.join(", ")}.`);
    if (!ids.length) return err("Nothing is selected in the editor. Ask the person which parts they mean.");
    const planned = recipeOpsFor(def.id, ids, "rcp_probe");
    const setup = planned?.ops.filter((o) => o.type !== "recipe.apply") ?? [];
    targets = (planned?.ops.find((o) => o.type === "recipe.apply")?.args as { targets: unknown }).targets;
    ops.push(...(setup as Op[]));
    said.push(`now on ${partNames(p, ids)}`);
  }
  for (const [k, v] of Object.entries(params)) {
    const label = def.params.find((x) => x.key === k)?.label ?? k;
    const before = inst.params[k] ?? def.params.find((x) => x.key === k)?.default;
    said.push(`${label.toLowerCase()} ${describeValue(def, k, before)} → ${describeValue(def, k, v)}`);
  }
  const startTime = typeof a.start_seconds === "number" ? snapToFrame(secondsToTime(Math.max(0, a.start_seconds)), comp.frameRate) : undefined;
  if (startTime !== undefined) said.push(`starts at ${Math.round(timeToSeconds(startTime) * 10) / 10} s`);
  if (a.name) said.push(`renamed to “${String(a.name)}”`);
  if (!said.length) return err("Nothing to change: pass settings, parts, start_seconds or name.");
  ops.push({ type: "recipe.update", args: { instanceId: inst.id, ...(Object.keys(params).length ? { params } : {}), ...(targets ? { targets } : {}), ...(startTime !== undefined ? { startTime } : {}), ...(a.name ? { label: String(a.name) } : {}) } });
  const failed = commit(requestId, ops, "Adjust effect", `Changed “${inst.label}”: ${said.join(", ")}.`, inst.id);
  if (failed) return err(failed);
  useStudio.setState({ selection: { regionIds: [], recipeId: inst.id, layerId: null } });
  const now = useStudio.getState().project!.recipes[inst.id]!;
  return ok({ effect_id: inst.id, changed: said, settings_now: Object.fromEntries(Object.entries(now.params).map(([k, v]) => [k, describeValue(def, k, v)])), ...(problems.length ? { notes: problems } : {}) });
};

const removeEffect = (requestId: string, a: Record<string, unknown>): Result => {
  const p = useStudio.getState().project;
  const inst = p?.recipes[String(a.effect_id ?? "")];
  if (!inst) return err(`There's no applied effect "${String(a.effect_id)}".`);
  const failed = commit(requestId, [{ type: "recipe.remove", args: { instanceId: inst.id } }], "Remove effect", `Removed “${inst.label}”.`);
  return failed ? err(failed) : ok({ removed: inst.label });
};

const runOperations = (requestId: string, a: Record<string, unknown>): Result => {
  const ops = Array.isArray(a.operations) ? (a.operations as Op[]) : [];
  if (!ops.length) return err("Pass operations: [{ type, args }].");
  const h = useStudio.getState().history;
  const unknownType = ops.find((o) => !h?.registry.has(String(o?.type)));
  if (unknownType) return err(`Unknown operation "${String(unknownType?.type)}". Call list_operations.`);
  const label = a.label ? String(a.label) : `${ops.length} detailed change${ops.length > 1 ? "s" : ""}`;
  const failed = commit(requestId, ops, label, `${label}.`);
  return failed ? err(failed) : ok({ applied: ops.length });
};

export const executeTool = async (call: AssistantToolCall): Promise<Result> => {
  const s = useStudio.getState();
  if (!s.project || !s.compId) return err("No show is open in Before Effects.");
  const a = call.args ?? {};
  currentRequest = call.requestId;
  try {
    switch (call.name) {
      case "get_show":
        return ok(describeShow(s.project, ctx()));
      case "list_effects":
        return ok(effectCatalog());
      case "list_operations":
        return ok(operationCatalog(s.history!.registry));
      case "apply_effect":
        return await applyEffect(call.requestId, a);
      case "change_effect":
        return await changeEffect(call.requestId, a);
      case "remove_effect":
        return removeEffect(call.requestId, a);
      case "run_operations":
        return runOperations(call.requestId, a);
      case "show_moment": {
        const sec = Number(a.seconds);
        if (!Number.isFinite(sec)) return err("Pass seconds.");
        s.setTime(secondsToTime(sec));
        return ok({ playhead_seconds: sec });
      }
      default:
        return err(`Unknown tool ${call.name}.`);
    }
  } catch (e) {
    return err(e instanceof OpError ? e.userMessage : String((e as Error)?.message ?? e));
  }
};

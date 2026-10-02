/**
 * External-agent API, editor side: a registry of methods with validated parameters, executed
 * through the same store and operations as the visual UI.
 *
 * Every call:
 *   - is validated against its schema (published by api.capabilities as JSON Schema);
 *   - may carry `expectRevision`: if the show changed since then (a manual edit, another agent),
 *     the call is refused with `conflict` and the changes since, instead of overwriting them;
 *   - runs its edits as ONE undo step marked as the agent's ("Agent: …"); if anything fails, every
 *     edit it made is rolled back, so a failed call never leaves partial changes;
 *   - returns the new revision. Revisions increase on every change (UI, agent, undo, open).
 *
 * `transaction` runs several method calls atomically as one undo step.
 */
import { OpError } from "@be/core";
import { z } from "zod";
import type { AgentCall, AgentCallResult } from "../../../shared/api.ts";
import { create } from "zustand";
import { type AgentScope, inAgentScope, useStudio } from "../studio/store.ts";

/** The latest agent change, shown on the Agents button (no pop-ups over the workspace). */
export const useAgentActivity = create<{ label: string; at: number; count: number }>(() => ({ label: "", at: 0, count: 0 }));

export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface MethodContext {
  readonly requestId: string;
  /** Run synchronous editing code as part of this call (grouped, rolled back on failure). */
  edit<T>(fn: () => T): T;
  note(text: string): void;
}

interface MethodDef {
  readonly name: string;
  readonly summary: string;
  readonly params: z.ZodType;
  readonly mutates: boolean;
  /** Long-running methods (waits, imports, exports) can't be part of a transaction. */
  readonly long?: boolean;
  readonly example?: unknown;
  readonly run: (params: never, ctx: MethodContext) => unknown;
}

const methods = new Map<string, MethodDef>();

export const method = <S extends z.ZodType>(def: { name: string; summary: string; params: S; mutates?: boolean; long?: boolean; example?: unknown; run: (params: z.infer<S>, ctx: MethodContext) => unknown }) => {
  methods.set(def.name, { ...def, mutates: def.mutates ?? false } as unknown as MethodDef);
};

// ---- revisions ---------------------------------------------------------------------------------

export interface RevisionEntry {
  readonly revision: number;
  readonly label: string;
  readonly source: string;
  readonly at: string;
}
let revision = 0;
const revLog: RevisionEntry[] = [];
export const currentRevision = () => revision;

let started = false;
/** Track revisions and forward editor events to connected agents. Call once in the editor window. */
export const startAgentHost = (): (() => void) => {
  if (started) return () => undefined;
  started = true;
  const offStore = useStudio.subscribe((s, prev) => {
    if (s.version !== prev.version || s.history !== prev.history) {
      revision++;
      const tx = (s as unknown as { lastTx?: { label: string; source: string } | null }).lastTx;
      const opened = s.history !== prev.history;
      const entry: RevisionEntry = { revision, label: opened ? "Opened a show" : (tx?.label ?? "Change"), source: opened ? "system" : (tx?.source ?? "user"), at: new Date().toISOString() };
      revLog.push(entry);
      if (revLog.length > 1000) revLog.splice(0, revLog.length - 1000);
      window.be.agent.event("revision", { ...entry, dirty: s.dirty, scene: s.compId });
    }
    if (s.selection !== prev.selection) window.be.agent.event("selection", { regionIds: s.selection.regionIds, effectId: s.selection.recipeId, layerId: s.selection.layerId });
    if (s.compId !== prev.compId) window.be.agent.event("scene", { sceneId: s.compId });
    if (s.filePath !== prev.filePath || s.savedAt !== prev.savedAt) window.be.agent.event("project", { path: s.filePath, savedAt: s.savedAt, dirty: s.dirty });
  });
  const offCalls = window.be.agent.onCall(dispatch);
  window.be.agent.event("ready", { editor: true });
  return () => {
    offStore();
    offCalls();
    started = false;
  };
};

// ---- dispatch ----------------------------------------------------------------------------------

const describeError = (e: unknown): { code: string; message: string; details?: unknown } => {
  if (e instanceof AgentError) return { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) };
  if (e instanceof OpError) return { code: "rejected", message: e.userMessage, ...(e.message !== e.userMessage ? { details: e.message } : {}) };
  return { code: "internal", message: String((e as Error)?.message ?? e) };
};

/** Undo everything a failed call did (also when the person edited in between). */
const rollback = (scope: AgentScope) => {
  const h = useStudio.getState().history;
  if (!h || !scope.txIds.length) return;
  const stack = h.transactions();
  const ours = new Set(scope.txIds.filter((id) => stack.some((t) => t.id === id)));
  if (!ours.size) return;
  let n = 0;
  for (let i = stack.length - 1; i >= 0 && ours.has(stack[i]!.id); i--) n++;
  if (n === ours.size) for (let i = 0; i < n; i++) h.undo();
  else h.revert([...ours], "Undo a failed agent change");
};

const validate = (def: MethodDef, raw: unknown): unknown => {
  const r = def.params.safeParse(raw ?? {});
  if (!r.success)
    throw new AgentError(
      "invalid_params",
      `"${def.name}" received parameters it can't use: ${r.error.issues.map((i) => `${i.path.join(".") || "(params)"}: ${i.message}`).join("; ")}. Call api.capabilities for its schema.`,
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  return r.data;
};

const runOne = async (def: MethodDef, params: unknown, ctx: MethodContext) => {
  if (def.mutates && !useStudio.getState().history && !["project.open", "project.newFromPhoto"].includes(def.name)) throw new AgentError("no_project", "No show is open. Open one with project.open or create one with project.newFromPhoto.");
  return await def.run(params as never, ctx);
};

export const dispatch = async (call: AgentCall): Promise<AgentCallResult> => {
  const def = methods.get(call.method);
  if (!def) {
    const near = [...methods.keys()].filter((m) => m.split(".")[0] === call.method.split(".")[0]);
    return { ok: false, error: { code: "unknown_method", message: `There's no method "${call.method}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Call api.capabilities for the list.` }, revision };
  }
  const raw = (call.params ?? {}) as Record<string, unknown>;
  const { expectRevision, ...params } = raw;
  const scope: AgentScope = { group: `agent:${call.requestId}`, errors: [], notes: [], txIds: [] };
  const ctx: MethodContext = {
    requestId: call.requestId,
    edit: (fn) => {
      const before = scope.errors.length;
      const out = inAgentScope(scope, fn);
      if (scope.errors.length > before) throw new AgentError("rejected", scope.errors.slice(before).join(" "));
      return out;
    },
    note: (t) => scope.notes.push(t),
  };
  try {
    if (def.mutates && expectRevision !== undefined && Number(expectRevision) !== revision) {
      throw new AgentError("conflict", `The show changed since revision ${String(expectRevision)} (now ${revision}). Inspect it again, then retry with the new revision.`, {
        currentRevision: revision,
        changesSince: revLog.filter((e) => e.revision > Number(expectRevision)).slice(-20),
      });
    }
    const result = await runOne(def, validate(def, params), ctx);
    if (scope.errors.length) throw new AgentError("rejected", scope.errors.join(" "));
    if (scope.txIds.length) {
      const h = useStudio.getState().history;
      const tx = h?.transactions().find((t) => t.id === scope.txIds.at(-1));
      // Show what an external agent just did on the Agents button (the edit is undoable like any other).
      if (tx) useAgentActivity.setState((a) => ({ label: tx.label, at: Date.now(), count: a.count + 1 }));
    }
    return { ok: true, result: result ?? null, revision, ...(scope.notes.length ? { notes: scope.notes } : {}) } as AgentCallResult;
  } catch (e) {
    rollback(scope);
    return { ok: false, error: describeError(e), revision };
  }
};

// ---- built-in methods ------------------------------------------------------------------------------

method({
  name: "api.capabilities",
  summary: "Every method with its parameter schema, the request envelope, and event types.",
  params: z.object({}),
  run: () => ({
    api: 1,
    revision,
    envelope: {
      call: 'POST /v1/call with { "method": "...", "params": {...}, "requestId": "unique-per-change" }. Reusing a requestId returns the first result (safe retries).',
      expectRevision: "Optional on any changing method: refuse with code 'conflict' if the show changed since that revision.",
      errors: "invalid_params, unknown_method, no_project, not_found, conflict, rejected, timeout, unavailable, internal. A failed call changes nothing.",
      undo: "Each changing call is one undo step in the editor, labelled 'Agent: …'. history.undo undoes the latest step (any source).",
      units: "Times are seconds; canvas positions are pixels of the venue canvas (origin top-left); 3D positions are metres (x right, y up, z toward the audience).",
    },
    events: {
      stream: "GET /v1/events (Server-Sent Events; Last-Event-ID or ?after=N to resume)",
      poll: "POST /v1/events/poll { after, timeoutMs } or method events.poll",
      types: ["revision", "selection", "scene", "project", "jobs", "preparation", "api"],
    },
    methods: [...methods.values()].map((m) => {
      let schema: unknown;
      try {
        schema = z.toJSONSchema(m.params, { unrepresentable: "any" });
      } catch {
        schema = { type: "object" };
      }
      return { name: m.name, summary: m.summary, changes: m.mutates, ...(m.long ? { long: true } : {}), params: schema, ...(m.example !== undefined ? { example: m.example } : {}) };
    }),
  }),
});

method({
  name: "transaction",
  summary: "Run several method calls atomically as one undo step. If any step fails, none of them are applied.",
  params: z.object({ label: z.string().optional(), steps: z.array(z.object({ method: z.string(), params: z.record(z.string(), z.unknown()).optional() })).min(1).max(200) }),
  mutates: true,
  example: { steps: [{ method: "areas.create", params: { kind: "window", rect: { x: 100, y: 100, w: 200, h: 150 } } }, { method: "content.assign", params: { asset: "clip.mp4", areas: ["Window 1"] } }] },
  run: async (p, ctx) => {
    const results: unknown[] = [];
    for (const [i, step] of p.steps.entries()) {
      const def = methods.get(step.method);
      if (!def) throw new AgentError("unknown_method", `Step ${i + 1}: there's no method "${step.method}".`);
      if (def.long || def.name === "transaction") throw new AgentError("invalid_params", `Step ${i + 1}: "${step.method}" can't be part of a transaction.`);
      try {
        results.push(await runOne(def, validate(def, step.params ?? {}), ctx));
      } catch (e) {
        const d = describeError(e);
        throw new AgentError(d.code, `Step ${i + 1} (${step.method}) failed, so nothing was changed: ${d.message}`, d.details);
      }
    }
    return { steps: results };
  },
});

method({
  name: "history.changes",
  summary: "Recent changes with their revisions and sources (user, agent, assistant, system).",
  params: z.object({ since: z.number().int().optional() }),
  run: (p) => ({ revision, changes: revLog.filter((e) => p.since === undefined || e.revision > p.since).slice(-100) }),
});

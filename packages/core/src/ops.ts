/**
 * The operation system: the single way the project changes.
 *
 * The guided UI, the detailed editors, recipes, scripts and the AI assistant all submit operations,
 * so undo/redo, autosave journaling, change summaries and the assistant's scope limits behave the
 * same for all of them.
 *
 *   - An operation is { type, args }. Args are validated with a Zod schema, which also yields the
 *     JSON Schema exposed to AI tools.
 *   - A transaction applies one or more operations atomically with Immer and records forward and
 *     inverse patches. Undo/redo replays patches, so they are exact and cheap.
 *   - Editing a recipe-generated layer by hand records an override on the recipe instance. Changing
 *     the recipe's simple controls later preserves the custom edit instead of silently overwriting it.
 */
import { type Draft, enablePatches, type Patch, produceWithPatches, applyPatches } from "immer";
import type { z } from "zod";
import type { Id, Project } from "./model.ts";

enablePatches();

export type OpSource = "user" | "recipe" | "assistant" | "script" | "system";

export class OpError extends Error {
  /** Plain-language message for the person, naming the affected item and what to do. */
  readonly userMessage: string;
  constructor(userMessage: string, details?: string) {
    super(details ? `${userMessage} (${details})` : userMessage);
    this.userMessage = userMessage;
  }
}

export interface OpDef<A = any> {
  readonly type: string;
  /** Short plain-language title, e.g. "Change opacity". */
  readonly title: string;
  /** What the op does, written for both people and AI tool descriptions. */
  readonly description: string;
  readonly args: z.ZodType<A>;
  readonly apply: (draft: Draft<Project>, args: A, ctx: ApplyContext) => void;
  /** One-line plain-language summary of a concrete call, used in change summaries. */
  readonly summarize?: (args: A, before: Project) => string;
}

export interface ApplyContext {
  readonly registry: OpRegistry;
  readonly source: OpSource;
  /** Apply another op inside the same transaction (for composite ops such as recipes). */
  readonly sub: (op: Op) => void;
  /** Ops that edit a layer property call this so hand edits to generated layers become overrides. */
  readonly noteLayerEdit: (compId: Id, layerId: Id, path: string) => void;
}

export interface Op<A = unknown> {
  readonly type: string;
  readonly args: A;
}

export const defineOp = <A>(def: OpDef<A>): OpDef<A> => def;

export class OpRegistry {
  private readonly defs = new Map<string, OpDef>();
  register(...defs: OpDef[]): this {
    for (const d of defs) {
      if (this.defs.has(d.type)) throw new Error(`Duplicate op type ${d.type}`);
      this.defs.set(d.type, d);
    }
    return this;
  }
  get(type: string): OpDef {
    const d = this.defs.get(type);
    if (!d) throw new OpError(`Unknown action "${type}".`);
    return d;
  }
  has(type: string): boolean {
    return this.defs.has(type);
  }
  list(): OpDef[] {
    return [...this.defs.values()];
  }
}

export interface Transaction {
  readonly id: string;
  readonly label: string;
  readonly source: OpSource;
  readonly ops: readonly Op[];
  readonly patches: readonly Patch[];
  readonly inversePatches: readonly Patch[];
  readonly summary: readonly string[];
  readonly at: number;
  readonly coalesceKey?: string;
  /** Transactions with the same group (e.g. one assistant request) form one undo step when adjacent. */
  readonly group?: string;
}

export interface ApplyOptions {
  readonly label?: string;
  readonly source?: OpSource;
  /** Consecutive transactions with the same key (e.g. one drag gesture) merge into one undo step. */
  readonly coalesceKey?: string;
  /** Like coalesceKey without the time limit: adjacent transactions of one group (an assistant request) merge. */
  readonly group?: string;
}

/** Apply ops to a project without recording history. Throws OpError on invalid args or state. */
export const applyOps = (
  project: Project,
  ops: readonly Op[],
  registry: OpRegistry,
  source: OpSource = "user",
): { project: Project; patches: Patch[]; inversePatches: Patch[]; summary: string[] } => {
  const summary: string[] = [];
  const edits: Array<{ compId: Id; layerId: Id; path: string }> = [];
  const [next, patches, inversePatches] = produceWithPatches(project, (draft) => {
    const ctx: ApplyContext = {
      registry,
      source,
      sub: (op) => run(op),
      noteLayerEdit: (compId, layerId, path) => {
        if (source !== "recipe") edits.push({ compId, layerId, path });
      },
    };
    const run = (op: Op) => {
      const def = registry.get(op.type);
      const parsed = def.args.safeParse(op.args);
      if (!parsed.success) {
        throw new OpError(
          `"${def.title}" received settings it can't use.`,
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      }
      if (def.summarize) summary.push(def.summarize(parsed.data, project));
      def.apply(draft, parsed.data, ctx);
    };
    for (const op of ops) run(op);
    recordOverrides(draft, edits);
  });
  return { project: next, patches, inversePatches, summary };
};

/**
 * Remember which properties of recipe-generated layers were changed by hand, inside the same
 * transaction so undo removes the override together with the edit.
 */
const recordOverrides = (draft: Draft<Project>, edits: ReadonlyArray<{ compId: Id; layerId: Id; path: string }>) => {
  for (const { compId, layerId, path } of edits) {
    const gen = draft.compositions[compId]?.layers[layerId]?.generatedBy;
    if (!gen) continue;
    const recipe = draft.recipes[gen.recipeInstanceId];
    if (!recipe) continue;
    const current = recipe.overrides[layerId] ?? [];
    if (!current.includes(path)) recipe.overrides[layerId] = [...current, path];
  }
};

type Listener = (project: Project, tx: Transaction | null) => void;

/** Undoable editing session over one project. */
export class History {
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];
  private listeners = new Set<Listener>();
  private txCounter = 0;
  /** Monotonic version, bumped on every change; used for "saved" tracking and cache keys. */
  version = 0;
  savedVersion = 0;

  constructor(
    private current: Project,
    readonly registry: OpRegistry,
    private readonly limit = 500,
  ) {}

  get project(): Project {
    return this.current;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get isDirty(): boolean {
    return this.version !== this.savedVersion;
  }
  get undoLabel(): string | undefined {
    return this.undoStack.at(-1)?.label;
  }
  get redoLabel(): string | undefined {
    return this.redoStack.at(-1)?.label;
  }
  transactions(): readonly Transaction[] {
    return this.undoStack;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Compute the result of ops without committing — for reversible previews. */
  preview(ops: Op | readonly Op[], source: OpSource = "user"): Project {
    return applyOps(this.current, Array.isArray(ops) ? ops : [ops as Op], this.registry, source).project;
  }

  apply(ops: Op | readonly Op[], opts: ApplyOptions = {}): Transaction {
    const list = Array.isArray(ops) ? (ops as readonly Op[]) : [ops as Op];
    const source = opts.source ?? "user";
    const { project, patches, inversePatches, summary } = applyOps(this.current, list, this.registry, source);
    const label = opts.label ?? (list.length === 1 ? this.registry.get(list[0]!.type).title : `${list.length} changes`);
    const prev = this.undoStack.at(-1);
    let tx: Transaction;
    const coalesce = !!prev && ((!!opts.coalesceKey && prev.coalesceKey === opts.coalesceKey && Date.now() - prev.at < 2000) || (!!opts.group && prev.group === opts.group));
    if (prev && coalesce) {
      tx = {
        ...prev,
        ops: [...prev.ops, ...list],
        patches: [...prev.patches, ...patches],
        inversePatches: [...inversePatches, ...prev.inversePatches],
        summary: opts.group ? [...prev.summary, ...summary] : prev.summary,
        at: Date.now(),
      };
      this.undoStack[this.undoStack.length - 1] = tx;
    } else {
      tx = {
        id: `tx${++this.txCounter}`,
        label,
        source,
        ops: list,
        patches,
        inversePatches,
        summary,
        at: Date.now(),
        ...(opts.coalesceKey ? { coalesceKey: opts.coalesceKey } : {}),
        ...(opts.group ? { group: opts.group } : {}),
      };
      this.undoStack.push(tx);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
    this.current = project;
    this.version++;
    this.emit(tx);
    return tx;
  }

  undo(): Transaction | null {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    this.current = applyPatches(this.current, tx.inversePatches as Patch[]);
    this.redoStack.push(tx);
    this.version++;
    this.emit(tx);
    return tx;
  }

  redo(): Transaction | null {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    this.current = applyPatches(this.current, tx.patches as Patch[]);
    this.undoStack.push(tx);
    this.version++;
    this.emit(tx);
    return tx;
  }

  /**
   * Undo earlier transactions while keeping everything done after them: the later transactions'
   * operations are replayed on top (operations carry their own ids, so replay is exact). Recorded
   * as one new undoable step. If a later change depended on what is being undone, nothing changes
   * and an OpError explains why.
   */
  revert(txIds: readonly string[], label = "Undo change"): Transaction {
    const ids = new Set(txIds);
    const first = this.undoStack.findIndex((t) => ids.has(t.id));
    if (first < 0) throw new OpError("That change is no longer in the undo history.");
    const tail = this.undoStack.slice(first);
    let base = this.current;
    for (let i = tail.length - 1; i >= 0; i--) base = applyPatches(base, tail[i]!.inversePatches as Patch[]);
    let replayed = base;
    for (const t of tail) {
      if (ids.has(t.id)) continue;
      if (t.ops.length === 0) throw new OpError(`This can't be undone on its own because of a later step ("${t.label}"). Use Undo instead.`);
      try {
        replayed = applyOps(replayed, t.ops, this.registry, t.source).project;
      } catch (e) {
        throw new OpError(`This can't be undone on its own because a later change ("${t.label}") builds on it. Use Undo instead.`, String((e as Error).message ?? e));
      }
    }
    const before = this.current;
    const [project, patches, inversePatches] = produceWithPatches(before, () => replayed as Draft<Project>);
    const tx: Transaction = { id: `tx${++this.txCounter}`, label, source: "user", ops: [], patches, inversePatches, summary: [label], at: Date.now() };
    this.undoStack.push(tx);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.current = project;
    this.version++;
    this.emit(tx);
    return tx;
  }

  /** Replace the whole project (open/recover). Clears history. */
  reset(project: Project): void {
    this.current = project;
    this.undoStack = [];
    this.redoStack = [];
    this.version++;
    this.savedVersion = this.version;
    this.emit(null);
  }

  markSaved(): void {
    this.savedVersion = this.version;
    this.emit(null);
  }

  private emit(tx: Transaction | null) {
    for (const fn of this.listeners) fn(this.current, tx);
  }
}

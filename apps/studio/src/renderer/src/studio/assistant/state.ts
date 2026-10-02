/**
 * Assistant conversation state: which subscription to use, the requests made so far, what each
 * one changed (as plain sentences and as undo-history transactions), and plan usage.
 *
 * Each request is one undo step. "Undo" on an older request removes only that request's changes
 * and keeps everything done since (History.revert replays later edits).
 */
import { OpError } from "@be/core";
import { create } from "zustand";
import type { AssistantProviderStatus, AssistantUsage } from "../../../../shared/api.ts";
import { activeVenue, useStudio } from "../store.ts";

export type ProviderId = "claude" | "codex" | "test";

export interface AssistantTurn {
  readonly id: string;
  readonly prompt: string;
  readonly provider: ProviderId;
  /** The parts selected when the request was sent ("these windows"). */
  readonly selectedRegionIds: readonly string[];
  status: "working" | "done" | "failed";
  steps: string[];
  reply: string;
  error?: string;
  detail?: string;
  changes: string[];
  txIds: string[];
  /** Effects this request created or changed (context for follow-ups). */
  effectIds: string[];
  undone: boolean;
  /** The step that undid this request selectively (Ctrl+Z on it brings the changes back). */
  revertTxId?: string;
}

interface AssistantState {
  open: boolean;
  provider: ProviderId | null;
  providers: AssistantProviderStatus[] | null;
  checking: boolean;
  sessions: Partial<Record<ProviderId, string>>;
  turns: AssistantTurn[];
  usage: AssistantUsage | null;
  model: string | null;
}

export const useAssistant = create<AssistantState>(() => ({
  open: false,
  provider: null,
  providers: null,
  checking: false,
  sessions: {},
  turns: [],
  usage: null,
  model: null,
}));

export const updateTurn = (id: string, fn: (t: AssistantTurn) => void) =>
  useAssistant.setState((s) => ({
    turns: s.turns.map((t) => {
      if (t.id !== id) return t;
      const copy = { ...t, steps: [...t.steps], changes: [...t.changes], txIds: [...t.txIds], effectIds: [...t.effectIds] };
      fn(copy);
      return copy;
    }),
  }));

export const turnById = (id: string) => useAssistant.getState().turns.find((t) => t.id === id);

export const checkProviders = async (refresh = false) => {
  useAssistant.setState({ checking: true });
  try {
    const providers = await window.be.assistant.status(refresh);
    const cur = useAssistant.getState().provider;
    const keep = cur && (cur === "test" || providers.find((p) => p.id === cur)?.ready);
    useAssistant.setState({ providers, provider: keep ? cur : (providers.find((p) => p.ready)?.id ?? null) });
  } finally {
    useAssistant.setState({ checking: false });
  }
};

export const newConversation = () => useAssistant.setState({ sessions: {}, turns: [] });

/** Is any of this request's change still in the project (not undone by Undo or Ctrl+Z)? */
export const turnApplied = (t: AssistantTurn): boolean => {
  const h = useStudio.getState().history;
  if (!h) return false;
  const stack = h.transactions();
  return t.txIds.some((id) => stack.some((x) => x.id === id)) && !(t.revertTxId && stack.some((x) => x.id === t.revertTxId));
};

export const undoTurn = (t: AssistantTurn) => {
  const s = useStudio.getState();
  const h = s.history;
  if (!h) return;
  const stack = h.transactions();
  const ids = t.txIds.filter((id) => stack.some((x) => x.id === id));
  if (!ids.length || !turnApplied(t)) return;
  try {
    if (ids.length === 1 && stack.at(-1)?.id === ids[0]) {
      h.undo();
      updateTurn(t.id, (x) => (x.undone = true));
    } else {
      const tx = h.revert(ids, `Undo assistant: ${t.prompt.slice(0, 40)}`);
      updateTurn(t.id, (x) => {
        x.undone = true;
        x.revertTxId = tx.id;
      });
    }
    s.toast({ kind: "info", text: "Undid the assistant's changes. Everything else you did is kept." });
  } catch (e) {
    s.toast({ kind: "error", text: e instanceof OpError ? e.userMessage : "Those changes couldn't be undone on their own. Use Undo in the top bar instead." });
  }
};

/** What the person is looking at right now, sent with each request so "these" and "slower" make sense. */
export const editorContext = (): string => {
  const s = useStudio.getState();
  const p = s.project;
  if (!p) return "";
  const venue = activeVenue({ project: p });
  const names = s.selection.regionIds.map((id) => `${venue?.regions[id]?.name ?? id} (${id})`);
  const sel = s.selection.recipeId ? p.recipes[s.selection.recipeId] : undefined;
  const recent = [...useAssistant.getState().turns]
    .reverse()
    .filter((t) => turnApplied(t) || t.status === "working")
    .flatMap((t) => t.effectIds)
    .filter((id, i, a) => a.indexOf(id) === i && p.recipes[id])
    .slice(0, 4)
    .map((id) => `"${p.recipes[id]!.label}" (${id})`);
  return [
    `Selected parts: ${names.length ? names.join(", ") : "none"}`,
    ...(sel ? [`Selected effect: "${sel.label}" (${sel.id})`] : []),
    `Playhead: ${(s.time / 705_600_000).toFixed(1)} s`,
    ...(recent.length ? [`Effects you made or changed earlier in this conversation (newest first): ${recent.join(", ")}`] : []),
  ].join("\n");
};

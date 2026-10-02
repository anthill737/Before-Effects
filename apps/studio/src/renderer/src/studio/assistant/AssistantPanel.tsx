/**
 * The assistant: describe a change in everyday words; it is made with the same editable effects
 * and controls as the visual tools, listed under "What changed", and undoable as one step.
 * Runs on the person's own Claude or ChatGPT subscription (no API keys). Everything it does can
 * also be done without it.
 */
import { newId } from "@be/core";
import { useEffect, useRef, useState } from "react";
import type { AssistantEvent } from "../../../../shared/api.ts";
import { activeVenue, useStudio } from "../store.ts";
import { type AssistantTurn, checkProviders, editorContext, newConversation, type ProviderId, turnApplied, undoTurn, updateTurn, useAssistant } from "./state.ts";
import { executeTool } from "./tools.ts";

const EXAMPLES = ["Make these windows pulse blue with the music", "Slower", "Only the selected windows", "Trace the roofline with warm light", "Make the doors glow red after 5 seconds"];

/** Listen for assistant events and tool calls for the lifetime of the editor. */
export const startAssistant = (): (() => void) => {
  let projectId = useStudio.getState().project?.id;
  const offProject = useStudio.subscribe((s) => {
    if (s.project?.id !== projectId) {
      projectId = s.project?.id;
      newConversation();
    }
  });
  const offTool = window.be.assistant.onToolCall(executeTool);
  const offEvent = window.be.assistant.onEvent((e: AssistantEvent) => {
    const provider = useAssistant.getState().turns.find((t) => t.id === e.requestId)?.provider;
    const remember = (sessionId?: string) => {
      if (sessionId && provider) useAssistant.setState((s) => ({ sessions: { ...s.sessions, [provider]: sessionId } }));
    };
    switch (e.kind) {
      case "started":
        remember(e.sessionId);
        if (e.model) useAssistant.setState({ model: e.model });
        break;
      case "tool":
        updateTurn(e.requestId, (t) => {
          if (t.steps.at(-1) !== e.text) t.steps.push(e.text);
        });
        break;
      case "text":
        updateTurn(e.requestId, (t) => (t.reply = e.text));
        break;
      case "usage":
        useAssistant.setState({ usage: e.usage });
        break;
      case "done":
        remember(e.sessionId);
        updateTurn(e.requestId, (t) => {
          t.status = "done";
          if (e.reply) t.reply = e.reply;
        });
        break;
      case "failed":
        remember(e.sessionId);
        updateTurn(e.requestId, (t) => {
          t.status = "failed";
          t.error = e.message;
          if (e.detail) t.detail = e.detail;
        });
        break;
    }
  });
  return () => {
    offProject();
    offTool();
    offEvent();
  };
};

export const sendRequest = async (prompt: string, script?: ReadonlyArray<{ call?: string; args?: Record<string, unknown>; say?: string; wait?: number }>): Promise<string | null> => {
  const a = useAssistant.getState();
  const provider = a.provider;
  const text = prompt.trim();
  if (!provider || !text || a.turns.some((t) => t.status === "working")) return null;
  const s = useStudio.getState();
  const requestId = newId("req");
  const context = editorContext();
  const turn: AssistantTurn = { id: requestId, prompt: text, provider, selectedRegionIds: [...s.selection.regionIds], status: "working", steps: [], reply: "", changes: [], txIds: [], effectIds: [], undone: false };
  useAssistant.setState({ turns: [...a.turns, turn] });
  try {
    await window.be.assistant.run({
      requestId,
      provider,
      prompt: `${text}\n\n[What the person is looking at in the editor right now, for reference]\n${context}`,
      ...(a.sessions[provider] ? { sessionId: a.sessions[provider] } : {}),
      ...(script ? { script } : {}),
    });
  } catch (e) {
    updateTurn(requestId, (t) => {
      t.status = "failed";
      t.error = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    });
  }
  return requestId;
};

const showTurn = (t: AssistantTurn) => {
  const s = useStudio.getState();
  const id = t.effectIds.at(-1);
  const inst = id ? s.project?.recipes[id] : undefined;
  if (!inst) return;
  useStudio.setState({ selection: { regionIds: [], recipeId: inst.id, layerId: null }, time: inst.startTime, playing: true });
};

const Turn = ({ t }: { t: AssistantTurn }) => {
  useStudio((s) => s.version); // re-check "applied" when the undo history changes
  const applied = turnApplied(t);
  return (
    <div className={`a-turn ${t.status}`}>
      <div className="a-you">{t.prompt}</div>
      <div className="a-reply">
        {t.status === "working" && (
          <ul className="a-steps" aria-live="polite">
            {(t.steps.length ? t.steps : ["Thinking"]).map((x, i, all) => (
              <li key={i} className={i === all.length - 1 ? "now" : "done"}>
                {x}
                {i === all.length - 1 ? "…" : ""}
              </li>
            ))}
          </ul>
        )}
        {t.changes.length > 0 && (
          <div className={`a-changes ${applied ? "" : "undone"}`}>
            <div className="a-changes-head">
              <strong>What changed</strong>
              {applied ? (
                <>
                  {t.effectIds.length > 0 && (
                    <button className="link small" onClick={() => showTurn(t)}>
                      Show
                    </button>
                  )}
                  {t.status !== "working" && (
                    <button className="link small" onClick={() => undoTurn(t)} title="Undo just these changes; everything else stays">
                      Undo
                    </button>
                  )}
                </>
              ) : (
                <span className="muted small">undone</span>
              )}
            </div>
            <ul>
              {t.changes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        {t.reply && t.status !== "failed" && <p className="a-text">{t.reply}</p>}
        {t.status === "done" && t.changes.length === 0 && !t.reply && <p className="muted small">Nothing was changed.</p>}
        {t.status === "failed" && (
          <div className="a-error">
            <p>{t.error}</p>
            {t.changes.length > 0 && <p className="muted small">The changes listed above were made before it stopped.</p>}
            {t.detail && (
              <details>
                <summary>Details</summary>
                <pre>{t.detail}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const Setup = () => {
  const { providers, checking } = useAssistant();
  return (
    <div className="a-setup">
      <p>
        The assistant uses the <strong>Claude</strong> or <strong>ChatGPT</strong> subscription you already have, through their official apps on this PC. No API keys, and Before
        Effects never charges you.
      </p>
      {(providers ?? []).map((p) => (
        <div key={p.id} className={`a-provider ${p.ready ? "ready" : ""}`}>
          <strong>
            {p.name} <span className="muted small">via {p.via}</span>
          </strong>
          <span className="small">{p.message}</span>
        </div>
      ))}
      <button className="ghost" disabled={checking} onClick={() => void checkProviders(true)}>
        {checking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
};

const Composer = () => {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const working = useAssistant((s) => s.turns.find((t) => t.status === "working"));
  const provider = useAssistant((s) => s.provider);
  const selection = useStudio((s) => s.selection.regionIds);
  const project = useStudio((s) => s.project);
  const venue = project ? activeVenue({ project }) : undefined;
  const names = selection.map((id) => venue?.regions[id]?.name ?? id);
  useEffect(() => ref.current?.focus(), []);
  const send = () => {
    if (!text.trim() || working) return;
    void sendRequest(text);
    setText("");
  };
  return (
    <div className="a-composer">
      <div className="a-selection small" title="“These” and “this” mean the parts selected on the picture">
        {names.length ? (
          <>
            Selected: <strong>{names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ")}</strong>
          </>
        ) : (
          <span className="muted">Nothing selected. Click parts of the picture, or name them.</span>
        )}
      </div>
      <textarea
        ref={ref}
        value={text}
        rows={2}
        disabled={!provider}
        placeholder="Describe a change, e.g. “make these windows pulse blue with the music”"
        aria-label="Ask the assistant"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="row gap end">
        {working ? (
          <button className="ghost" onClick={() => void window.be.assistant.stop(working.id)}>
            Stop
          </button>
        ) : (
          <button className="primary" disabled={!provider || !text.trim()} onClick={send}>
            Send
          </button>
        )}
      </div>
    </div>
  );
};

const UsageLine = () => {
  const { provider, providers, usage } = useAssistant();
  const p = providers?.find((x) => x.id === provider);
  if (!p) return null;
  const pct = (v?: number) => (v === undefined ? "" : `${Math.round(v * 100)}%`);
  return (
    <p className={`a-usage small ${usage?.usingExtra ? "warn" : "muted"}`}>
      {p.id === "claude"
        ? `Your Claude ${p.plan ?? ""} plan${usage?.fiveHour !== undefined ? ` · ${pct(usage.fiveHour)} of the 5-hour allowance used` : ""}${usage?.sevenDay !== undefined ? ` · ${pct(usage.sevenDay)} this week` : ""} · no API key`
        : "Your ChatGPT plan's Codex allowance · no API key"}
      {usage?.usingExtra ? " · plan allowance used up; paid extra usage is blocked" : ""}
    </p>
  );
};

export const AssistantPanel = () => {
  const { provider, providers, turns } = useAssistant();
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!providers) void checkProviders();
  }, [providers]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns]);
  const ready = (providers ?? []).filter((p) => p.ready);
  return (
    <aside className="panel assistant" aria-label="Assistant">
      <div className="row gap a-head">
        <h2 className="grow">Assistant</h2>
        {ready.length > 0 && provider !== "test" && (
          <select
            aria-label="Assistant subscription"
            value={provider ?? ""}
            onChange={(e) => useAssistant.setState({ provider: e.target.value as ProviderId, model: null, usage: null })}
            disabled={turns.some((t) => t.status === "working")}
          >
            {ready.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.plan && p.plan !== p.name ? ` (${p.plan})` : ""}
              </option>
            ))}
          </select>
        )}
        {turns.length > 0 && (
          <button className="link small" onClick={newConversation} disabled={turns.some((t) => t.status === "working")}>
            New
          </button>
        )}
        <button className="icon small" aria-label="Close assistant" onClick={() => useAssistant.setState({ open: false })}>
          ✕
        </button>
      </div>
      {!providers ? (
        <p className="muted small">Checking for Claude Code and Codex on this PC…</p>
      ) : !provider ? (
        <Setup />
      ) : (
        <>
          <div className="a-log" ref={logRef}>
            {turns.length === 0 && (
              <div className="a-intro">
                <p className="muted small">Say what you want to see. Changes appear in the preview right away, are listed here, and can be undone. You can adjust anything it makes by hand.</p>
                <div className="a-examples">
                  {EXAMPLES.map((x) => (
                    <button key={x} className="chip" onClick={() => void sendRequest(x)}>
                      {x}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t) => (
              <Turn key={t.id} t={t} />
            ))}
          </div>
          <Composer />
          <UsageLine />
        </>
      )}
    </aside>
  );
};

export const AssistantButton = () => {
  const open = useAssistant((s) => s.open);
  const working = useAssistant((s) => s.turns.some((t) => t.status === "working"));
  return (
    <button className={`ghost assistant-btn ${open ? "on" : ""} ${working ? "busy" : ""}`} aria-pressed={open} onClick={() => useAssistant.setState({ open: !open })} title="Ask for changes in plain words (Ctrl+K)">
      ✦ Assistant{working ? " · working" : ""}
    </button>
  );
};

/**
 * Agent access: let AI agents and scripts on this PC (Claude Code, Codex, any MCP client, or the
 * be-agent command) inspect and edit the open show. Off by default; local only; protected by an
 * access key that only this Windows account can read. When on, it starts with the app.
 */
import { useEffect, useState } from "react";
import type { AgentStatus } from "../../../shared/api.ts";
import { useAgentActivity } from "../agent/core.ts";
import { useStudio } from "./store.ts";

export const useAgentStatus = (open: boolean): [AgentStatus | null, (s: AgentStatus) => void] => {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void window.be.agent.status().then((s) => alive && setStatus(s));
    load();
    const t = setInterval(load, open ? 1500 : 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open]);
  return [status, setStatus];
};

const recent = (iso: string) => !!iso && Date.now() - Date.parse(iso) < 60_000;

export const AgentButton = () => {
  const open = useStudio((s) => s.agentsOpen);
  const setOpen = (v: boolean) => useStudio.setState({ agentsOpen: v });
  const [status] = useAgentStatus(open);
  const active = !!status?.listening && recent(status.lastRequestAt);
  const activity = useAgentActivity();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!activity.at) return;
    const t = setTimeout(() => tick((n) => n + 1), 5000);
    return () => clearTimeout(t);
  }, [activity.at]);
  const fresh = Date.now() - activity.at < 5000;
  return (
    <div className="tool-pop">
      <button className={`ghost agent-btn ${status?.listening ? "on" : ""} ${active ? "active" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} title="Agent access: let AI agents and scripts on this PC control Before Effects">
        <span className="agent-dot" aria-hidden="true" />
        Agents
        {fresh && <span className="agent-last" role="status">· {activity.label}</span>}
      </button>
      {open && <AgentPanel close={() => setOpen(false)} />}
    </div>
  );
};

const Copyable = ({ label, text }: { label: string; text: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copyable">
      <div className="row gap">
        <strong className="small grow">{label}</strong>
        <button
          className="link small"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <pre className="code" aria-label={label}>
        {text}
      </pre>
    </div>
  );
};

const AgentPanel = ({ close }: { close: () => void }) => {
  const [status, setStatus] = useAgentStatus(true);
  const [tab, setTab] = useState<"claude" | "codex" | "mcp" | "cli">("claude");
  const [port, setPort] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!status) return <div className="popover agent-panel" role="dialog" aria-label="Agent access" />;
  const run = async (fn: () => Promise<AgentStatus>) => {
    setErr(null);
    try {
      setStatus(await fn());
    } catch (e) {
      setErr(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  return (
    <div className="popover agent-panel" role="dialog" aria-label="Agent access">
      <div className="row gap">
        <strong className="grow">Agent access</strong>
        <button className="icon small" aria-label="Close" onClick={close}>
          ✕
        </button>
      </div>
      <p className="muted small">Let AI agents and scripts on this PC — Claude Code, Codex, any MCP client, or the be-agent command — look at and edit the open show. Their changes appear here straight away and can be undone like yours.</p>
      <button className={`toggle ${status.enabled ? "on" : ""}`} role="switch" aria-checked={status.enabled} aria-label="Allow agent access" onClick={() => void run(() => window.be.agent.setEnabled(!status.enabled))}>
        {status.enabled ? "On" : "Off"}
      </button>
      <span className="small"> Allow agents to connect{status.enabled ? " (starts with Before Effects)" : ""}</span>
      <div className={`agent-status ${status.listening ? "ok" : status.enabled ? "warn" : ""}`} role="status">
        {status.listening ? (
          <>
            <strong>Listening</strong> on {status.url} (this PC only) · {status.requests} request{status.requests === 1 ? "" : "s"}
            {status.lastMethod ? ` · last: ${status.lastMethod} ${new Date(status.lastRequestAt).toLocaleTimeString()}` : ""}
            {status.clients.length > 0 && <div className="small muted">Clients: {status.clients.map((c) => c.name).join(", ")}</div>}
          </>
        ) : status.enabled ? (
          <span>{status.error || "Starting…"}</span>
        ) : (
          <span className="muted">Off — nothing can connect.</span>
        )}
      </div>
      {err && <p className="warn small">{err}</p>}

      {status.enabled && (
        <>
          <h3 className="subhead">Set up an agent</h3>
          <div className="segmented" role="tablist" aria-label="Agent type">
            {(
              [
                ["claude", "Claude Code"],
                ["codex", "Codex"],
                ["mcp", "Other MCP"],
                ["cli", "Command line"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          {tab === "claude" && (
            <>
              <p className="small muted">Run once in a terminal; then any Claude Code session can use the before-effects tools while this app is open.</p>
              <Copyable label="Command" text={status.setup.claude} />
            </>
          )}
          {tab === "codex" && (
            <>
              <p className="small muted">Run once in a terminal; Codex then lists the before-effects tools.</p>
              <Copyable label="Command" text={status.setup.codex} />
            </>
          )}
          {tab === "mcp" && (
            <>
              <p className="small muted">Add this to your MCP client's configuration (stdio server).</p>
              <Copyable label="MCP configuration" text={status.setup.mcpJson} />
            </>
          )}
          {tab === "cli" && (
            <>
              <p className="small muted">Call any method from a terminal or script. Run with no arguments for help.</p>
              <Copyable label="Command (Command Prompt)" text={status.setup.cli} />
              <Copyable label="HTTP" text={`POST ${status.url}/v1/call  (Authorization: Bearer <token from ${status.configFile}>)\n{"method":"project.get","params":{},"requestId":"any-unique-id"}`} />
            </>
          )}
          <p className="small muted">
            Agents read the access key from <code>{status.configFile}</code>, which only your Windows account can open. It never leaves this PC.
          </p>
          <div className="row gap wrap">
            <button className="ghost small-btn" onClick={() => void run(() => window.be.agent.newToken())} title="Agents that are connected now will need to reconnect">
              New access key
            </button>
            <label className="small">
              Port{" "}
              <input className="text-input num" type="number" min={1024} max={65535} value={port || String(status.port)} aria-label="Agent access port" onChange={(e) => setPort(e.target.value)} />
            </label>
            {port && Number(port) !== status.port && (
              <button className="ghost small-btn" onClick={() => void run(() => window.be.agent.setPort(Number(port))).then(() => setPort(""))}>
                Use port
              </button>
            )}
          </div>
        </>
      )}
      {!useStudio.getState().project && status.listening && <p className="small muted">No show is open: agents can open one or start one from a photo.</p>}
    </div>
  );
};

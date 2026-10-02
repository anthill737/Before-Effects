/**
 * The AI assistant runs on the person's own subscription through the official command-line tools
 * they already have signed in: Claude Code (`claude -p`, Claude Pro/Max) or Codex
 * (`codex exec`, ChatGPT plans). Before Effects never asks for, stores or uses an API key.
 *
 *   - API-key variables are removed from the tool's environment so it can't fall back to
 *     pay-per-use billing. Claude's session start reports its key source, and a run that isn't on
 *     the subscription is stopped before any request is made.
 *   - The tool gets no shell, file or web tools. It can only use Before Effects' own editing tools,
 *     served by mcp-bridge.js and relayed here over a private named pipe guarded by a one-time token.
 *   - Tool calls are executed by the editor window as ordinary, undoable operations.
 *   - Claude reports plan usage while it works. If a request would start using paid extra usage,
 *     it is stopped unless the person has allowed that.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSISTANT_INSTRUCTIONS, ASSISTANT_TOOLS } from "@be/core";
import { app, ipcMain } from "electron";
import type { AssistantEvent, AssistantProviderStatus, AssistantRunSpec } from "../shared/api.ts";
import { log } from "./log.ts";
import { track } from "./processes.ts";
import { editorWindow } from "./windows.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The bridge must be a real file for Node to run it, so it is unpacked from the app archive. */
const bridgeScript = () => join(here, "mcp-bridge.js").replace(`app.asar${"\\"}`, `app.asar.unpacked${"\\"}`);
const workDir = () => {
  const d = join(app.getPath("userData"), "assistant");
  mkdirSync(d, { recursive: true });
  return d;
};

/** Variables that would make the tools bill an API account instead of the subscription. */
const BILLED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "OPENAI_API_KEY", "CODEX_API_KEY", "ELECTRON_RUN_AS_NODE"];
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of BILLED_ENV) delete env[k];
  return env;
};

const run = (file: string, args: string[], timeout = 20_000): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { env: cleanEnv(), timeout, windowsHide: true, cwd: workDir() }, (e, out, err) =>
      resolve({ code: e ? (typeof (e as { code?: unknown }).code === "number" ? ((e as { code: number }).code) : 1) : 0, out: String(out), err: String(err) }),
    );
  });

const firstExisting = (paths: string[]) => paths.find((p) => p && existsSync(p)) ?? null;

const whereExe = async (name: string): Promise<string[]> => {
  const r = await run("where.exe", [name], 5000);
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.toLowerCase().endsWith(".exe"));
};

const findClaude = async (): Promise<string | null> =>
  firstExisting([...(await whereExe("claude")), join(homedir(), ".local", "bin", "claude.exe"), join(process.env.LOCALAPPDATA ?? "", "Programs", "claude", "claude.exe")]);

const findCodex = async (): Promise<string | null> => {
  const fromPath = await whereExe("codex");
  if (fromPath[0]) return fromPath[0];
  // The npm package runs a native codex.exe through a Node shim; call the executable directly.
  const root = join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "node_modules");
  const search = (dir: string, depth: number): string | null => {
    if (depth < 0 || !existsSync(dir)) return null;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === "codex.exe") return p;
      if (e.isDirectory()) {
        const f = search(p, depth - 1);
        if (f) return f;
      }
    }
    return null;
  };
  return search(root, 6) ?? firstExisting([join(process.env.LOCALAPPDATA ?? "", "Programs", "codex", "codex.exe")]);
};

let statusCache: { at: number; list: AssistantProviderStatus[] } | null = null;
/** Journey tests only: pretend neither tool is installed, to check the guidance shown. */
let simulateMissing = false;

const claudeStatus = async (): Promise<AssistantProviderStatus> => {
  const base = { id: "claude" as const, name: "Claude", via: "Claude Code" };
  const exe = simulateMissing ? null : await findClaude();
  if (!exe)
    return { ...base, installed: false, signedIn: false, ready: false, billing: "unknown", message: "Claude Code isn't installed. Install it from claude.com/claude-code, then sign in with your Claude Pro or Max plan." };
  const r = await run(exe, ["auth", "status"]);
  let s: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {};
  try {
    s = JSON.parse(r.out) as typeof s;
  } catch {
    /* older versions print text */
  }
  if (!s.loggedIn)
    return { ...base, installed: true, signedIn: false, ready: false, billing: "unknown", message: "Claude Code isn't signed in. Open a terminal, run “claude”, and sign in with your Claude account." };
  if (s.authMethod !== "claude.ai" && s.authMethod !== "oauth_token")
    return {
      ...base,
      installed: true,
      signedIn: true,
      ready: false,
      billing: "api",
      message: `Claude Code is set up to use ${s.authMethod === "api_key_helper" ? "an API key helper" : "an API key"}, which is billed per use. Before Effects only uses subscriptions: run “claude”, type /login and choose your Claude subscription.`,
    };
  const plan = s.subscriptionType ? s.subscriptionType[0]!.toUpperCase() + s.subscriptionType.slice(1) : "subscription";
  return { ...base, installed: true, signedIn: true, ready: true, billing: "subscription", plan, message: `Uses your Claude ${plan} plan through Claude Code. No API key.` };
};

const codexStatus = async (): Promise<AssistantProviderStatus> => {
  const base = { id: "codex" as const, name: "ChatGPT", via: "Codex" };
  const exe = simulateMissing ? null : await findCodex();
  if (!exe) return { ...base, installed: false, signedIn: false, ready: false, billing: "unknown", message: "Codex isn't installed. Install it (npm install -g @openai/codex), then run “codex” and choose Sign in with ChatGPT." };
  const r = await run(exe, ["login", "status"]);
  const text = `${r.out}\n${r.err}`;
  if (/ChatGPT/i.test(text)) return { ...base, installed: true, signedIn: true, ready: true, billing: "subscription", plan: "ChatGPT", message: "Uses your ChatGPT plan through Codex. No API key." };
  if (/API key/i.test(text))
    return { ...base, installed: true, signedIn: true, ready: false, billing: "api", message: "Codex is signed in with an API key, which is billed per use. Run “codex logout”, then “codex” and choose Sign in with ChatGPT." };
  return { ...base, installed: true, signedIn: false, ready: false, billing: "unknown", message: "Codex isn't signed in. Open a terminal, run “codex”, and choose Sign in with ChatGPT." };
};

export const assistantStatus = async (refresh = false): Promise<AssistantProviderStatus[]> => {
  if (!refresh && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.list;
  const list = await Promise.all([claudeStatus(), codexStatus()]);
  statusCache = { at: Date.now(), list };
  return list;
};

// ---- bridge -------------------------------------------------------------------------------------

let server: Server | null = null;
let pipePath = "";
let token = "";
let active: { spec: AssistantRunSpec; proc: ChildProcess | null; stopped: boolean } | null = null;
let callCounter = 0;
const pendingCalls = new Map<string, (r: { text: string; isError?: boolean }) => void>();

const emit = (e: AssistantEvent) => editorWindow()?.webContents.send("assistant:event", e);

const toolProgress = (name: string, args: Record<string, unknown>): string => {
  switch (name) {
    case "get_show":
      return "Looking at your show";
    case "list_effects":
      return "Choosing an effect";
    case "apply_effect":
      return `Adding “${String(args.effect ?? "effect")}”`;
    case "change_effect":
      return "Adjusting the effect";
    case "remove_effect":
      return "Removing an effect";
    case "list_operations":
      return "Looking up detailed tools";
    case "run_operations":
      return String(args.label ?? "Making detailed changes");
    case "show_moment":
      return "Moving the playhead";
    default:
      return name;
  }
};

const callEditor = (name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> =>
  new Promise((resolve) => {
    const win = editorWindow();
    if (!win || !active) return resolve({ text: "The editor isn't available.", isError: true });
    const callId = `call${++callCounter}`;
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      resolve({ text: "The editor didn't answer in time.", isError: true });
    }, 120_000);
    pendingCalls.set(callId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    emit({ requestId: active.spec.requestId, kind: "tool", tool: name, text: toolProgress(name, args) });
    win.webContents.send("assistant:tool", { callId, requestId: active.spec.requestId, name, args });
  });

const onBridge = (socket: Socket) => {
  let authed = false;
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: { hello?: string; id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        socket.destroy();
        return;
      }
      if (!authed) {
        if (msg.hello !== token || !active) {
          log("assistant bridge: rejected a connection without the current token");
          socket.destroy();
          return;
        }
        authed = true;
        continue;
      }
      const id = msg.id;
      const answer = (payload: object) => socket.write(`${JSON.stringify({ id, ...payload })}\n`);
      if (msg.method === "tools/list") answer({ result: ASSISTANT_TOOLS });
      else if (msg.method === "tools/call") {
        const name = msg.params?.name ?? "";
        if (!ASSISTANT_TOOLS.some((t) => t.name === name)) answer({ result: { text: `Unknown tool ${name}`, isError: true } });
        else void callEditor(name, msg.params?.arguments ?? {}).then((r) => answer({ result: r }));
      } else answer({ error: `Unknown method ${String(msg.method)}` });
    }
  });
  socket.on("error", () => undefined);
};

const ensureServer = async () => {
  if (server) return;
  token = randomBytes(24).toString("hex");
  pipePath = `\\\\.\\pipe\\before-effects-${process.pid}-${randomBytes(6).toString("hex")}`;
  server = createServer(onBridge);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(pipePath, () => resolve());
  });
};

// ---- runs ---------------------------------------------------------------------------------------

const friendly = (raw: string): string => {
  const t = raw.toLowerCase();
  if (/usage limit|rate limit|limit reached|429|quota/.test(t)) return "Your plan's usage limit has been reached for now. Try again after it resets, or switch to the other assistant.";
  if (/not logged in|login|unauthor|401|invalid api key|authentication/.test(t)) return "The assistant isn't signed in any more. Open a terminal, run the tool (claude or codex) and sign in again.";
  if (/enotfound|econnrefused|network|offline|timed out|timeout|socket hang up|fetch failed/.test(t)) return "The assistant couldn't reach the internet. Check your connection and try again.";
  if (/overloaded|529|503|unavailable/.test(t)) return "The AI service is busy right now. Try again in a minute.";
  return "The assistant stopped unexpectedly. Your show is unchanged apart from anything listed above; try again.";
};

const claudeArgs = (spec: AssistantRunSpec, mcpConfig: string) => [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--tools",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  mcpConfig,
  "--allowedTools",
  "mcp__be",
  "--permission-mode",
  "dontAsk",
  "--setting-sources",
  "",
  "--system-prompt",
  ASSISTANT_INSTRUCTIONS,
  "--max-turns",
  "40",
  ...(spec.sessionId ? ["--resume", spec.sessionId] : []),
];

const toml = (s: string) => `'${s.replace(/'/g, "")}'`; // TOML literal string (paths never contain ')

const codexArgs = (spec: AssistantRunSpec) => {
  const bridge = [
    "-c",
    `mcp_servers.be.command=${toml(process.execPath)}`,
    "-c",
    `mcp_servers.be.args=[${toml(bridgeScript())}, ${toml(pipePath)}, ${toml(token)}]`,
    "-c",
    `mcp_servers.be.env={ ELECTRON_RUN_AS_NODE = "1" }`,
    "-c",
    `mcp_servers.be.default_tools_approval_mode="approve"`,
    "-c",
    "mcp_servers.be.required=true",
    "-c",
    "mcp_servers.be.tool_timeout_sec=180",
    "-c",
    "features.shell_tool=false",
    "-c",
    'web_search="disabled"',
  ];
  const common = ["--json", "--skip-git-repo-check", "--ignore-user-config", ...bridge];
  return spec.sessionId ? ["exec", "--sandbox", "read-only", "-C", workDir(), ...common, "resume", spec.sessionId, "-"] : ["exec", "--sandbox", "read-only", "-C", workDir(), ...common, "-"];
};

const startRun = async (spec: AssistantRunSpec) => {
  if (active) throw new Error("The assistant is still working on the previous request.");
  await ensureServer();
  active = { spec, proc: null, stopped: false };
  const { requestId } = spec;
  const finish = (e: AssistantEvent) => {
    emit(e);
    if (active?.spec.requestId === requestId) active = null;
  };
  let exe: string | null;
  let args: string[];
  let input = spec.prompt;
  if (spec.provider === "test") {
    // Journey tests: a scripted stand-in for the CLI that drives the same bridge (no AI usage).
    exe = process.execPath;
    args = [join(here, "assistant-test-cli.js"), bridgeScript(), pipePath, token];
    input = JSON.stringify(spec.script ?? []);
  } else if (spec.provider === "claude") {
    exe = await findClaude();
    const cfg = join(workDir(), "mcp-config.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { be: { type: "stdio", command: process.execPath, args: [bridgeScript(), pipePath, token], env: { ELECTRON_RUN_AS_NODE: "1" } } } }));
    args = claudeArgs(spec, cfg);
  } else {
    exe = await findCodex();
    args = codexArgs(spec);
    if (!spec.sessionId) input = `${ASSISTANT_INSTRUCTIONS}\n\n---\n\n${spec.prompt}`;
  }
  if (!exe) return finish({ requestId, kind: "failed", message: spec.provider === "claude" ? "Claude Code isn't installed." : "Codex isn't installed." });

  log(`assistant: ${spec.provider} request ${requestId}${spec.sessionId ? ` (continuing ${spec.sessionId})` : ""}`);
  const env = { ...cleanEnv(), ...(spec.provider === "test" ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
  const proc = spawn(exe, args, { cwd: workDir(), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  active.proc = proc;
  track(`assistant-${spec.provider}`, proc);
  proc.stdin.end(input);

  let out = "";
  let err = "";
  let reply = "";
  let sessionId = spec.sessionId;
  let resultError: string | null = null;
  let done = false;
  const stopWith = (message: string) => {
    if (!active || active.spec.requestId !== requestId) return;
    active.stopped = true;
    proc.kill();
    finish({ requestId, kind: "failed", message, ...(sessionId ? { sessionId } : {}) });
    done = true;
  };

  const onClaude = (m: Record<string, unknown>) => {
    if (m.type === "system" && m.subtype === "init") {
      sessionId = String(m.session_id ?? "") || sessionId;
      const keySource = String(m.apiKeySource ?? "none");
      if (keySource !== "none") return stopWith(`Claude Code was about to use ${keySource} (billed per use) instead of your subscription, so the request was stopped. Run “claude” and /login with your Claude subscription.`);
      emit({ requestId, kind: "started", ...(sessionId ? { sessionId } : {}), model: String(m.model ?? "") });
    } else if (m.type === "rate_limit_event") {
      const info = (m.rate_limit_info ?? {}) as { status?: string; isUsingOverage?: boolean; overageStatus?: string; resetsAt?: number; unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> };
      const usage = {
        ...(info.unifiedWindows?.five_hour?.utilization !== undefined ? { fiveHour: info.unifiedWindows.five_hour.utilization } : {}),
        ...(info.unifiedWindows?.seven_day?.utilization !== undefined ? { sevenDay: info.unifiedWindows.seven_day.utilization } : {}),
        ...(info.resetsAt ? { resetsAt: info.resetsAt } : {}),
        usingExtra: !!info.isUsingOverage,
      };
      emit({ requestId, kind: "usage", usage });
      if (info.isUsingOverage && !spec.allowExtraUsage)
        stopWith("Your Claude plan's included usage is used up, and continuing would use paid extra usage, so the assistant stopped. Try again after your limit resets.");
    } else if (m.type === "assistant") {
      const content = ((m.message as { content?: Array<{ type: string; text?: string }> })?.content ?? []).filter((c) => c.type === "text" && c.text);
      for (const c of content) emit({ requestId, kind: "text", text: c.text! });
    } else if (m.type === "result") {
      sessionId = String(m.session_id ?? "") || sessionId;
      if (m.is_error || m.subtype !== "success") resultError = String(m.result ?? m.subtype ?? "error");
      else reply = String(m.result ?? "");
    }
  };

  const onCodex = (m: Record<string, unknown>) => {
    const item = m.item as { type?: string; text?: string; tool?: string; status?: string; error?: { message?: string } } | undefined;
    if (m.type === "thread.started") {
      sessionId = String(m.thread_id ?? "") || sessionId;
      emit({ requestId, kind: "started", ...(sessionId ? { sessionId } : {}) });
    } else if (m.type === "item.completed" && item?.type === "agent_message" && item.text) {
      reply = item.text;
      emit({ requestId, kind: "text", text: item.text });
    } else if (m.type === "item.completed" && item?.type === "mcp_tool_call" && item.status === "failed") {
      log(`assistant: codex tool ${String(item.tool)} failed: ${String(item.error?.message ?? "")}`);
    } else if (m.type === "turn.failed" || m.type === "error") {
      resultError = String((m.error as { message?: string })?.message ?? m.message ?? "error");
    }
  };

  const onTest = (m: Record<string, unknown>) => {
    if (m.type === "started") emit({ requestId, kind: "started", sessionId: "test-session" });
    else if (m.type === "text") emit({ requestId, kind: "text", text: String(m.text) });
    else if (m.type === "result") reply = String(m.text ?? "");
    else if (m.type === "error") resultError = String(m.text);
    sessionId = "test-session";
  };

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    out += chunk;
    let nl: number;
    while ((nl = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        if (spec.provider === "claude") onClaude(m);
        else if (spec.provider === "codex") onCodex(m);
        else onTest(m);
      } catch {
        /* not an event line */
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c: string) => (err = (err + c).slice(-8000)));
  proc.on("error", (e) => {
    if (!done) finish({ requestId, kind: "failed", message: "The assistant tool couldn't be started.", detail: String(e.message) });
    done = true;
  });
  proc.on("exit", (code) => {
    if (done) return;
    done = true;
    if (active?.stopped) return finish({ requestId, kind: "failed", message: "Stopped.", ...(sessionId ? { sessionId } : {}) });
    if (resultError || (code !== 0 && !reply)) {
      const raw = resultError ?? err ?? `exit ${String(code)}`;
      log(`assistant: ${spec.provider} failed (${String(code)}): ${raw.slice(0, 2000)} ${err.slice(-1500)}`);
      return finish({ requestId, kind: "failed", message: /max_turns/.test(raw) ? "That request needed too many steps. Try asking for one change at a time." : friendly(`${raw} ${err}`), detail: raw.slice(0, 600), ...(sessionId ? { sessionId } : {}) });
    }
    finish({ requestId, kind: "done", reply: reply.trim(), ...(sessionId ? { sessionId } : {}) });
  });
};

export const registerAssistantIpc = (mode: string) => {
  ipcMain.handle("assistant:testSimulateMissing", (_e, on: boolean) => {
    if (mode === "uitest") simulateMissing = on;
  });
  ipcMain.handle("assistant:status", (_e, refresh?: boolean) => assistantStatus(!!refresh));
  ipcMain.handle("assistant:run", (_e, spec: AssistantRunSpec) => startRun(spec));
  ipcMain.handle("assistant:stop", (_e, requestId: string) => {
    if (active?.spec.requestId === requestId && active.proc) {
      active.stopped = true;
      active.proc.kill();
    }
  });
  ipcMain.on("assistant:toolResult", (_e, callId: string, result: { text: string; isError?: boolean }) => {
    pendingCalls.get(callId)?.(result);
    pendingCalls.delete(callId);
  });
};

export const shutdownAssistant = () => {
  if (active?.proc) active.proc.kill();
  active = null;
  server?.close();
  server = null;
};

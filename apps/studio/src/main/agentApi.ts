/**
 * External-agent API: a standing, local, authenticated server that lets a separately launched CLI
 * or MCP client (Claude Code, Codex, scripts) inspect and edit the open show while the person
 * keeps working in the editor.
 *
 *   GET  /v1/ping           no auth; says only that Before Effects is listening
 *   GET  /v1/capabilities   methods with JSON schemas
 *   POST /v1/call           { method, params?, requestId? } → { ok, result, revision } | { ok: false, error }
 *   GET  /v1/events?after=N Server-Sent Events: revision, job, preparation, project, …
 *   POST /v1/events/poll    { after?, timeoutMs? } → events after N (for clients that can't stream)
 *
 * Security: listens on 127.0.0.1 only; every request except ping needs the bearer token from the
 * connection file (%APPDATA%\Before Effects\agent-api.json, readable only by this Windows user's
 * processes); requests from browsers (an Origin header) or for another Host are refused.
 *
 * Edits run in the editor window through the same operations as the UI (see renderer agent/), so
 * they appear immediately and are undoable. A request id makes retries safe: the same id returns
 * the first result instead of applying the change twice.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type { AgentStatus } from "../shared/api.ts";
import { log } from "./log.ts";
import { onQueueChange } from "./renderQueue.ts";
import { editorWindow } from "./windows.ts";

const API_VERSION = 1;
const DEFAULT_PORT = 47821;
const MAX_BODY = 20 * 1024 * 1024;

interface Config {
  enabled: boolean;
  port: number;
  token: string;
}

/** Fixed location (the same for development and packaged builds) so clients can find it. */
export const agentConfigFile = (): string => join(app.getPath("appData"), "Before Effects", "agent-api.json");

let config: Config | null = null;
/** When a test turns the API on for one session, the saved setting keeps its own value. */
let persistedEnabled: boolean | null = null;
const loadConfig = (): Config => {
  if (config) return config;
  try {
    const c = JSON.parse(readFileSync(agentConfigFile(), "utf8")) as Partial<Config>;
    config = { enabled: c.enabled === true, port: Number(c.port) || DEFAULT_PORT, token: typeof c.token === "string" && c.token.length >= 32 ? c.token : randomBytes(32).toString("hex") };
  } catch {
    config = { enabled: false, port: DEFAULT_PORT, token: randomBytes(32).toString("hex") };
  }
  return config;
};
const saveConfig = () => {
  const c = loadConfig();
  mkdirSync(dirname(agentConfigFile()), { recursive: true });
  // The client tools read url + token from here; nothing else is stored.
  writeFileSync(agentConfigFile(), JSON.stringify({ enabled: persistedEnabled ?? c.enabled, port: c.port, url: `http://127.0.0.1:${c.port}`, token: c.token, app: process.execPath, writtenAt: new Date().toISOString() }, null, 2));
};

// ---- events ---------------------------------------------------------------------------------------

interface AgentEvent {
  readonly seq: number;
  readonly type: string;
  readonly at: string;
  readonly data: unknown;
}
const events: AgentEvent[] = [];
let seq = 0;
const streams = new Set<ServerResponse>();
const waiters = new Set<() => void>();

export const publishAgentEvent = (type: string, data: unknown) => {
  const e: AgentEvent = { seq: ++seq, type, at: new Date().toISOString(), data };
  events.push(e);
  if (events.length > 2000) events.splice(0, events.length - 2000);
  for (const s of streams) s.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  for (const w of [...waiters]) w();
};

// ---- calls into the editor -------------------------------------------------------------------------

interface CallResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
  revision?: number;
}
let callCounter = 0;
/** The editor window registers its handler after loading; calls wait for that instead of getting lost. */
let editorReady = false;
const readyWaiters = new Set<() => void>();
const whenEditorReady = (ms: number) =>
  editorReady
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
        const done = () => {
          clearTimeout(t);
          readyWaiters.delete(done);
          resolve(editorReady);
        };
        const t = setTimeout(done, ms);
        readyWaiters.add(done);
      });
const pendingCalls = new Map<string, (r: CallResult) => void>();
/** Results by request id (safe retries); in-flight calls share one promise. */
const byRequest = new Map<string, { at: number; promise: Promise<CallResult> }>();

const editorCall = async (method: string, params: unknown, requestId: string, timeoutMs: number): Promise<CallResult> => {
  if (!(await whenEditorReady(30_000))) return { ok: false, error: { code: "unavailable", message: "The Before Effects editor is still starting. Try again in a moment." } };
  return new Promise((resolve) => {
    const win = editorWindow();
    if (!win || win.isDestroyed()) return resolve({ ok: false, error: { code: "unavailable", message: "The Before Effects editor window isn't open." } });
    const callId = `a${++callCounter}`;
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      resolve({ ok: false, error: { code: "timeout", message: `The editor didn't finish "${method}" within ${Math.round(timeoutMs / 1000)} s. It may still complete; check the revision or events, then retry with the same requestId.` } });
    }, timeoutMs);
    pendingCalls.set(callId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    win.webContents.send("agent:call", { callId, method, params, requestId });
  });
};

const stats = { requests: 0, lastRequestAt: "", lastMethod: "", clients: new Map<string, string>() };

const call = (method: string, params: unknown, requestId: string | undefined): Promise<CallResult> => {
  stats.requests++;
  stats.lastRequestAt = new Date().toISOString();
  stats.lastMethod = method;
  const timeoutMs = Math.min(30 * 60_000, Math.max(5_000, Number((params as { timeoutMs?: number } | undefined)?.timeoutMs ?? 0) + 30_000, 120_000));
  if (!requestId) return editorCall(method, params, `r${Date.now()}${callCounter}`, timeoutMs);
  const now = Date.now();
  for (const [k, v] of byRequest) if (now - v.at > 30 * 60_000) byRequest.delete(k);
  const hit = byRequest.get(requestId);
  if (hit) return hit.promise.then((r) => ({ ...r, ...(r.ok ? { replayed: true } : {}) }));
  const promise = editorCall(method, params, requestId, timeoutMs).then((r) => {
    // A request that never reached the editor can be retried for real.
    if (!r.ok && (r.error?.code === "unavailable" || r.error?.code === "timeout")) byRequest.delete(requestId);
    return r;
  });
  byRequest.set(requestId, { at: now, promise });
  return promise;
};

// ---- HTTP -----------------------------------------------------------------------------------------

let server: Server | null = null;
let listening = false;
let lastError = "";

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const authorised = (req: IncomingMessage): boolean => {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(loadConfig().token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("The request body isn't valid JSON."));
      }
    });
    req.on("error", reject);
  });

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const port = loadConfig().port;
  const host = (req.headers.host ?? "").toLowerCase();
  // Local only: loopback peer, our own host name (no DNS rebinding), and no browser pages.
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) || req.headers.origin) {
    return json(res, 403, { ok: false, error: { code: "forbidden", message: "Only local tools can use this API." } });
  }
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (req.method === "GET" && url.pathname === "/v1/ping") return json(res, 200, { app: "Before Effects", api: API_VERSION });
  if (!authorised(req)) return json(res, 401, { ok: false, error: { code: "unauthorized", message: `Missing or wrong token. Read it from ${agentConfigFile()}.` } });
  const client = String(req.headers["user-agent"] ?? "client").slice(0, 60);
  stats.clients.set(client, new Date().toISOString());

  if (req.method === "GET" && url.pathname === "/v1/capabilities") {
    const r = await call("api.capabilities", {}, undefined);
    return json(res, r.ok ? 200 : 503, r.ok ? r.result : r);
  }
  if (req.method === "POST" && url.pathname === "/v1/call") {
    let body: { method?: unknown; params?: unknown; requestId?: unknown };
    try {
      body = (await readBody(req)) as typeof body;
    } catch (e) {
      return json(res, 400, { ok: false, error: { code: "bad_request", message: String((e as Error).message) } });
    }
    if (typeof body.method !== "string") return json(res, 400, { ok: false, error: { code: "bad_request", message: 'Send { "method": "...", "params": {...} }. GET /v1/capabilities lists the methods.' } });
    if (body.method === "events.poll") return json(res, 200, { ok: true, result: await poll(body.params as { after?: number; timeoutMs?: number }) });
    const r = await call(body.method, body.params ?? {}, typeof body.requestId === "string" && body.requestId ? body.requestId.slice(0, 200) : undefined);
    return json(res, 200, r);
  }
  if (req.method === "POST" && url.pathname === "/v1/events/poll") {
    let body: { after?: number; timeoutMs?: number } = {};
    try {
      body = (await readBody(req)) as typeof body;
    } catch {
      /* defaults */
    }
    return json(res, 200, { ok: true, result: await poll(body) });
  }
  if (req.method === "GET" && url.pathname === "/v1/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    // Send the headers now: clients would otherwise wait for the first event.
    res.flushHeaders();
    res.write(`: connected, latest event ${seq}\n\n`);
    const after = Number(url.searchParams.get("after") ?? req.headers["last-event-id"] ?? seq);
    for (const e of events) if (e.seq > after) res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    streams.add(res);
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(beat);
      streams.delete(res);
    });
    return;
  }
  json(res, 404, { ok: false, error: { code: "not_found", message: "Unknown endpoint. Use GET /v1/capabilities, POST /v1/call, GET /v1/events." } });
};

const poll = async (p: { after?: number; timeoutMs?: number } | undefined) => {
  const after = Number(p?.after ?? 0);
  const timeout = Math.min(60_000, Math.max(0, Number(p?.timeoutMs ?? 0)));
  const ready = () => events.filter((e) => e.seq > after);
  if (!ready().length && timeout > 0)
    await new Promise<void>((resolve) => {
      const done = () => {
        waiters.delete(done);
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(done, timeout);
      waiters.add(done);
    });
  return { events: ready().slice(0, 500), latest: seq };
};

const start = async (): Promise<void> => {
  const c = loadConfig();
  if (server || !c.enabled) return;
  saveConfig();
  server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`agent api: ${String((e as Error)?.message ?? e)}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: { code: "internal", message: "Something went wrong handling that request." } });
    });
  });
  await new Promise<void>((resolve) => {
    server!.once("error", (e: NodeJS.ErrnoException) => {
      lastError = e.code === "EADDRINUSE" ? `Port ${c.port} is already in use (is another copy of Before Effects running?). Choose another port.` : String(e.message);
      log(`agent api: could not listen: ${lastError}`);
      server = null;
      listening = false;
      resolve();
    });
    server!.listen(c.port, "127.0.0.1", () => {
      listening = true;
      lastError = "";
      log(`agent api: listening on 127.0.0.1:${c.port}`);
      publishAgentEvent("api", { listening: true });
      resolve();
    });
  });
};

const stop = async () => {
  for (const s of streams) s.end();
  streams.clear();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  listening = false;
};

/** Adapter scripts (MCP server and CLI) run with this executable as plain Node. */
const scriptPath = (name: string) => join(__dirname, `${name}.js`).replace("app.asar", "app.asar.unpacked");

export const agentStatus = (): AgentStatus => {
  const c = loadConfig();
  const exe = process.execPath;
  const mcp = scriptPath("agent-mcp");
  const cli = scriptPath("agent-cli");
  const q = (s: string) => `"${s}"`;
  return {
    enabled: c.enabled,
    listening,
    port: c.port,
    url: `http://127.0.0.1:${c.port}`,
    error: lastError,
    configFile: agentConfigFile(),
    requests: stats.requests,
    lastRequestAt: stats.lastRequestAt,
    lastMethod: stats.lastMethod,
    clients: [...stats.clients.entries()].map(([name, at]) => ({ name, at })),
    streams: streams.size,
    setup: {
      claude: `claude mcp add before-effects -e ELECTRON_RUN_AS_NODE=1 -- ${q(exe)} ${q(mcp)}`,
      codex: `codex mcp add before-effects --env ELECTRON_RUN_AS_NODE=1 -- ${q(exe)} ${q(mcp)}`,
      mcpJson: JSON.stringify({ mcpServers: { "before-effects": { command: exe, args: [mcp], env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2),
      cli: `set ELECTRON_RUN_AS_NODE=1 && ${q(exe)} ${q(cli)} status`,
      cliScript: cli,
      exe,
    },
  };
};

export const registerAgentApi = async (mode: string) => {
  ipcMain.handle("agent:status", () => agentStatus());
  ipcMain.handle("agent:setEnabled", async (_e, on: boolean) => {
    persistedEnabled = null;
    loadConfig().enabled = !!on;
    saveConfig();
    if (on) await start();
    else await stop();
    return agentStatus();
  });
  ipcMain.handle("agent:setPort", async (_e, port: number) => {
    const p = Math.round(Number(port));
    if (!(p >= 1024 && p <= 65535)) throw new Error("Choose a port between 1024 and 65535.");
    loadConfig().port = p;
    saveConfig();
    if (server) {
      await stop();
      await start();
    }
    return agentStatus();
  });
  ipcMain.handle("agent:newToken", () => {
    loadConfig().token = randomBytes(32).toString("hex");
    saveConfig();
    byRequest.clear();
    return agentStatus();
  });
  ipcMain.on("agent:result", (_e, callId: string, r: CallResult) => {
    pendingCalls.get(callId)?.(r);
    pendingCalls.delete(callId);
  });
  ipcMain.on("agent:event", (_e, type: string, data: unknown) => {
    if (type === "ready") {
      editorReady = true;
      for (const w of [...readyWaiters]) w();
    }
    publishAgentEvent(type, data);
  });
  // A reloading or crashed editor must announce itself again before calls are sent to it.
  const watch = (w: Electron.BrowserWindow) => {
    w.webContents.on("did-start-loading", () => {
      if (w === editorWindow()) editorReady = false;
    });
    w.webContents.on("render-process-gone", () => {
      if (w === editorWindow()) editorReady = false;
    });
  };
  for (const w of BrowserWindow.getAllWindows()) watch(w);
  app.on("browser-window-created", (_e, w) => watch(w));
  onQueueChange((jobs) => publishAgentEvent("jobs", jobs.map((j) => ({ id: j.id, name: j.name, state: j.state, phase: j.phase, done: j.done, frames: j.frames, output: j.output, result: j.result, error: j.error }))));
  // Journey tests turn the API on for the session without changing the saved setting.
  if (mode === "uitest" && process.env.BE_AGENT_API === "1") {
    persistedEnabled = loadConfig().enabled;
    loadConfig().enabled = true;
  }
  if (process.env.BE_AGENT_PORT) loadConfig().port = Number(process.env.BE_AGENT_PORT) || DEFAULT_PORT;
  if (loadConfig().enabled) await start();
};

export const shutdownAgentApi = () => {
  void stop();
};

export const agentApiAvailable = () => existsSync(agentConfigFile());

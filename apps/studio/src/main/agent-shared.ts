/**
 * Shared by the agent MCP server and the CLI (both run as plain Node, no dependencies): find the
 * running Before Effects from its connection file and make authenticated calls, retrying safely.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Connection {
  readonly url: string;
  readonly token: string;
  readonly enabled: boolean;
}

export const connectionFile = (): string => process.env.BE_AGENT_CONFIG || join(process.env.APPDATA || join(process.env.USERPROFILE || ".", "AppData", "Roaming"), "Before Effects", "agent-api.json");

export const readConnection = (): Connection | null => {
  try {
    const c = JSON.parse(readFileSync(connectionFile(), "utf8")) as { url?: string; port?: number; token?: string; enabled?: boolean };
    if (!c.token) return null;
    return { url: c.url || `http://127.0.0.1:${c.port ?? 47821}`, token: c.token, enabled: c.enabled !== false };
  } catch {
    return null;
  }
};

export const NOT_RUNNING =
  "Before Effects isn't reachable. Start it (double-click the Before Effects shortcut) and turn on Settings → Agent access. The connection details are read from " + connectionFile() + ".";

export interface CallResponse {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
  revision?: number;
  replayed?: boolean;
  notes?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HTTP request to the app, re-reading the connection file each time (the app may have restarted). */
export const request = async (path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> => {
  const c = readConnection();
  if (!c) throw new Error(NOT_RUNNING);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 35 * 60_000);
  try {
    const res = await fetch(`${c.url}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json", "user-agent": process.env.BE_AGENT_CLIENT || "be-agent" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: ctl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Call a method. A request id is generated once and reused for retries, so a call that reached the
 * app before the connection dropped is never applied twice.
 */
export const callMethod = async (method: string, params: unknown = {}, opts: { requestId?: string; retries?: number } = {}): Promise<CallResponse> => {
  const requestId = opts.requestId ?? randomUUID();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= (opts.retries ?? 3); attempt++) {
    try {
      return (await request("/v1/call", { body: { method, params, requestId } })) as CallResponse;
    } catch (e) {
      lastErr = e;
      if ((e as Error).message === NOT_RUNNING) break;
      await sleep(400 * (attempt + 1));
    }
  }
  return { ok: false, error: { code: "unavailable", message: `${NOT_RUNNING} (${String((lastErr as Error)?.message ?? lastErr)})` } };
};

export const ping = async (): Promise<boolean> => {
  try {
    const c = readConnection();
    if (!c) return false;
    const r = (await (await fetch(`${c.url}/v1/ping`)).json()) as { app?: string };
    return r.app === "Before Effects";
  } catch {
    return false;
  }
};

/**
 * MCP server (stdio) that the person's own AI command-line tool (Claude Code or Codex) starts.
 * It relays tool listing and tool calls to the running Before Effects over a private named pipe,
 * guarded by a one-time token. It has no dependencies and runs as plain Node
 * (Before Effects' own executable with ELECTRON_RUN_AS_NODE=1).
 *
 *   argv: <pipe path> <token>
 */
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";

const [pipePath, token] = process.argv.slice(2);
type Json = Record<string, unknown>;

const send = (msg: Json) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

let app: Socket | null = null;
let buffer = "";
let nextId = 1;
const pending = new Map<number, (r: { result?: unknown; error?: string }) => void>();

const appCall = (method: string, params: unknown): Promise<{ result?: unknown; error?: string }> =>
  new Promise((resolve) => {
    if (!app) return resolve({ error: "Before Effects isn't connected. Is the app still open?" });
    const id = nextId++;
    pending.set(id, resolve);
    app.write(`${JSON.stringify({ id, method, params })}\n`);
  });

const open = (): Promise<void> =>
  new Promise((resolve) => {
    if (!pipePath || !token) return resolve();
    const s = connect(pipePath, () => {
      s.write(`${JSON.stringify({ hello: token })}\n`);
      app = s;
      resolve();
    });
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    });
    s.on("error", () => resolve());
    s.on("close", () => {
      app = null;
      for (const r of pending.values()) r({ error: "Before Effects closed the connection." });
      pending.clear();
    });
  });

const ready = open();

const handle = async (msg: Json) => {
  const { id, method, params } = msg as { id?: unknown; method?: string; params?: Json };
  if (id === undefined) return; // notifications (initialized, cancelled) need no reply
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: (params?.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "before-effects", version: "0.1.0" },
        instructions: "Tools for editing the open Before Effects show. Call get_show first.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list": {
      await ready;
      const r = await appCall("tools/list", {});
      return r.error ? fail(id, -32603, r.error) : reply(id, { tools: r.result });
    }
    case "tools/call": {
      await ready;
      const r = await appCall("tools/call", params);
      if (r.error) return reply(id, { content: [{ type: "text", text: r.error }], isError: true });
      const out = r.result as { text: string; isError?: boolean };
      return reply(id, { content: [{ type: "text", text: out.text }], ...(out.isError ? { isError: true } : {}) });
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg: Json;
  try {
    msg = JSON.parse(line) as Json;
  } catch {
    return fail(null, -32700, "Parse error");
  }
  void handle(msg).catch((e: unknown) => fail(msg.id ?? null, -32603, String((e as Error)?.message ?? e)));
});
process.stdin.on("end", () => process.exit(0));

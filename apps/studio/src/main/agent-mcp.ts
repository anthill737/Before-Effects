/**
 * MCP server (stdio) for external agents — Claude Code, Codex, or any MCP client — connected to the
 * running Before Effects through its local agent API. Started by the client, e.g.:
 *
 *   claude mcp add before-effects -e ELECTRON_RUN_AS_NODE=1 -- "<Before Effects.exe>" "<…>\agent-mcp.js"
 *
 * Every API method becomes a tool (dots become underscores: project.get → project_get) with its
 * JSON Schema. Tool calls get a request id, so retries after a dropped connection are safe. A
 * captured preview frame is returned as an image the agent can look at.
 */
import { createInterface } from "node:readline";
import { callMethod, NOT_RUNNING, ping, request } from "./agent-shared.ts";

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

interface Capabilities {
  methods: Array<{ name: string; summary: string; changes: boolean; long?: boolean; params: Json }>;
}

const toolName = (method: string) => method.replace(/\./g, "_");
let methodByTool = new Map<string, string>();

const offlineTools = [
  {
    name: "before_effects_status",
    description: "Check whether Before Effects is running with Agent access on. Its tools appear once it is reachable.",
    inputSchema: { type: "object", properties: {} },
  },
];

const listTools = async () => {
  let caps: Capabilities;
  try {
    caps = (await request("/v1/capabilities", { timeoutMs: 10_000 })) as Capabilities;
    if (!Array.isArray(caps.methods)) throw new Error("no methods");
  } catch {
    return offlineTools;
  }
  methodByTool = new Map(caps.methods.map((m) => [toolName(m.name), m.name]));
  const tools = caps.methods.map((m) => {
    const schema = { type: "object", ...(m.params as Json) } as Json & { properties?: Json };
    delete schema.$schema;
    if (m.changes) schema.properties = { ...(schema.properties ?? {}), expectRevision: { type: "integer", description: "Refuse (conflict) if the show changed since this revision." } };
    return { name: toolName(m.name), description: `${m.summary}${m.changes ? " (Changes the show; one undo step.)" : ""}`, inputSchema: schema };
  });
  tools.push({
    name: "events_poll",
    description: "Wait for editor events after a sequence number: revision (any change, with source user/agent), selection, scene, project, jobs (export progress), preparation. Returns events and the latest sequence.",
    inputSchema: { type: "object", properties: { after: { type: "integer" }, timeoutMs: { type: "integer", maximum: 60000 } } },
  });
  return tools;
};

const handle = async (msg: Json) => {
  const { id, method, params } = msg as { id?: unknown; method?: string; params?: Json };
  if (id === undefined) return;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: (params?.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "before-effects", version: "1.0.0" },
        instructions:
          "Tools for the Before Effects show open in the running app (projection mapping). Start with project_get, areas_list and scenes_list. Edits apply immediately in the editor as undoable steps. Pass expectRevision (from the last result) to avoid overwriting the person's manual edits. preview_capture with inline:true returns the frame as an image.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: await listTools() });
    case "tools/call": {
      const name = String(params?.name ?? "");
      const args = (params?.arguments ?? {}) as Json;
      if (name === "before_effects_status") {
        const up = await ping();
        return reply(id, { content: [{ type: "text", text: up ? "Before Effects is running with Agent access on." : NOT_RUNNING }], ...(up ? {} : { isError: true }) });
      }
      if (!methodByTool.size) await listTools();
      const apiMethod = name === "events_poll" ? "events.poll" : methodByTool.get(name);
      if (!apiMethod) return reply(id, { content: [{ type: "text", text: `Unknown tool ${name}.` }], isError: true });
      const r = await callMethod(apiMethod, args);
      if (!r.ok) return reply(id, { content: [{ type: "text", text: JSON.stringify(r.error, null, 2) }], isError: true });
      const content: Json[] = [];
      const result = r.result as Json | null;
      if (result && typeof result.pngBase64 === "string") {
        content.push({ type: "image", data: result.pngBase64, mimeType: "image/png" });
        delete result.pngBase64;
      }
      content.unshift({ type: "text", text: JSON.stringify({ result, revision: r.revision, ...(r.notes ? { notes: r.notes } : {}), ...(r.replayed ? { replayed: true } : {}) }, null, 2) });
      return reply(id, { content });
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
};

// Tell the client when Before Effects becomes reachable (or goes away), so its tool list refreshes.
let reachable: boolean | null = null;
setInterval(() => {
  void ping().then((up) => {
    if (reachable !== null && up !== reachable) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    reachable = up;
  });
}, 5000).unref();

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

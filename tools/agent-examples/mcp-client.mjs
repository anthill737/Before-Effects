/**
 * A minimal MCP client (stdio, JSON-RPC 2.0) for the Before Effects MCP server — the same protocol
 * Claude Code and Codex use. Plain Node 18+, no dependencies.
 *
 *   import { McpClient, beAdapter } from "./mcp-client.mjs";
 *   const c = await McpClient.start(beAdapter());
 *   const tools = await c.listTools();
 *   const show = await c.call("project_get", {});
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** How to start the Before Effects MCP server: the app's executable run as Node with agent-mcp.js. */
export const beAdapter = () => {
  const conn = JSON.parse(readFileSync(join(process.env.APPDATA, "Before Effects", "agent-api.json"), "utf8"));
  const exe = process.env.BE_EXE || conn.app;
  const candidates = [
    join(exe, "..", "resources", "app.asar.unpacked", "out", "main", "agent-mcp.js"), // packaged
    join(exe, "..", "..", "..", "..", "out", "main", "agent-mcp.js"), // development (node_modules/electron/dist)
  ];
  const script = process.env.BE_AGENT_MCP || candidates.find((p) => existsSync(p));
  if (!script) throw new Error(`agent-mcp.js not found next to ${exe}`);
  return { command: exe, args: [script], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", BE_AGENT_CLIENT: "example-mcp-client" } };
};

export class McpClient {
  static async start(server) {
    const c = new McpClient(server);
    await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "be-example", version: "1.0" } });
    c.notify("notifications/initialized", {});
    return c;
  }

  constructor(server) {
    this.proc = spawn(server.command, server.args, { env: server.env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    this.next = 1;
    this.pending = new Map();
    this.notifications = [];
    let buf = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        } else if (msg.method) this.notifications.push(msg);
      }
    });
  }

  request(method, params, timeoutMs = 15 * 60_000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      if (this.proc.exitCode !== null || this.proc.stdin.destroyed) return reject(new Error("the MCP server has exited"));
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async listTools() {
    return (await this.request("tools/list", {})).tools;
  }

  /** Call a tool; returns { ok, data, images, raw }. data is the parsed JSON text content. */
  async call(name, args = {}) {
    const r = await this.request("tools/call", { name, arguments: args });
    const text = r.content.find((c) => c.type === "text")?.text ?? "";
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ok: !r.isError, data, images: r.content.filter((c) => c.type === "image"), raw: r };
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

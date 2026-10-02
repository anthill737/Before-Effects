/**
 * Journey-test stand-in for an AI command-line tool. It starts mcp-bridge.js exactly as Claude
 * Code or Codex would, speaks MCP to it over stdio, and runs a scripted list of tool calls read
 * from stdin. Used only by the UI journey tests, so they exercise the real bridge, pipe and editor
 * tool execution without using anyone's AI plan.
 *
 *   argv: <bridge script> <pipe> <token>     stdin: JSON array of steps
 *   step: { "call": tool, "args": {...} } | { "say": text } | { "wait": ms }
 *   "$effect" in args is replaced by the last effect id a tool returned.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [bridge, pipe, token] = process.argv.slice(2);
const out = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);

const readStdin = async () => {
  let s = "";
  for await (const c of process.stdin) s += String(c);
  return s;
};

const main = async () => {
  const steps = JSON.parse((await readStdin()) || "[]") as Array<{ call?: string; args?: Record<string, unknown>; say?: string; wait?: number }>;
  const child = spawn(process.execPath, [bridge!, pipe!, token!], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line) as Record<string, unknown>;
    waiting.get(m.id as number)?.(m);
  });
  let id = 0;
  const rpc = (method: string, params: object = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });

  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-cli", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await rpc("tools/list");
  const tools = ((list.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name);
  out({ type: "started", tools });

  let lastEffect = "";
  const subst = (v: unknown): unknown =>
    typeof v === "string" ? v.replace("$effect", lastEffect) : Array.isArray(v) ? v.map(subst) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x)])) : v;
  let reply = "";
  for (const step of steps) {
    if (step.wait) {
      await new Promise((r) => setTimeout(r, step.wait));
      continue;
    }
    if (step.say) {
      reply = step.say;
      out({ type: "text", text: step.say });
      continue;
    }
    const r = await rpc("tools/call", { name: step.call, arguments: subst(step.args ?? {}) });
    const res = r.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    const text = res?.content?.[0]?.text ?? JSON.stringify(r.error ?? {});
    try {
      const parsed = JSON.parse(text) as { effect_id?: string };
      if (parsed.effect_id) lastEffect = parsed.effect_id;
    } catch {
      /* plain text */
    }
    out({ type: "tool_result", tool: step.call, isError: !!res?.isError, text: text.slice(0, 400) });
    if (res?.isError) {
      out({ type: "error", text });
      break;
    }
  }
  out({ type: "result", text: reply });
  child.stdin.end();
  child.kill();
};

void main().then(
  () => process.exit(0),
  (e: unknown) => {
    out({ type: "error", text: String(e) });
    process.exit(1);
  },
);

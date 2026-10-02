/**
 * be-agent: a small command-line client for the Before Effects agent API (plain Node, no
 * dependencies). Run it with Before Effects' own executable as Node:
 *
 *   set ELECTRON_RUN_AS_NODE=1
 *   "<Before Effects.exe>" "<…>\agent-cli.js" status
 *
 * Commands:
 *   status                              is it running? which show, revision, selection
 *   methods [prefix]                    list methods (e.g. "methods areas")
 *   describe <method>                   a method's parameters (JSON Schema) and example
 *   call <method> [json|@file.json]     call a method; --id <requestId> (safe retries), --expect <revision>
 *   events [--after N]                  stream editor events (changes, exports, preparation) until Ctrl+C
 *   wait-job <jobId>                    wait for an export, printing progress
 *
 * Output is JSON. Exit codes: 0 ok, 1 the call failed (error printed), 2 can't reach Before Effects.
 */
import { readFileSync } from "node:fs";
import { callMethod, connectionFile, NOT_RUNNING, ping, readConnection, request } from "./agent-shared.ts";

const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
const die = (code: number, v: unknown) => {
  process.stderr.write(`${typeof v === "string" ? v : JSON.stringify(v, null, 2)}\n`);
  process.exit(code);
};

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const main = async () => {
  const requestId = flag("id");
  const expect = flag("expect");
  const after = flag("after");
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(`be-agent — control the running Before Effects\n\n  status | methods [prefix] | describe <method> | call <method> [json|@file] [--id X] [--expect N] | events [--after N] | wait-job <id>\n\nConnection file: ${connectionFile()}\n`);
    return;
  }
  if (!(await ping())) die(2, NOT_RUNNING);

  switch (cmd) {
    case "status": {
      const r = await callMethod("project.get", {});
      return r.ok ? out({ connected: readConnection()?.url, ...(r.result as object) }) : die(1, r.error);
    }
    case "methods": {
      const caps = (await request("/v1/capabilities")) as { methods: Array<{ name: string; summary: string; changes: boolean }> };
      return out(caps.methods.filter((m) => !rest[0] || m.name.startsWith(rest[0])).map((m) => `${m.name}${m.changes ? " *" : ""} — ${m.summary}`));
    }
    case "describe": {
      const caps = (await request("/v1/capabilities")) as { methods: Array<{ name: string }>; envelope: unknown };
      const m = caps.methods.find((x) => x.name === rest[0]);
      return m ? out(m) : die(1, `No method "${rest[0]}". Try: be-agent methods`);
    }
    case "call": {
      const method = rest[0];
      if (!method) return die(1, "Usage: call <method> [json|@file.json]");
      const raw = rest.slice(1).join(" ").trim();
      let params: Record<string, unknown> = {};
      if (raw) {
        try {
          params = JSON.parse(raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw) as Record<string, unknown>;
        } catch {
          return die(1, "The parameters must be JSON (or @file.json).");
        }
      }
      if (expect !== undefined) params.expectRevision = Number(expect);
      const r = await callMethod(method, params, requestId ? { requestId } : {});
      return r.ok ? out(r) : die(1, r);
    }
    case "events": {
      const c = readConnection()!;
      const res = await fetch(`${c.url}/v1/events${after ? `?after=${after}` : ""}`, { headers: { authorization: `Bearer ${c.token}` } });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (data) process.stdout.write(`${data.slice(6)}\n`);
        }
      }
    }
    case "wait-job": {
      const job = rest[0];
      for (;;) {
        const r = await callMethod("jobs.get", { job });
        if (!r.ok) return die(1, r.error);
        const j = r.result as { state: string; done: number; frames: number; phase: string };
        process.stderr.write(`${j.state} ${j.done}/${j.frames} ${j.phase}\n`);
        if (["done", "failed", "cancelled"].includes(j.state)) return out(j);
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
    default:
      return die(1, `Unknown command "${cmd}". Run with no arguments for help.`);
  }
};

void main().catch((e: unknown) => die(2, String((e as Error)?.message ?? e)));

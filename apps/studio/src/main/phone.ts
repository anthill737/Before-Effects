/**
 * The phone camera for camera-assisted alignment. A phone on the same Wi-Fi opens a page served here
 * (from the QR code) and streams its camera: a small live view for the laptop, and full-size frames
 * when the alignment asks for one.
 *
 * Phone browsers only allow the camera on secure pages (getUserMedia needs a secure context), so the
 * page is served over HTTPS with a certificate made on this computer for its own network address. It
 * isn't from a certificate authority, so the phone warns once ("not private") and the person taps
 * through. The link carries a random token: nobody else on the network can open the page or send frames.
 * Everything stays on the local network.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { app, ipcMain } from "electron";
import QRCode from "qrcode";
import { generate } from "selfsigned";
import type { PhoneCapture, PhoneStatus } from "../shared/api.ts";
import { log } from "./log.ts";
import { editorWindow } from "./windows.ts";

const PORT = 47850;

interface Pending {
  readonly resolve: (c: PhoneCapture) => void;
  readonly reject: (e: Error) => void;
  readonly timer: NodeJS.Timeout;
}

let server: Server | null = null;
let token = "";
let url = "";
let ip = "";
let events: ServerResponse | null = null;
let keepAlive: NodeJS.Timeout | null = null;
let nextId = 1;
const pending = new Map<string, Pending>();
let lastPreviewSent = 0;
let session = "";
const state: { -readonly [K in keyof PhoneStatus]: PhoneStatus[K] } = {
  running: false,
  url: null,
  connected: false,
  device: null,
  camera: null,
  orientation: null,
  controls: null,
  wakeLock: null,
  lastSeen: null,
  lastFrame: null,
  message: null,
};

const dir = () => join(app.getPath("userData"), "align");

const send = (channel: string, payload: unknown) => {
  const w = editorWindow();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
};
const changed = () => send("phone:status", { ...state });

/** The laptop's address on the local network (Wi-Fi or Ethernet), preferring private ranges. */
const lanAddress = (): string | null => {
  const all = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, address: a.address })));
  const priv = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  // Virtual adapters (WSL, Hyper-V, VPNs) are rarely what the phone can reach.
  const virtual = (n: string) => /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Tailscale|ZeroTier/i.test(n);
  return (all.find((a) => priv(a.address) && !virtual(a.name)) ?? all.find((a) => priv(a.address)) ?? all[0])?.address ?? null;
};

/**
 * A certificate for this computer's address, kept between runs (the phone only warns again when the
 * address changes). SHA-256, a 2048-bit key, server use, the address in subjectAltName and under
 * 825 days: what iOS requires of TLS certificates.
 */
const certificateFor = async (address: string): Promise<{ key: string; cert: string }> => {
  mkdirSync(dir(), { recursive: true });
  const file = join(dir(), "phone-certificate.json");
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as { address: string; until: number; key: string; cert: string };
      if (c.address === address && c.until > Date.now() + 7 * 864e5) return c;
    } catch {
      // made again below
    }
  }
  const days = 800;
  const pems = await generate([{ name: "commonName", value: `Before Effects ${address}` }], {
    keySize: 2048,
    algorithm: "sha256",
    notBeforeDate: new Date(Date.now() - 864e5),
    notAfterDate: new Date(Date.now() + days * 864e5),
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: address }] },
    ],
  });
  const c = { address, until: Date.now() + days * 864e5, key: pems.private, cert: pems.cert };
  writeFileSync(file, JSON.stringify(c));
  return c;
};

const readBody = (req: import("node:http").IncomingMessage, limit = 24 * 1024 * 1024): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const disconnected = (why: string) => {
  if (!state.connected) return;
  state.connected = false;
  state.message = why;
  events = null;
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error("The phone disconnected."));
    pending.delete(id);
  }
  log(`phone: disconnected (${why})`);
  changed();
};

const start = async (): Promise<PhoneStatus> => {
  const address = lanAddress();
  if (!address) throw new Error("This computer isn't on a network the phone could reach (no Wi-Fi or Ethernet address).");
  if (server && address === ip) return { ...state };
  stop();
  ip = address;
  token = randomBytes(12).toString("hex");
  session = new Date().toISOString().replace(/[:.]/g, "-");
  const { key, cert } = await certificateFor(address);
  const base = `/p/${token}`;
  server = createServer({ key, cert }, (req, res) => {
    const u = new URL(req.url ?? "/", "https://x");
    res.setHeader("Cache-Control", "no-store");
    if (!u.pathname.startsWith(base)) {
      res.writeHead(404).end();
      return;
    }
    const sub = u.pathname.slice(base.length);
    if (req.method === "GET" && (sub === "" || sub === "/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PHONE_PAGE);
      return;
    }
    if (req.method === "GET" && sub === "/events") {
      // One phone at a time: a newer page takes over.
      events?.end();
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
      events = res;
      state.connected = true;
      state.device = summarizeAgent(req.headers["user-agent"] ?? "");
      state.message = null;
      state.lastSeen = Date.now();
      log(`phone: connected (${state.device})`);
      changed();
      req.on("close", () => {
        if (events === res) disconnected("The phone's page closed or lost the connection.");
      });
      return;
    }
    if (req.method === "POST" && sub === "/status") {
      void readBody(req, 64 * 1024).then((b) => {
        try {
          const s = JSON.parse(b.toString("utf8")) as Partial<PhoneStatus>;
          state.camera = s.camera ?? state.camera;
          state.orientation = s.orientation ?? state.orientation;
          state.controls = s.controls ?? state.controls;
          state.wakeLock = s.wakeLock ?? state.wakeLock;
          state.message = s.message ?? null;
          state.lastSeen = Date.now();
          changed();
        } catch {
          // ignore a malformed report
        }
        res.writeHead(204).end();
      }, () => res.writeHead(413).end());
      return;
    }
    if (req.method === "POST" && sub === "/frame") {
      const id = u.searchParams.get("id") ?? "";
      void readBody(req).then(
        (b) => {
          res.writeHead(204).end();
          state.lastSeen = Date.now();
          const w = Number(u.searchParams.get("w")) || 0;
          const h = Number(u.searchParams.get("h")) || 0;
          if (id === "preview") {
            // The live view: a few times a second at most.
            if (Date.now() - lastPreviewSent > 250) {
              lastPreviewSent = Date.now();
              send("phone:preview", { jpeg: new Uint8Array(b), width: w, height: h, at: Date.now() });
            }
            return;
          }
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id);
          clearTimeout(p.timer);
          mkdirSync(join(dir(), "captures", session), { recursive: true });
          const path = join(dir(), "captures", session, `${id}.jpg`);
          writeFileSync(path, b);
          state.lastFrame = { width: w, height: h, at: Date.now() };
          p.resolve({ id, path, jpeg: new Uint8Array(b), width: w, height: h, at: Date.now() });
        },
        () => res.writeHead(413).end(),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(PORT, "0.0.0.0", () => resolve());
  }).catch(async (e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE") throw e;
    // Another program has the usual port: any free one.
    await new Promise<void>((resolve) => server!.listen(0, "0.0.0.0", () => resolve()));
  });
  const port = (server.address() as import("node:net").AddressInfo).port;
  url = `https://${address}:${port}${base}`;
  keepAlive = setInterval(() => {
    events?.write(": keep-alive\n\n");
    if (state.connected && state.lastSeen && Date.now() - state.lastSeen > 20_000) disconnected("The phone stopped answering (screen off, or out of Wi-Fi?).");
  }, 5000);
  Object.assign(state, { running: true, url, connected: false, message: null });
  log(`phone: page at https://${address}:${port}/p/… (token hidden)`);
  changed();
  return { ...state };
};

const stop = () => {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error("The phone connection was closed."));
  }
  pending.clear();
  events?.end();
  events = null;
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
  server?.close();
  server?.closeAllConnections?.();
  server = null;
  Object.assign(state, { running: false, url: null, connected: false });
  changed();
};

/**
 * Ask the phone for a full-size frame taken at least `settleMs` after asking (so the projector's new
 * pattern is on the house and the camera has caught up).
 */
const capture = (o: { settleMs?: number; quality?: number } = {}): Promise<PhoneCapture> => {
  if (!events || !state.connected) return Promise.reject(new Error("The phone isn't connected."));
  const id = `f${String(nextId++).padStart(4, "0")}`;
  return new Promise<PhoneCapture>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The phone didn't send the picture in time (is its screen on and the page open?)."));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    events!.write(`data: ${JSON.stringify({ type: "capture", id, settleMs: o.settleMs ?? 250, quality: o.quality ?? 0.92 })}\n\n`);
  });
};

/** Ask the phone to hold its exposure, focus and white balance (where the browser allows), or let them go. */
const lock = (on: boolean) => {
  events?.write(`data: ${JSON.stringify({ type: "lock", on })}\n\n`);
};

const summarizeAgent = (ua: string): string => {
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Windows|Macintosh|Linux/.test(ua) ? "computer" : "phone";
  const br = /CriOS|Chrome/.test(ua) ? "Chrome" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "browser";
  return `${os}, ${br}`;
};

export const registerPhoneIpc = () => {
  ipcMain.handle("phone:start", async () => {
    const s = await start();
    const qrSvg = await QRCode.toString(s.url!, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { status: s, qrSvg };
  });
  ipcMain.handle("phone:stop", () => stop());
  ipcMain.handle("phone:status", () => ({ ...state }));
  ipcMain.handle("phone:capture", (_e, o?: { settleMs?: number; quality?: number }) => capture(o));
  ipcMain.handle("phone:lock", (_e, on: boolean) => lock(on));
  app.on("before-quit", stop);
};

// ---------------------------------------------------------------------------------------------
// The phone's page

const PHONE_PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Before Effects camera</title>
<style>
  html,body{margin:0;height:100%;background:#0b0d12;color:#e8eaf0;font:16px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
  main{display:flex;flex-direction:column;height:100%}
  video{flex:1;min-height:0;width:100%;object-fit:contain;background:#000}
  .bar{padding:12px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .state{font-weight:600}
  .ok{color:#7ee2a8}.warn{color:#ffc56b}.bad{color:#ff8a8a}
  button{font:inherit;padding:12px 18px;border-radius:10px;border:0;background:#3b82f6;color:#fff}
  .hint{color:#aab;font-size:14px;padding:0 16px 12px}
  .turn{position:fixed;inset:0;display:none;align-items:center;justify-content:center;text-align:center;background:#000c;font-size:22px;padding:24px}
  @media (orientation:portrait){.turn.on{display:flex}}
</style></head>
<body><main>
  <video id="v" playsinline muted autoplay></video>
  <div class="bar"><span id="s" class="state warn">Not started</span><button id="go">Start camera</button></div>
  <div class="hint" id="h">Put the phone on or right next to the projector, facing the house, and keep it still. Turn it sideways so the whole projected picture fits in view. Keep this page open with the screen on.</div>
</main>
<div class="turn" id="turn">Turn the phone sideways (landscape) so the house fits.</div>
<script>
(() => {
  const base = location.pathname.replace(/\\/$/, "");
  const v = document.getElementById("v"), s = document.getElementById("s"), go = document.getElementById("go"), turn = document.getElementById("turn");
  const say = (t, c) => { s.textContent = t; s.className = "state " + (c || ""); };
  let track = null, wake = null, busy = false, es = null, controls = {};
  const post = (path, body, type) => fetch(base + path, { method: "POST", body, headers: type ? { "Content-Type": type } : {} }).catch(() => {});
  const report = (message) => {
    const st = track ? track.getSettings() : {};
    const portrait = v.videoHeight > v.videoWidth;
    turn.classList.toggle("on", portrait);
    post("/status", JSON.stringify({
      camera: v.videoWidth ? { width: v.videoWidth, height: v.videoHeight, facing: st.facingMode || null } : null,
      orientation: v.videoWidth ? (portrait ? "portrait" : "landscape") : null,
      controls, wakeLock: wake ? "on" : ("wakeLock" in navigator ? "off" : "unsupported"), message: message || null,
    }), "application/json");
  };
  const keepAwake = async () => { try { if ("wakeLock" in navigator) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); } } catch { wake = null; } };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && track && !wake) keepAwake(); });
  // Hold exposure, focus and white balance during the alignment where the browser allows it.
  const lock = async (on) => {
    if (!track || !track.getCapabilities) { controls = { exposure: "unsupported", focus: "unsupported", whiteBalance: "unsupported" }; return report(); }
    const caps = track.getCapabilities();
    const out = {};
    for (const [k, name] of [["exposureMode", "exposure"], ["focusMode", "focus"], ["whiteBalanceMode", "whiteBalance"]]) {
      const modes = caps[k] || [];
      const want = on ? "manual" : (modes.includes("continuous") ? "continuous" : null);
      if (!want || !modes.includes(want)) { out[name] = modes.length ? "auto" : "unsupported"; continue; }
      try { await track.applyConstraints({ advanced: [{ [k]: want }] }); out[name] = on ? "locked" : "auto"; } catch { out[name] = "auto"; }
    }
    controls = out; report();
  };
  const grab = (maxW, quality) => new Promise((res) => {
    const w = v.videoWidth, h = v.videoHeight, k = Math.min(1, maxW / w);
    const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((b) => res({ b, w: c.width, h: c.height }), "image/jpeg", quality);
  });
  // A frame captured after the settle time, from a video frame that arrived after it (not a stale one).
  const freshFrame = (settleMs) => new Promise((res) => {
    const after = performance.now() + settleMs;
    const step = (now) => { if (now >= after) res(); else if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else setTimeout(() => step(performance.now()), 30); };
    setTimeout(() => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : step(performance.now())), settleMs);
  });
  const connect = () => {
    es && es.close();
    es = new EventSource(base + "/events");
    es.onopen = () => { say("Connected — leave the phone still", "ok"); report(); };
    es.onerror = () => say("Connection lost — reconnecting…", "bad");
    es.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "capture") {
        busy = true;
        say("Taking a picture…", "ok");
        await freshFrame(m.settleMs || 250);
        const f = await grab(4096, m.quality || 0.92);
        await post("/frame?id=" + m.id + "&w=" + f.w + "&h=" + f.h, f.b, "image/jpeg");
        busy = false;
        say("Connected — leave the phone still", "ok");
      } else if (m.type === "lock") lock(m.on);
    };
  };
  const preview = async () => {
    if (track && !busy && v.videoWidth && document.visibilityState === "visible") {
      const f = await grab(640, 0.6);
      await post("/frame?id=preview&w=" + f.w + "&h=" + f.h, f.b, "image/jpeg");
    }
    setTimeout(preview, 400);
  };
  go.onclick = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say("This page can't use the camera (open it with the link from the QR code, over https).", "bad"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      v.srcObject = stream; track = stream.getVideoTracks()[0];
      await v.play().catch(() => {});
      go.textContent = "Restart camera";
      track.addEventListener("ended", () => { say("The camera stopped — tap Restart camera", "bad"); report("camera stopped"); });
      await keepAwake();
      v.addEventListener("resize", () => report());
      connect(); preview(); setTimeout(() => report(), 800);
    } catch (err) {
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      say(denied ? "Camera permission was refused — allow the camera for this page in the browser's settings, then tap again." : "Couldn't start the camera: " + (err && err.message || err), "bad");
    }
  };
})();
</script></body></html>`;

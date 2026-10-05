/**
 * The phone camera for camera-assisted alignment. A phone on the same Wi-Fi opens a page served here
 * (from the QR code) and streams its camera: a small live view for the laptop, and full-size frames
 * when the alignment asks for one.
 *
 * Phone browsers only allow the camera on secure pages (getUserMedia needs a secure context), so the
 * page is HTTPS, with a certificate from this computer's own local authority (phoneCert.ts). Install
 * the authority on the phone once ("Trust this computer", served over plain HTTP on the next port) and
 * the page opens without warnings; otherwise the phone warns and the person taps through.
 * The link carries a random token kept between runs: nobody else on the network can open the page or
 * send frames. Everything stays on the local network.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { app, ipcMain, shell } from "electron";
import QRCode from "qrcode";
import type { PhoneCapture, PhoneStatus } from "../shared/api.ts";
import { log } from "./log.ts";
import { authority, mobileConfig, serverCertificate } from "./phoneCert.ts";
import { PHONE_PAGE, STALE_LINK_PAGE, trustPage } from "./phonePage.ts";
import { editorWindow } from "./windows.ts";

const PORT = 47850;

interface Pending {
  readonly resolve: (c: PhoneCapture) => void;
  readonly reject: (e: Error) => void;
  readonly timer: NodeJS.Timeout;
}

let server: Server | null = null;
let trustServer: HttpServer | null = null;
let token = "";
let ips: string[] = [];
let port = PORT;
let events: ServerResponse | null = null;
let keepAlive: NodeJS.Timeout | null = null;
let nextId = 1;
const pending = new Map<string, Pending>();
let lastPreviewSent = 0;
let session = "";
const state: { -readonly [K in keyof PhoneStatus]: PhoneStatus[K] } = {
  running: false,
  url: null,
  alternatives: [],
  trustUrl: null,
  authority: null,
  firewall: "unknown",
  connected: false,
  device: null,
  camera: null,
  orientation: null,
  controls: null,
  wakeLock: null,
  page: null,
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

/**
 * The laptop's addresses on local networks, best first: private ranges on real adapters (Wi-Fi,
 * Ethernet) before virtual ones (WSL, Hyper-V, VPNs), which the phone usually can't reach.
 */
export const lanAddresses = (): string[] => {
  const all = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, address: a.address })));
  const priv = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  const virtual = (n: string) => /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Tailscale|ZeroTier|VPN|TAP/i.test(n);
  const wifi = (n: string) => /Wi-?Fi|WLAN|Wireless/i.test(n);
  const score = (a: { name: string; address: string }) => (priv(a.address) ? 4 : 0) + (virtual(a.name) ? 0 : 2) + (wifi(a.name) ? 1 : 0);
  return all.sort((a, b) => score(b) - score(a)).map((a) => a.address);
};

/** A random token, kept between runs so a phone's saved link keeps working. */
const persistentToken = (): string => {
  const f = join(dir(), "phone-token");
  try {
    const t = readFileSync(f, "utf8").trim();
    if (/^[0-9a-f]{24}$/.test(t)) return t;
  } catch {
    // made below
  }
  const t = randomBytes(12).toString("hex");
  mkdirSync(dir(), { recursive: true });
  writeFileSync(f, t);
  return t;
};

/**
 * Windows Firewall: is there a rule blocking this program's incoming connections? (The first time it
 * listens, Windows asks; "Cancel" or a non-admin answer leaves block rules.)
 */
const checkFirewall = (): Promise<PhoneStatus["firewall"]> =>
  new Promise((resolve) => {
    if (process.platform !== "win32") return resolve("unknown");
    execFile("netsh", ["advfirewall", "firewall", "show", "rule", "name=all", "dir=in", "verbose"], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }, (err, out) => {
      if (err) return resolve("unknown");
      const exe = process.execPath.toLowerCase();
      const rules = out.split(/\r?\n\r?\n/).filter((b) => b.toLowerCase().includes(exe));
      if (!rules.length) return resolve("unknown");
      const enabled = rules.filter((b) => /Enabled:\s+Yes/i.test(b));
      const blocks = enabled.filter((b) => /Action:\s+Block/i.test(b) && /(Private|Any)/i.test(b.match(/Profiles:\s+(.*)/i)?.[1] ?? "Any"));
      const allows = enabled.filter((b) => /Action:\s+Allow/i.test(b));
      resolve(blocks.length ? "blocked" : allows.length ? "allowed" : "unknown");
    });
  });

const readBody = (req: IncomingMessage, limit = 24 * 1024 * 1024): Promise<Buffer> =>
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

const sameAddresses = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const start = async (): Promise<PhoneStatus> => {
  const addrs = lanAddresses();
  if (!addrs.length) throw new Error("This computer isn't on a network the phone could reach (no Wi-Fi or Ethernet address). Connect to the same Wi-Fi as the phone.");
  if (server && sameAddresses(addrs, ips)) return { ...state };
  stop();
  ips = addrs;
  token = persistentToken();
  session = new Date().toISOString().replace(/[:.]/g, "-");
  const { key, cert } = await serverCertificate(dir(), addrs);
  const ca = await authority(dir());
  const base = `/p/${token}`;
  server = createServer({ key, cert }, (req, res) => {
    const u = new URL(req.url ?? "/", "https://x");
    res.setHeader("Cache-Control", "no-store");
    if (!u.pathname.startsWith(base)) {
      // An old or mistyped link: say so on the phone instead of a bare error.
      res.writeHead(u.pathname.startsWith("/p/") ? 410 : 404, { "Content-Type": "text/html; charset=utf-8" }).end(STALE_LINK_PAGE);
      return;
    }
    const sub = u.pathname.slice(base.length);
    if (req.method === "GET" && (sub === "" || sub === "/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PHONE_PAGE);
      return;
    }
    if (req.method === "GET" && sub === "/events") {
      // One phone at a time: a newer page takes over and the older one is told.
      if (events) {
        events.write(`data: ${JSON.stringify({ type: "replaced" })}\n\n`);
        events.end();
      }
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
      void readBody(req, 64 * 1024).then(
        (b) => {
          try {
            const s = JSON.parse(b.toString("utf8")) as Partial<PhoneStatus>;
            if (s.camera !== undefined) state.camera = s.camera;
            if (s.orientation !== undefined) state.orientation = s.orientation;
            if (s.controls !== undefined) state.controls = s.controls;
            if (s.wakeLock !== undefined) state.wakeLock = s.wakeLock;
            if (s.page !== undefined) state.page = s.page;
            state.message = s.message ?? null;
            state.lastSeen = Date.now();
            changed();
          } catch {
            // ignore a malformed report
          }
          res.writeHead(204).end();
        },
        () => res.writeHead(413).end(),
      );
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
  port = await listen(server, PORT);
  // "Trust this computer": plain HTTP (it must open before the phone trusts anything), next port.
  trustServer = createHttpServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    res.setHeader("Cache-Control", "no-store");
    if (u.pathname === "/ca.crt") {
      res.writeHead(200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": 'attachment; filename="before-effects-local.crt"' }).end(ca.certDer);
      return;
    }
    if (u.pathname === "/ca.mobileconfig") {
      res.writeHead(200, { "Content-Type": "application/x-apple-aspen-config", "Content-Disposition": 'attachment; filename="before-effects.mobileconfig"' }).end(mobileConfig(ca));
      return;
    }
    if (u.pathname === "/" || u.pathname === "/trust") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(trustPage({ name: ca.name, fingerprint: ca.fingerprint, cameraUrl: `https://${ips[0]}:${port}${base}`, ua: req.headers["user-agent"] ?? "" }));
      return;
    }
    res.writeHead(404).end();
  });
  const trustPort = await listen(trustServer, port + 1).catch(() => 0);
  keepAlive = setInterval(() => {
    events?.write(": keep-alive\n\n");
    if (state.connected && state.lastSeen && Date.now() - state.lastSeen > 20_000) disconnected("The phone stopped answering (screen off, the page in the background, or out of Wi-Fi?).");
  }, 5000);
  Object.assign(state, {
    running: true,
    url: `https://${addrs[0]}:${port}${base}`,
    alternatives: addrs.slice(1).map((a) => `https://${a}:${port}${base}`),
    trustUrl: trustPort ? `http://${addrs[0]}:${trustPort}/` : null,
    authority: { name: ca.name, fingerprint: ca.fingerprint },
    connected: false,
    message: null,
  });
  log(`phone: page on ${addrs.join(", ")} port ${port} (token hidden); trust page port ${trustPort}`);
  changed();
  void checkFirewall().then((f) => {
    state.firewall = f;
    if (f === "blocked") log("phone: Windows Firewall blocks incoming connections to this program");
    changed();
  });
  return { ...state };
};

/** Listen on a port, or any free one if it's taken. */
const listen = (s: Server | HttpServer, want: number): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const onErr = (e: NodeJS.ErrnoException) => {
      if (e.code !== "EADDRINUSE") return reject(e);
      s.listen(0, "0.0.0.0", () => resolve((s.address() as import("node:net").AddressInfo).port));
    };
    s.once("error", onErr);
    s.listen(want, "0.0.0.0", () => {
      s.off("error", onErr);
      resolve((s.address() as import("node:net").AddressInfo).port);
    });
  });

const stop = () => {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error("The phone connection was closed."));
  }
  pending.clear();
  if (events) {
    events.write(`data: ${JSON.stringify({ type: "bye" })}\n\n`);
    events.end();
  }
  events = null;
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
  for (const s of [server, trustServer]) {
    s?.close();
    s?.closeAllConnections?.();
  }
  server = null;
  trustServer = null;
  Object.assign(state, { running: false, url: null, alternatives: [], trustUrl: null, connected: false });
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
      reject(new Error("The phone didn't send the picture in time (is its screen on and the page open in front?)."));
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
  const br = /CriOS|Chrome/.test(ua) ? "Chrome" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /EdgA|EdgiOS/.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Safari/.test(ua) ? "Safari" : "browser";
  return `${os}, ${br}`;
};

export const registerPhoneIpc = () => {
  ipcMain.handle("phone:start", async () => {
    const s = await start();
    const qr = (u: string) => QRCode.toString(u, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { status: s, qrSvg: await qr(s.url!), trustQrSvg: s.trustUrl ? await qr(s.trustUrl) : null };
  });
  ipcMain.handle("phone:stop", () => stop());
  ipcMain.handle("phone:status", () => ({ ...state }));
  ipcMain.handle("phone:capture", (_e, o?: { settleMs?: number; quality?: number }) => capture(o));
  ipcMain.handle("phone:lock", (_e, on: boolean) => lock(on));
  ipcMain.handle("phone:recheckFirewall", async () => {
    state.firewall = await checkFirewall();
    changed();
    return state.firewall;
  });
  // Windows' list of apps allowed through the firewall (the person changes it there).
  ipcMain.handle("phone:openFirewallSettings", () => {
    if (process.platform === "win32") execFile("control.exe", ["/name", "Microsoft.WindowsFirewall", "/page", "pageConfigureApps"], { windowsHide: false });
    else void shell.openExternal("https://support.apple.com/guide/mac-help/mh34041/mac");
  });
  app.on("before-quit", stop);
};

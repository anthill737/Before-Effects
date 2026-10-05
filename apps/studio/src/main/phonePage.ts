/**
 * Pages the phone opens: the camera page (HTTPS), "this link is out of date", and "Trust this
 * computer" (plain HTTP, so it opens before the phone trusts anything).
 */

const STYLE = `
  html,body{margin:0;min-height:100%;background:#0b0d12;color:#e8eaf0;font:16px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
  .wrap{padding:18px;max-width:640px;margin:0 auto}
  a{color:#7fb6ff}
  .ok{color:#7ee2a8}.warn{color:#ffc56b}.bad{color:#ff8a8a}.muted{color:#9aa3b2}
  button,select,.btn{font:inherit;padding:12px 16px;border-radius:10px;border:0;background:#3b82f6;color:#fff;text-decoration:none;display:inline-block}
  select{background:#1c2230;color:#e8eaf0;border:1px solid #3a4250;max-width:100%}
  ol{padding-left:20px}
  code{background:#1c2230;padding:1px 5px;border-radius:5px;font-size:13px;word-break:break-all}
`;

export const STALE_LINK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Before Effects camera</title><style>${STYLE}</style></head><body><div class="wrap">
<h2>This link is out of date</h2>
<p>Open <b>Auto-align with phone</b> on the computer and scan its QR code again.</p>
</div></body></html>`;

export const trustPage = (o: { name: string; fingerprint: string; cameraUrl: string; ua: string }): string => {
  const ios = /iPhone|iPad|iPod/.test(o.ua);
  const android = /Android/.test(o.ua);
  const iosSteps = `<ol>
    <li><a class="btn" href="/ca.mobileconfig">Download the profile</a> — tap <b>Allow</b>, then <b>Close</b>.</li>
    <li>Open <b>Settings</b> → <b>Profile Downloaded</b> (near the top) → <b>Install</b> → enter your passcode → <b>Install</b>.</li>
    <li>Then <b>Settings → General → About → Certificate Trust Settings</b> → turn on <b>${o.name}</b>.</li>
    <li><a href="${o.cameraUrl}">Open the camera page</a> — no warning this time.</li>
  </ol>`;
  const androidSteps = `<ol>
    <li><a class="btn" href="/ca.crt">Download the certificate</a>.</li>
    <li>Open <b>Settings</b>, search for <b>CA certificate</b> (or Security → Encryption &amp; credentials → Install a certificate → <b>CA certificate</b>), tap <b>Install anyway</b> and choose the downloaded file.</li>
    <li><a href="${o.cameraUrl}">Open the camera page</a> in Chrome — no warning this time.</li>
  </ol>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trust this computer — Before Effects</title><style>${STYLE}</style></head><body><div class="wrap">
<h2>Trust this computer (once)</h2>
<p>The camera page is secured with a certificate made by <b>${o.name}</b>. Installing it once on this phone removes the “not private” warning for good — even when the computer's address changes. It only works for addresses on local networks (it can't vouch for any website).</p>
${ios ? iosSteps : android ? androidSteps : `<h3>iPhone / iPad</h3>${iosSteps}<h3>Android</h3>${androidSteps}`}
<p class="muted">Certificate fingerprint (SHA-256): <code>${o.fingerprint}</code></p>
<p class="muted">You can skip this: on the camera page, the phone shows a warning — tap <b>Show details → visit this website</b> (iPhone) or <b>Advanced → Proceed</b> (Android).</p>
</div></body></html>`;
};

export const PHONE_PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Before Effects camera</title>
<style>${STYLE}
  main{display:flex;flex-direction:column;height:100vh}
  video{flex:1;min-height:0;width:100%;object-fit:contain;background:#000}
  .bar{padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .state{font-weight:600}
  .hint{font-size:14px;padding:0 14px 12px;color:#aab}
  .turn{position:fixed;inset:0;display:none;align-items:center;justify-content:center;text-align:center;background:#000c;font-size:22px;padding:24px}
  @media (orientation:portrait){.turn.on{display:flex}}
</style></head>
<body><main>
  <video id="v" playsinline muted autoplay></video>
  <div class="bar"><span id="s" class="state warn">Not started</span><button id="go">Start camera</button><select id="cam" hidden aria-label="Camera"></select></div>
  <div class="hint" id="h">Put the phone on or right next to the projector, facing the house, and keep it still. Turn it sideways so the whole projected picture fits in view. Keep this page open with the screen on.</div>
</main>
<div class="turn" id="turn">Turn the phone sideways (landscape) so the house fits.</div>
<script>
(() => {
  const base = location.pathname.replace(/\\/$/, "");
  const $ = (id) => document.getElementById(id);
  const v = $("v"), s = $("s"), go = $("go"), turn = $("turn"), camSel = $("cam"), hint = $("h");
  const say = (t, c) => { s.textContent = t; s.className = "state " + (c || ""); };
  let stream = null, track = null, wake = null, busy = false, es = null, controls = {}, cameras = [], over = false;
  const post = (path, body, type) => fetch(base + path, { method: "POST", body, headers: type ? { "Content-Type": type } : {} }).catch(() => {});
  const report = (message) => {
    const st = track ? track.getSettings() : {};
    const portrait = v.videoHeight > v.videoWidth;
    turn.classList.toggle("on", !!track && portrait);
    post("/status", JSON.stringify({
      camera: v.videoWidth ? { width: v.videoWidth, height: v.videoHeight, facing: st.facingMode || null } : null,
      orientation: v.videoWidth ? (portrait ? "portrait" : "landscape") : null,
      controls, wakeLock: wake ? "on" : ("wakeLock" in navigator ? "off" : "unsupported"),
      page: { secure: window.isSecureContext, cameras: cameras.map((c) => c.label || "camera"), camera: track ? track.label : null, zoom: st.zoom || null },
      message: message || null,
    }), "application/json");
  };
  const keepAwake = async () => { try { if ("wakeLock" in navigator) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; report(); }); } } catch { wake = null; } };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && track && !wake) keepAwake(); });
  // The main back camera: not the ultra-wide, telephoto or a multi-lens device that switches lenses by itself.
  const pickCamera = (list) => {
    const back = list.filter((d) => /back|rear|environment|facing back|arrière|trasera/i.test(d.label));
    const plain = back.filter((d) => !/ultra|wide angle|tele|dual|triple|depth|infrared|\\bir\\b|macro/i.test(d.label));
    return (plain[0] || back[0] || list[0] || null);
  };
  const explain = (err) => {
    const n = err && err.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "Camera permission was refused. Allow the camera for this page (the address bar's lock/“aA” menu, or the browser's site settings), then tap Start camera.";
    if (n === "NotReadableError" || n === "AbortError") return "The camera is busy — close other apps using it (camera, video calls), then tap Start camera.";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "No suitable camera was found. Try another camera in the list.";
    return "Couldn't start the camera: " + ((err && err.message) || err);
  };
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
    if (es) es.close();
    es = new EventSource(base + "/events");
    es.onopen = () => { if (!over) { say("Connected — leave the phone still", "ok"); report(); } };
    es.onerror = () => { if (!over) say("Connection lost — reconnecting… (same Wi-Fi? computer awake?)", "bad"); };
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
      else if (m.type === "replaced") { over = true; es.close(); say("Another phone took over the camera connection.", "warn"); }
      else if (m.type === "bye") { over = true; es.close(); say("The computer closed the camera connection. Scan the QR code again to reconnect.", "warn"); }
    };
  };
  const preview = async () => {
    if (track && !busy && v.videoWidth && document.visibilityState === "visible" && !over) {
      const f = await grab(640, 0.6);
      await post("/frame?id=preview&w=" + f.w + "&h=" + f.h, f.b, "image/jpeg");
    }
    setTimeout(preview, 400);
  };
  const open = async (deviceId) => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    const video = deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } };
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    v.srcObject = stream; track = stream.getVideoTracks()[0];
    await v.play().catch(() => {});
    // 1× zoom and no torch: the picture must stay the same through the alignment.
    try { const c = track.getCapabilities ? track.getCapabilities() : {}; const adv = []; if (c.zoom) adv.push({ zoom: Math.max(c.zoom.min || 1, 1) }); if (c.torch) adv.push({ torch: false }); if (adv.length) await track.applyConstraints({ advanced: adv }); } catch {}
    track.addEventListener("ended", () => { say("The camera stopped — tap Restart camera", "bad"); report("camera stopped"); });
  };
  const listCameras = async () => {
    try { cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"); } catch { cameras = []; }
    camSel.innerHTML = "";
    for (const c of cameras) { const o = document.createElement("option"); o.value = c.deviceId; o.textContent = c.label || "Camera"; camSel.appendChild(o); }
    camSel.hidden = cameras.length < 2;
    if (track) { const cur = cameras.find((c) => c.label === track.label); if (cur) camSel.value = cur.deviceId; }
  };
  camSel.onchange = async () => { try { await open(camSel.value); try { localStorage.setItem("be.camera", camSel.value); } catch {} report(); } catch (err) { say(explain(err), "bad"); } };
  go.onclick = async () => {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say("This page isn't secure, so the browser won't allow the camera. Open it with the link from the QR code (it starts with https://).", "bad");
      return;
    }
    try {
      let saved = null; try { saved = localStorage.getItem("be.camera"); } catch {}
      await open(saved).catch(() => open(null));
      // Labels are only known after permission: switch to the main back camera if another was chosen.
      await listCameras();
      if (!saved) { const best = pickCamera(cameras); if (best && best.label !== track.label) { await open(best.deviceId); await listCameras(); } }
      go.textContent = "Restart camera";
      await keepAwake();
      v.addEventListener("resize", () => report());
      connect(); preview(); setTimeout(() => report(), 800);
    } catch (err) {
      say(explain(err), "bad");
      report(explain(err));
    }
  };
  if (!window.isSecureContext) hint.textContent = "This page must be opened over https (scan the QR code on the computer).";
})();
</script></body></html>`;

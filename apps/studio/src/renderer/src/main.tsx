import { createRoot } from "react-dom/client";
import { runSpike } from "./spike.ts";

// Each window kind gets its own screen; see main/windows.ts.
const kind = window.be?.app.kind ?? "editor";
const root = () => createRoot(document.getElementById("root")!);

if (kind === "spike") {
  document.body.textContent = "Running Milestone A spike…";
  void runSpike().catch((e) => window.be.app.reportSpike({ ok: false, error: String(e?.stack ?? e) }));
} else if (kind === "preview") {
  void import("./preview/PopoutWindow.tsx").then(({ PopoutWindow }) => root().render(<PopoutWindow />));
} else if (kind === "output") {
  void import("./output/OutputWindow.tsx").then(({ OutputWindow }) => root().render(<OutputWindow />));
} else if (kind === "render") {
  void import("./render/RenderWorker.ts").then(({ startRenderWorker }) => startRenderWorker());
} else if (kind === "identify") {
  void import("./output/OutputWindow.tsx").then(({ IdentifyOverlay }) => root().render(<IdentifyOverlay />));
} else {
  if (kind === "uitest") void import("./uitest.ts");
  void import("./studio/App.tsx").then(({ App }) => root().render(<App />));
}

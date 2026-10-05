import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Workspace packages ship TypeScript sources, so they are bundled rather than externalised.
// The phone connection's certificate and QR code libraries are plain JavaScript: bundled too, so the
// packaged app needs nothing extra installed.
const bundled = ["@be/core", "@be/engine", "@be/media", "libheif-js", "selfsigned", "qrcode"];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: bundled },
      rollupOptions: {
        // The assistant's MCP bridge (and its test stand-in) run as separate Node processes.
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "mcp-bridge": resolve(__dirname, "src/main/mcp-bridge.ts"),
          "assistant-test-cli": resolve(__dirname, "src/main/assistant-test-cli.ts"),
          // External-agent clients: an MCP server and a command-line tool (plain Node).
          "agent-mcp": resolve(__dirname, "src/main/agent-mcp.ts"),
          "agent-cli": resolve(__dirname, "src/main/agent-cli.ts"),
          // HEIC/HEIF decoding (libheif WebAssembly) in a worker thread.
          "heic-worker": resolve(__dirname, "src/main/heic-worker.ts"),
          // House detection (open models through ONNX Runtime) in its own process.
          "detect-host": resolve(__dirname, "src/main/detect-host.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: bundled },
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    // three.js add-ons (glTF loading) import "three"; give them the same WebGPU build the engine
    // uses, so there's one copy of three.js and its objects work in the engine's scenes.
    resolve: { alias: [{ find: /^three$/, replacement: "three/webgpu" }] },
    build: {
      rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
      target: "esnext",
    },
    worker: { format: "es" },
  },
});

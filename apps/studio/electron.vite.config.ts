import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Workspace packages ship TypeScript sources, so they are bundled rather than externalised.
const bundled = ["@be/core", "@be/engine", "@be/media", "libheif-js"];

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
    build: {
      rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
      target: "esnext",
    },
    worker: { format: "es" },
  },
});

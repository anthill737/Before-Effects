import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Workspace packages ship TypeScript sources, so they are bundled rather than externalised.
const bundled = ["@be/core", "@be/engine", "@be/media"];

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

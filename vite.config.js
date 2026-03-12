import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Transformers.js ships its own WASM, exclude from Vite pre-bundling
    exclude: ["@xenova/transformers"],
  },
  server: {
    headers: {
      // Required for SharedArrayBuffer / WASM threading in Transformers.js
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});

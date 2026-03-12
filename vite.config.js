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
    proxy: {
      "/api/comfyui": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/comfyui/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("origin", "http://127.0.0.1:8000");
            proxyReq.setHeader("host", "127.0.0.1:8000");
          });
        },
      },
    },
  },
});

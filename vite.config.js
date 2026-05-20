import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync } from "fs";
import { resolve } from "path";

// Copia os assets do @ffmpeg/core-mt para public/ffmpeg/ no build
function copyFfmpegAssets() {
  return {
    name: "copy-ffmpeg-assets",
    buildStart() {
      const src = resolve("node_modules/@ffmpeg/core-mt/dist/esm");
      const dst = resolve("public/ffmpeg");
      mkdirSync(dst, { recursive: true });
      for (const f of ["ffmpeg-core.js", "ffmpeg-core.wasm", "ffmpeg-core.worker.js"]) {
        try { copyFileSync(`${src}/${f}`, `${dst}/${f}`); } catch {}
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyFfmpegAssets()],
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/core-mt"],
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy":   "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy: {
      "/api": {
        target: "http://localhost:8888/.netlify/functions",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync } from "fs";
import { resolve } from "path";

// Copia os assets do @ffmpeg/core para public/ffmpeg/ no build
function copyFfmpegAssets() {
  return {
    name: "copy-ffmpeg-assets",
    buildStart() {
      const src = resolve("node_modules/@ffmpeg/core/dist/esm");
      const dst = resolve("public/ffmpeg");
      mkdirSync(dst, { recursive: true });
      for (const f of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
        try { copyFileSync(`${src}/${f}`, `${dst}/${f}`); } catch {}
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyFfmpegAssets()],
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/core"],
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8888/.netlify/functions",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});

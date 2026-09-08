import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { referenceAssets } from "./tools/viteReferenceAssets";

const dbProxy = {
  "/snpedia.db": {
    target: "https://static.snpbrowser.com",
    changeOrigin: true,
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss(), referenceAssets()],
  build: { copyPublicDir: false },
  worker: { format: "es" },
  server: {
    proxy: dbProxy,
    watch: {
      ignored: [
        "**/public/references/**",
        "**/tools/reference/.cache/**",
        "**/.reference-cache/**",
        "**/__pycache__/**",
      ],
    },
  },
  preview: {
    proxy: dbProxy,
  },
});

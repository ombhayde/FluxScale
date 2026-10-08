import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,

    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },

      "/health": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },

  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },

  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 600,

    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("@visx") ||
            id.includes("/d3-") ||
            id.includes("react-use-measure") ||
            id.includes("internmap")
          ) {
            return "charts";
          }

          if (id.includes("/motion/")) {
            return "motion";
          }

          if (id.includes("@tanstack")) {
            return "query";
          }

          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "react-vendor";
          }

          if (
            id.includes("radix-ui") ||
            id.includes("class-variance-authority")
          ) {
            return "ui-vendor";
          }

          return undefined;
        },
      },
    },
  },
});
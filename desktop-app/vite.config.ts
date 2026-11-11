import { defineConfig } from "vite";

// Two pages: the caption overlay (index.html) and the settings window.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: { main: "index.html", settings: "settings.html" },
    },
  },
});

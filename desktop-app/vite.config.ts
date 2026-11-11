import { defineConfig } from "vite";

// Two pages: the caption overlay (index.html) and the settings window.
export default defineConfig({
  clearScreen: false,
  server: {
    // Bind to IPv4 loopback explicitly. On Windows "localhost" often resolves
    // to ::1 only, and `tauri dev` (devUrl below) would then wait forever.
    // Keep this in sync with build.devUrl in src-tauri/tauri.conf.json.
    host: "127.0.0.1",
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

import { defineConfig } from "vite";
import { wasp } from "wasp/client/vite";

// For the demo the app is reached through one temporary public HTTPS origin (a tunnel to this dev server).
// The dev server forwards the Wasp server's paths, so pages, operations and the ElevenLabs webhook share that origin.
const waspServer = "http://localhost:3001";

export default defineConfig({
  plugins: [wasp()],
  server: {
    open: false,
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/api": waspServer,
      "/operations": waspServer,
      "/health": waspServer,
    },
  },
});

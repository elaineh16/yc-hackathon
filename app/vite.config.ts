import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { wasp } from "wasp/client/vite";

export default defineConfig({
  plugins: [wasp(), tailwindcss()],
  server: {
    open: false,
  },
  // Pre-bundle everything the pages import, so the dev server never reloads the browser mid-session
  // when a page with a new dependency is opened for the first time.
  optimizeDeps: {
    include: ["@elevenlabs/react", "@radix-ui/react-dialog", "@radix-ui/react-slot", "class-variance-authority", "clsx", "lucide-react", "tailwind-merge"],
  },
});

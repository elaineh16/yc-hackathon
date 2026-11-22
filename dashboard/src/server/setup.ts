// Wasp server setupFn: runs once at startup.
import { initTracing } from "./tracing.js";

export const serverSetup = async () => {
  await initTracing();
};

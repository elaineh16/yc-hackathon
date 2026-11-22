import "dotenv/config";
import cors from "cors";
import express from "express";
import path from "node:path";
import { isDryRun } from "./elevenlabs.js";
import { api } from "./routes/api.js";
import { tools } from "./routes/tools.js";
import { webhooks } from "./routes/webhooks.js";

const app = express();
app.use(cors());
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString("utf8");
    },
  }),
);

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/tools", tools);
app.use("/webhooks", webhooks);
app.use("/api", api);

// Fallback dashboard (plain HTML). The real one lives in /dashboard (Wasp).
app.use("/", express.static(path.resolve(process.cwd(), "public")));

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`Super backend on http://localhost:${port}  ${isDryRun() ? "(DRY RUN: no real calls)" : "(LIVE calls)"}`);
});

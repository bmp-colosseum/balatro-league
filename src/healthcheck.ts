// Minimal HTTP server for Railway's health check.
// The bot is a Discord gateway client — it doesn't serve traffic — but Railway
// kills containers that don't bind to $PORT. This tiny server makes Railway happy.

import { createServer } from "node:http";
import { renderMetrics } from "./metrics.js";
import { getCachedHealth } from "./bot-health.js";

export function startHealthCheck(): void {
  const port = parseInt(process.env.PORT ?? "8080", 10);
  const server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      // Railway only cares about the 200 -- never fail this on a "degraded"
      // snapshot, that would get the whole container killed over e.g. slow
      // Discord REST calls. The full snapshot lives at /health/status for
      // anyone (us) who wants to actually read it.
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }
    if (req.url === "/health/status") {
      const health = getCachedHealth();
      res.writeHead(health ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health ?? { error: "no health snapshot cached yet" }));
      return;
    }
    if (req.url === "/metrics") {
      // Async render inside a sync callback: resolve, then respond. A render
      // failure must not crash the process -- answer 500 instead.
      renderMetrics()
        .then(({ contentType, body }) => {
          res.writeHead(200, { "Content-Type": contentType });
          res.end(body);
        })
        .catch((err) => {
          console.warn("[metrics] render failed:", err);
          // The 200 path may have already sent headers before throwing --
          // a second writeHead would raise ERR_HTTP_HEADERS_SENT inside
          // this catch and become an unhandled rejection.
          if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("metrics render failed");
        });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found — the bot has no public pages. Visit www.balatroleague.com for the dashboard.");
  });
  server.listen(port, () => {
    console.log(`[healthcheck] listening on :${port}`);
  });
}

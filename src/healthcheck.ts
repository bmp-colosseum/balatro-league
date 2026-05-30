// Minimal HTTP server for Railway's health check.
// The bot is a Discord gateway client — it doesn't serve traffic — but Railway
// kills containers that don't bind to $PORT. This tiny server makes Railway happy.

import { createServer } from "node:http";

export function startHealthCheck(): void {
  const port = parseInt(process.env.PORT ?? "8080", 10);
  const server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found — the bot has no public pages. Visit www.balatroleague.com for the dashboard.");
  });
  server.listen(port, () => {
    console.log(`[healthcheck] listening on :${port}`);
  });
}

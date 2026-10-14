// Shared dynamic-port helper — binds a throwaway TCP listener on port 0 (or
// a preferred port) to ask the OS for an actually-free port, then releases
// it immediately. Used by e2e/server.mjs, scripts/verify-env.mjs (both
// import findFreePort directly — they're ESM .mjs, so top-level await just
// works) and playwright.config.ts (a TS/CJS-ish config file, which instead
// shells out to this file's CLI mode via execFileSync so it doesn't need to
// deal with top-level await across loader boundaries).
//
// Two agents running `npm run e2e` or `verify-env.mjs` concurrently used to
// collide on a single hardcoded port (54330 for Postgres, 3210 for Next).
// Every caller now asks for its own free port instead.

import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

// Resolves with a free TCP port. Tries `preferred` first (0 = "any"); if
// `preferred` is already taken, falls back to asking for any free port.
export function findFreePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", (err) => {
      if (preferred !== 0) {
        findFreePort(0).then(resolve, reject);
      } else {
        reject(err);
      }
    });
    srv.listen(preferred, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : null;
      srv.close(() => {
        if (port) resolve(port);
        else reject(new Error("could not determine bound port"));
      });
    });
  });
}

// CLI mode: `node get-free-port.mjs [preferred]` prints the chosen port to
// stdout (and nothing else), so a non-ESM caller (playwright.config.ts) can
// capture it synchronously via execFileSync.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const preferred = Number(process.argv[2]) || 0;
  findFreePort(preferred)
    .then((port) => process.stdout.write(String(port)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Load the bot .env so modules that transitively import db/env (e.g.
    // standings.ts → league-settings.ts) can be imported. Tests stay offline —
    // Prisma instantiates but never connects (the logic under test is pure).
    setupFiles: ["./vitest.setup.ts"],
    // web/ has no test runner of its own (Playwright e2e only) -- the pure
    // parsers behind web/app/admin/host (web/lib/host-metrics-parsers.ts)
    // have zero imports (no "server-only", no node:fs, no @ path aliases),
    // so they're safe to run here too instead of inventing a second runner.
    include: ["src/**/*.test.ts", "web/lib/**/*.test.ts"],
    // Integration tests (real Postgres) run via vitest.integration.config.ts.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});

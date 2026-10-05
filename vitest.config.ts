import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, configDefaults } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Mirrors web/tsconfig.json's "@/*": ["./*"] so a web/lib pure-core file
    // that imports a sibling via "@/lib/..." (the project's normal
    // convention, e.g. web/lib/standings.ts) still resolves here -- most
    // web/lib test subjects avoid the alias entirely (plain "./foo.js"), but
    // one that needs to reuse logic from an alias-importing file shouldn't
    // have to rewrite that file's import style just to become testable.
    alias: { "@": path.resolve(__dirname, "web") },
  },
  test: {
    environment: "node",
    // Load the bot .env so modules that transitively import db/env (e.g.
    // standings.ts → league-settings.ts) can be imported. Tests stay offline —
    // Prisma instantiates but never connects (the logic under test is pure).
    setupFiles: ["./vitest.setup.ts"],
    // web/ has no test runner of its own (Playwright e2e only) -- most pure
    // cores under web/lib (e.g. host-metrics-parsers.ts) have zero imports,
    // so they're safe to run here too instead of inventing a second runner.
    include: ["src/**/*.test.ts", "web/lib/**/*.test.ts"],
    // Integration tests (real Postgres) run via vitest.integration.config.ts.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});

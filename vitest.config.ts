import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Load the bot .env so modules that transitively import db/env (e.g.
    // standings.ts → league-settings.ts) can be imported. Tests stay offline —
    // Prisma instantiates but never connects (the logic under test is pure).
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});

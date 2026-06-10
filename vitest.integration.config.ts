import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./vitest.integration-global.ts"],
    setupFiles: ["./vitest.integration-setup.ts"],
    include: ["src/**/*.integration.test.ts"],
    // One shared DB → run serially in a single process to avoid cross-test races.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 120_000, // first run downloads/initialises Postgres
  },
});

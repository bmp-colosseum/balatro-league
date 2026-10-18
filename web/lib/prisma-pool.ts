// Pool settings for the Prisma 7 pg driver adapter. Pure: no env, no client.
//
// Prisma 7 hands pooling to node-pg. These constants replace the Prisma 6
// `connection_limit=5&pool_timeout=20` URL rewrite. Mirrors src/db-pool.ts; the two
// are tuned independently (web is a standalone project and cannot import from src/).
import type { PoolConfig } from "pg";

// Connection budget: bot 5 + pg-boss 3, and web 5 per container with two web
// containers alive during a rolling deploy. Unchanged from the Prisma 6 setup.
export const DB_POOL_MAX = 5;
// pg-pool applies this one timeout to opening a connection AND to waiting for
// a free client, matching the old pool_timeout=20.
export const DB_CONNECTION_TIMEOUT_MS = 20_000;
// Same as the pg default; stated so the value is visible.
export const DB_IDLE_TIMEOUT_MS = 10_000;

// An unset connection string passes through as undefined: nothing throws at
// module load (next build imports lib/prisma.ts with no URL) and the first
// query fails, as it did before the adapter.
export function poolConfigFor(connectionString: string | undefined): PoolConfig {
  return {
    connectionString,
    max: DB_POOL_MAX,
    connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
  };
}

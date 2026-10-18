// Pool settings for the Prisma 7 pg driver adapter. Pure: no env, no client.
//
// Prisma 7 hands pooling to node-pg. These constants replace the Prisma 6
// `connection_limit=5&pool_timeout=20` URL rewrite.
import type { PoolConfig } from "pg";

// Railway-era budget: 5 here + 3 for pg-boss keeps the bot well under the
// Postgres connection cap shared with the web app and scripts.
export const DB_POOL_MAX = 5;
// pg-pool applies this one timeout to opening a connection AND to waiting for
// a free client. 20s matches the old pool_timeout=20 so sweeps, season build
// and long $transaction calls queued behind busy connections do not time out.
export const DB_CONNECTION_TIMEOUT_MS = 20_000;
// Same as the pg default; stated so the value is visible.
export const DB_IDLE_TIMEOUT_MS = 10_000;

// An unset connection string passes through as undefined: nothing throws at
// module load and the first query fails, as it did before the adapter.
export function poolConfigFor(connectionString: string | undefined): PoolConfig {
  return {
    connectionString,
    max: DB_POOL_MAX,
    connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
  };
}

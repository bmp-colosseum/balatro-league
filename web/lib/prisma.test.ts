import { describe, expect, it } from "vitest";
import { DB_CONNECTION_TIMEOUT_MS, DB_IDLE_TIMEOUT_MS, DB_POOL_MAX, poolConfigFor } from "./prisma-pool";

describe("poolConfigFor", () => {
  it("pins the pool limits and passes the URL through", () => {
    expect(poolConfigFor("postgresql://u:p@h:5432/db")).toEqual({
      connectionString: "postgresql://u:p@h:5432/db",
      max: 5,
      connectionTimeoutMillis: 20_000,
      idleTimeoutMillis: 10_000,
    });
  });

  it("does not throw when DATABASE_URL is unset", () => {
    expect(poolConfigFor(undefined).connectionString).toBeUndefined();
  });

  it("exposes the limits as constants", () => {
    expect([DB_POOL_MAX, DB_CONNECTION_TIMEOUT_MS, DB_IDLE_TIMEOUT_MS]).toEqual([5, 20_000, 10_000]);
  });
});

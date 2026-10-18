import { describe, expect, it } from "vitest";
import { poolConfigFor } from "./db-pool.js";

describe("poolConfigFor", () => {
  it("caps the pool and sets explicit timeouts", () => {
    const cfg = poolConfigFor("postgres://u:p@h:5432/d");
    expect(cfg).toEqual({
      connectionString: "postgres://u:p@h:5432/d",
      max: 5,
      connectionTimeoutMillis: 20_000,
      idleTimeoutMillis: 10_000,
    });
  });

  it("does not throw when the connection string is unset", () => {
    const cfg = poolConfigFor(undefined);
    expect(cfg.connectionString).toBeUndefined();
    expect(cfg.max).toBe(5);
  });
});

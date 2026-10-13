import { describe, it, expect } from "vitest";
import { isStaleStandingsPayload, STANDINGS_PAYLOAD_VERSION } from "./standings-cache";

describe("isStaleStandingsPayload", () => {
  it("treats a payload with no version (pre-2026-10-13 rows) as stale", () => {
    expect(isStaleStandingsPayload({})).toBe(true);
  });
  it("treats older versions as stale and the current one as fresh", () => {
    expect(isStaleStandingsPayload({ version: STANDINGS_PAYLOAD_VERSION - 1 })).toBe(true);
    expect(isStaleStandingsPayload({ version: STANDINGS_PAYLOAD_VERSION })).toBe(false);
    expect(isStaleStandingsPayload({ version: STANDINGS_PAYLOAD_VERSION + 1 })).toBe(false);
  });
});

// Table tests for the pure /api/health decision core -- see health-core.ts's header
// comment for why this lives in web/lib and is picked up by the ROOT vitest project
// (vitest.config.ts's `include: ["web/lib/**/*.test.ts"]`), not a web-local runner.

import { describe, it, expect } from "vitest";
import { buildHealthResult, type HealthInput } from "./health-core.js";

describe("buildHealthResult", () => {
  it.each<[string, HealthInput, { status: 200 | 503; ok: boolean }]>([
    ["db reachable -> 200 ok", { dbReachable: true, sha: "abc123", uptimeSeconds: 42 }, { status: 200, ok: true }],
    ["db unreachable -> 503 not ok", { dbReachable: false, sha: "abc123", uptimeSeconds: 42 }, { status: 503, ok: false }],
  ])("%s", (_name, input, expected) => {
    const result = buildHealthResult(input);
    expect(result.status).toBe(expected.status);
    expect(result.body.ok).toBe(expected.ok);
  });

  it("includes sha and floored uptime in a healthy response", () => {
    const result = buildHealthResult({ dbReachable: true, sha: "deadbeef", uptimeSeconds: 12.9 });
    expect(result).toEqual({
      status: 200,
      body: { ok: true, sha: "deadbeef", uptimeSeconds: 12 },
    });
  });

  it("never leaks sha or uptime on an unhealthy response", () => {
    const result = buildHealthResult({ dbReachable: false, sha: "deadbeef", uptimeSeconds: 12 });
    expect(result).toEqual({ status: 503, body: { ok: false } });
  });

  it.each<[string, number]>([
    ["negative uptime clamps to 0", -5],
    ["NaN uptime clamps to 0", NaN],
    ["Infinity uptime clamps to 0", Infinity],
  ])("%s", (_name, uptimeSeconds) => {
    const result = buildHealthResult({ dbReachable: true, sha: "x", uptimeSeconds });
    expect(result.body).toEqual({ ok: true, sha: "x", uptimeSeconds: 0 });
  });
});

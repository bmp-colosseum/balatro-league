import { describe, it, expect } from "vitest";
import { buildBotStatusRenderKey, buildHealthEmbed } from "./bot-status-content.js";
import type { BotHealth } from "./bot-health.js";

const checkedAt = new Date("2026-08-04T12:00:00.000Z");

// A fully-healthy baseline BotHealth snapshot -- individual tests override
// just the field(s) under test, same convention as bot-health.test.ts's
// healthyInputs().
function healthyHealth(overrides: Partial<BotHealth> = {}): BotHealth {
  return {
    level: "ok",
    checkedAt,
    discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "ok" },
    db: { latencyMs: 5, ok: true },
    queue: { stalled: [], ok: true },
    notes: ["All systems normal."],
    ...overrides,
  };
}

describe("buildBotStatusRenderKey", () => {
  it("is deterministic -- the same snapshot produces the same key", () => {
    const health = healthyHealth();
    expect(buildBotStatusRenderKey(health)).toBe(buildBotStatusRenderKey(healthyHealth()));
  });

  it("changes when the overall level changes", () => {
    const ok = buildBotStatusRenderKey(healthyHealth({ level: "ok" }));
    const degraded = buildBotStatusRenderKey(
      healthyHealth({ level: "degraded", discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "degraded" } }),
    );
    expect(degraded).not.toBe(ok);
  });

  it("changes when the discord subsystem level changes even if overall level doesn't", () => {
    const a = buildBotStatusRenderKey(healthyHealth());
    const b = buildBotStatusRenderKey(
      healthyHealth({ discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "degraded" } }),
    );
    expect(b).not.toBe(a);
  });

  it("changes when REST p95 crosses a rounding bucket (material latency change)", () => {
    const a = buildBotStatusRenderKey(healthyHealth({ discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "ok" } }));
    const b = buildBotStatusRenderKey(healthyHealth({ discord: { gatewayPingMs: 40, restP95Ms: 900, restErrorRate: 0, level: "ok" } }));
    expect(b).not.toBe(a);
  });

  it("changes when the set of stalled queues changes", () => {
    const a = buildBotStatusRenderKey(healthyHealth());
    const b = buildBotStatusRenderKey(healthyHealth({ queue: { stalled: ["email"], ok: false } }));
    expect(b).not.toBe(a);
  });

  it("changes when db reachability flips even at the same latency", () => {
    const a = buildBotStatusRenderKey(healthyHealth());
    const b = buildBotStatusRenderKey(healthyHealth({ db: { latencyMs: 5, ok: false } }));
    expect(b).not.toBe(a);
  });

  it("does NOT change on trivial sub-100ms jitter within the same rounding bucket", () => {
    // Rounds to the nearest 100ms: 40 & 45 both round to 0, 150 & 190 both
    // round to 200 -- a real ~10-40ms measurement wobble, same bucket.
    const a = buildBotStatusRenderKey(healthyHealth({ discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "ok" } }));
    const b = buildBotStatusRenderKey(healthyHealth({ discord: { gatewayPingMs: 45, restP95Ms: 190, restErrorRate: 0, level: "ok" } }));
    expect(b).toBe(a);
  });

  it("does NOT change on trivial db-latency jitter within the same rounding bucket", () => {
    const a = buildBotStatusRenderKey(healthyHealth({ db: { latencyMs: 5, ok: true } }));
    const b = buildBotStatusRenderKey(healthyHealth({ db: { latencyMs: 30, ok: true } }));
    expect(b).toBe(a);
  });

  it("does NOT change on a sub-1%-point error-rate jitter within the same rounding bucket", () => {
    const a = buildBotStatusRenderKey(healthyHealth({ discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0.001, level: "ok" } }));
    const b = buildBotStatusRenderKey(healthyHealth({ discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0.004, level: "ok" } }));
    expect(b).toBe(a);
  });

  it("does NOT change just because checkedAt (the timestamp) is different -- timestamps aren't material", () => {
    const a = buildBotStatusRenderKey(healthyHealth({ checkedAt }));
    const b = buildBotStatusRenderKey(healthyHealth({ checkedAt: new Date(checkedAt.getTime() + 5 * 60_000) }));
    expect(b).toBe(a);
  });

  it("is order-independent for stalled queue names (sorted before joining)", () => {
    const a = buildBotStatusRenderKey(healthyHealth({ queue: { stalled: ["email", "matches"], ok: false } }));
    const b = buildBotStatusRenderKey(healthyHealth({ queue: { stalled: ["matches", "email"], ok: false } }));
    expect(b).toBe(a);
  });
});

describe("buildHealthEmbed", () => {
  it("renders the level + emoji into the title and reflects db/discord/queue values in the fields", () => {
    const embed = buildHealthEmbed(
      healthyHealth({
        level: "degraded",
        discord: { gatewayPingMs: 40, restP95Ms: 4300, restErrorRate: 0.2, level: "degraded" },
        db: { latencyMs: 12, ok: true },
        queue: { stalled: ["email"], ok: false },
        notes: ["Discord REST is slow: p95 4300ms (over 2000ms)."],
      }),
    );
    expect(embed.data.title).toContain("DEGRADED");
    const fields = embed.data.fields ?? [];
    const discordField = fields.find((f) => f.name === "Discord");
    const dbField = fields.find((f) => f.name === "Database");
    const queueField = fields.find((f) => f.name === "Queue");
    const notesField = fields.find((f) => f.name === "Notes");
    expect(discordField?.value).toContain("4300ms");
    expect(discordField?.value).toContain("20.0%");
    expect(dbField?.value).toContain("reachable");
    expect(dbField?.value).toContain("12ms");
    expect(queueField?.value).toContain("email");
    expect(notesField?.value).toContain("Discord REST is slow");
  });

  it("shows the relative-timestamp format so the message stays visually fresh client-side without an edit", () => {
    const embed = buildHealthEmbed(healthyHealth());
    const unix = Math.floor(checkedAt.getTime() / 1000);
    expect(embed.data.description).toBe(`Last checked <t:${unix}:R>`);
  });

  it("renders 'insufficient data' for null latency/rate fields instead of crashing on the missing number", () => {
    const embed = buildHealthEmbed(
      healthyHealth({ discord: { gatewayPingMs: null, restP95Ms: null, restErrorRate: null, level: "ok" } }),
    );
    const discordField = embed.data.fields?.find((f) => f.name === "Discord");
    expect(discordField?.value).toContain("insufficient data");
  });
});

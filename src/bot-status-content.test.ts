import { describe, it, expect } from "vitest";
import { buildBotStatusRenderKey, buildHealthEmbed, buildPublicHealthEmbed } from "./bot-status-content.js";
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

// The render key is now scoped to exactly what buildPublicHealthEmbed shows
// (see bot-status-content.ts's header + buildBotStatusRenderKey doc): the
// overall level, plus -- only when degraded -- whether the cause is
// player-impacting. Anything else (exact numbers, which queue is stalled,
// the timestamp) is invisible to players and must NOT move the key.
describe("buildBotStatusRenderKey", () => {
  it("is deterministic -- the same snapshot produces the same key", () => {
    const health = healthyHealth();
    expect(buildBotStatusRenderKey(health)).toBe(buildBotStatusRenderKey(healthyHealth()));
  });

  it("changes when the overall level changes (ok -> degraded -> down)", () => {
    const ok = buildBotStatusRenderKey(healthyHealth());
    const degraded = buildBotStatusRenderKey(
      healthyHealth({ level: "degraded", discord: { gatewayPingMs: 40, restP95Ms: 2500, restErrorRate: 0, level: "degraded" } }),
    );
    const down = buildBotStatusRenderKey(healthyHealth({ level: "down", db: { latencyMs: null, ok: false } }));
    expect(degraded).not.toBe(ok);
    expect(down).not.toBe(degraded);
    expect(down).not.toBe(ok);
  });

  it("changes between a Discord-caused degraded and an internal-only (queue-stall) degraded -- players are told a different story", () => {
    const discordCaused = buildBotStatusRenderKey(
      healthyHealth({
        level: "degraded",
        discord: { gatewayPingMs: 40, restP95Ms: 2500, restErrorRate: 0, level: "degraded" },
        queue: { stalled: [], ok: true },
      }),
    );
    const queueOnly = buildBotStatusRenderKey(
      healthyHealth({
        level: "degraded",
        discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "ok" },
        queue: { stalled: ["snapshot.mmr"], ok: false },
      }),
    );
    expect(discordCaused).not.toBe(queueOnly);
  });

  it("does NOT change on internal-only numeric jitter -- gateway ping / REST p95 / REST error rate / db latency", () => {
    const a = buildBotStatusRenderKey(
      healthyHealth({ discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "ok" }, db: { latencyMs: 5, ok: true } }),
    );
    const b = buildBotStatusRenderKey(
      healthyHealth({ discord: { gatewayPingMs: 900, restP95Ms: 1900, restErrorRate: 0.02, level: "ok" }, db: { latencyMs: 300, ok: true } }),
    );
    expect(b).toBe(a);
  });

  it("does NOT change when the set of stalled queue NAMES changes while the player-impact classification stays the same", () => {
    const a = buildBotStatusRenderKey(
      healthyHealth({
        level: "degraded",
        discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "ok" },
        queue: { stalled: ["email"], ok: false },
      }),
    );
    const b = buildBotStatusRenderKey(
      healthyHealth({
        level: "degraded",
        discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "ok" },
        queue: { stalled: ["snapshot.mmr", "notify.announce-result"], ok: false },
      }),
    );
    expect(b).toBe(a);
  });

  it("does NOT change just because checkedAt (the timestamp) is different -- timestamps aren't material", () => {
    const a = buildBotStatusRenderKey(healthyHealth({ checkedAt }));
    const b = buildBotStatusRenderKey(healthyHealth({ checkedAt: new Date(checkedAt.getTime() + 5 * 60_000) }));
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

describe("buildPublicHealthEmbed", () => {
  function embedText(embed: ReturnType<typeof buildPublicHealthEmbed>): string {
    return `${embed.data.title ?? ""} ${embed.data.description ?? ""}`;
  }

  it("ok: friendly all-clear, no admin jargon", () => {
    const embed = buildPublicHealthEmbed(healthyHealth());
    expect(embed.data.title).toContain("Everything's working");
    expect(embed.data.description).toContain("running normally");
  });

  it("degraded, Discord-caused (player-visible): explains the visible symptom in plain English", () => {
    const embed = buildPublicHealthEmbed(
      healthyHealth({
        level: "degraded",
        discord: { gatewayPingMs: 40, restP95Ms: 4300, restErrorRate: 0.2, level: "degraded" },
      }),
    );
    expect(embed.data.title).toContain("Some things may be slow");
    expect(embed.data.description).toContain("Discord is responding slowly");
  });

  it("degraded, internal-only (a queue backlog with Discord/db fine): neutral, doesn't alarm players", () => {
    const embed = buildPublicHealthEmbed(
      healthyHealth({
        level: "degraded",
        discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "ok" },
        queue: { stalled: ["snapshot.mmr"], ok: false },
      }),
    );
    expect(embed.data.title).toContain("Some things may be slow");
    expect(embed.data.description).toContain("background issue");
    expect(embed.data.description).not.toContain("snapshot.mmr");
  });

  it("down: says the bot is having problems and admins are on it", () => {
    const embed = buildPublicHealthEmbed(healthyHealth({ level: "down", db: { latencyMs: null, ok: false } }));
    expect(embed.data.title).toContain("having problems");
    expect(embed.data.description).toContain("Admins have been notified");
  });

  it("includes a relative last-checked timestamp", () => {
    const embed = buildPublicHealthEmbed(healthyHealth());
    const unix = Math.floor(checkedAt.getTime() / 1000);
    expect(embed.data.description).toContain(`<t:${unix}:R>`);
  });

  it("never contains raw ms/percentage numbers or queue names, even for a degraded-with-queue-stall snapshot", () => {
    const embed = buildPublicHealthEmbed(
      healthyHealth({
        level: "degraded",
        discord: { gatewayPingMs: 1234, restP95Ms: 4300, restErrorRate: 0.42, level: "degraded" },
        db: { latencyMs: 999, ok: true },
        queue: { stalled: ["snapshot.mmr", "notify.announce-result"], ok: false },
      }),
    );
    const text = embedText(embed);
    expect(text).not.toMatch(/\d+ms/);
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text).not.toContain("snapshot.mmr");
    expect(text).not.toContain("notify.announce-result");
  });

  it("distinguishes ok, degraded, and down with three different titles", () => {
    const ok = buildPublicHealthEmbed(healthyHealth()).data.title;
    const degraded = buildPublicHealthEmbed(
      healthyHealth({ level: "degraded", discord: { gatewayPingMs: 40, restP95Ms: 2500, restErrorRate: 0, level: "degraded" } }),
    ).data.title;
    const down = buildPublicHealthEmbed(healthyHealth({ level: "down", db: { latencyMs: null, ok: false } })).data.title;
    expect(new Set([ok, degraded, down]).size).toBe(3);
  });
});

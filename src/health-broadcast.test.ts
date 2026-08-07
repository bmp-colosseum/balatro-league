// Tests for the pure core of the degradation broadcast layer --
// classifyTransition (exhaustive over every prev/next pair) and the
// alert/banner text builders. No Discord/DB I/O anywhere in here; the
// impure shell (onHealthTransition, thread discovery, posting) is exercised
// manually / via the health tick, not unit-tested (per the project's
// functional-core rule: only the decisions get unit tests, not I/O).
import { describe, it, expect } from "vitest";
import {
  buildDegradedAlertContent,
  buildRecoveredAlertContent,
  buildThreadDegradedNotice,
  buildThreadRecoveredNotice,
  classifyTransition,
  DEGRADED_BANNER_LINE,
  isPlayerImpacting,
  ownerAllowedMentions,
  type HealthTransition,
} from "./health-broadcast.js";
import type { BotHealth, HealthLevel } from "./bot-health.js";

const LEVELS: HealthLevel[] = ["ok", "degraded", "down"];

function health(overrides: Partial<BotHealth> = {}): BotHealth {
  return {
    level: "degraded",
    checkedAt: new Date("2026-08-04T12:00:00.000Z"),
    discord: { gatewayPingMs: 40, restP95Ms: 2500, restErrorRate: 0.01, level: "degraded" },
    db: { latencyMs: 5, ok: true },
    queue: { stalled: [], ok: true },
    notes: ["Discord REST is slow: p95 2500ms (over 2000ms)."],
    discordStatus: null,
    attribution: "unknown",
    ...overrides,
  };
}

describe("classifyTransition", () => {
  it("is 'none' for every null -> X pair (first tick after boot never alerts)", () => {
    for (const next of LEVELS) {
      expect(classifyTransition(null, next)).toBe("none");
    }
  });

  it.each([
    ["ok", "ok", "none"],
    ["ok", "degraded", "degraded"],
    ["ok", "down", "degraded"],
    ["degraded", "ok", "recovered"],
    ["degraded", "degraded", "none"],
    ["degraded", "down", "none"],
    ["down", "ok", "recovered"],
    ["down", "degraded", "none"],
    ["down", "down", "none"],
  ] as [HealthLevel, HealthLevel, HealthTransition][])("%s -> %s is '%s'", (prev, next, expected) => {
    expect(classifyTransition(prev, next)).toBe(expected);
  });
});

describe("isPlayerImpacting", () => {
  it("is true when the database is unreachable", () => {
    expect(isPlayerImpacting(health({ db: { latencyMs: null, ok: false } }))).toBe(true);
  });

  it("is true when Discord's own level is degraded (REST/gateway slow or erroring)", () => {
    expect(
      isPlayerImpacting(
        health({ discord: { gatewayPingMs: 40, restP95Ms: 2500, restErrorRate: 0, level: "degraded" } }),
      ),
    ).toBe(true);
  });

  it("is false when only a queue is stalled -- db and Discord are both fine", () => {
    expect(
      isPlayerImpacting(
        health({
          discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "ok" },
          db: { latencyMs: 5, ok: true },
          queue: { stalled: ["snapshot.mmr"], ok: false },
        }),
      ),
    ).toBe(false);
  });

  it("is false when everything is ok", () => {
    expect(
      isPlayerImpacting(
        health({
          level: "ok",
          discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "ok" },
          db: { latencyMs: 5, ok: true },
          queue: { stalled: [], ok: true },
        }),
      ),
    ).toBe(false);
  });
});

describe("ownerAllowedMentions", () => {
  it("pings only the owner when an owner id is configured", () => {
    expect(ownerAllowedMentions("123456789")).toEqual({ parse: [], users: ["123456789"] });
  });

  it("pings nobody when no owner id is configured", () => {
    expect(ownerAllowedMentions(undefined)).toEqual({ parse: [] });
  });
});

describe("buildDegradedAlertContent", () => {
  it("starts with the owner mention when configured", () => {
    const content = buildDegradedAlertContent(health(), "999");
    expect(content.startsWith("<@999>")).toBe(true);
  });

  it("has no mention at all when no owner id is configured", () => {
    const content = buildDegradedAlertContent(health(), undefined);
    expect(content).not.toContain("<@");
  });

  it("includes the level, notes, and the key numbers", () => {
    const content = buildDegradedAlertContent(
      health({
        level: "down",
        discord: { gatewayPingMs: 1200, restP95Ms: 4300, restErrorRate: 0.1, level: "degraded" },
        db: { latencyMs: 250, ok: true },
        queue: { stalled: ["notify.announce-result"], ok: false },
        notes: ["Database is unreachable.", "Stalled queue(s): notify.announce-result."],
      }),
      undefined,
    );
    expect(content).toContain("`down`");
    expect(content).toContain("Database is unreachable.");
    expect(content).toContain("Stalled queue(s): notify.announce-result.");
    expect(content).toContain("4300ms"); // REST p95
    expect(content).toContain("10.0%"); // REST error rate
    expect(content).toContain("1200ms"); // gateway ping
    expect(content).toContain("250ms"); // db latency
  });

  it("reports 'n/a' and 'none' for null/empty measurements instead of blowing up", () => {
    const content = buildDegradedAlertContent(
      health({
        discord: { gatewayPingMs: null, restP95Ms: null, restErrorRate: null, level: "ok" },
        db: { latencyMs: null, ok: false },
        queue: { stalled: [], ok: true },
      }),
      undefined,
    );
    expect(content).toContain("n/a");
    expect(content).toContain("none");
  });

  it("says players were shown a banner + thread notices when the incident is player-impacting", () => {
    const content = buildDegradedAlertContent(
      health({ discord: { gatewayPingMs: 40, restP95Ms: 2500, restErrorRate: 0, level: "degraded" } }),
      undefined,
    );
    expect(content).toContain("Players have been shown a heads-up banner");
  });

  it("says the incident is internal-only when it's just a stalled queue -- Discord/db both fine", () => {
    const content = buildDegradedAlertContent(
      health({
        discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, level: "ok" },
        db: { latencyMs: 5, ok: true },
        queue: { stalled: ["snapshot.mmr"], ok: false },
        notes: ["Stalled queue(s): snapshot.mmr."],
      }),
      undefined,
    );
    expect(content).toContain("Internal only");
    expect(content).not.toContain("Players have been shown");
  });

  it("names Discord as the likely cause when discordstatus.com confirms a real incident", () => {
    const content = buildDegradedAlertContent(
      health({
        discord: { gatewayPingMs: 40, restP95Ms: 2500, restErrorRate: 0, level: "degraded" },
        discordStatus: { indicator: "major", description: "Some systems affected" },
        attribution: "discord",
      }),
      undefined,
    );
    expect(content).toContain("Likely cause: Discord-side incident (confirmed by discordstatus.com)");
  });

  it("names our own network egress as the likely cause when discordstatus.com reports operational", () => {
    const content = buildDegradedAlertContent(
      health({
        discord: { gatewayPingMs: 40, restP95Ms: 2500, restErrorRate: 0, level: "degraded" },
        discordStatus: { indicator: "none", description: "All Systems Operational" },
        attribution: "network",
      }),
      undefined,
    );
    expect(content).toContain("Likely cause: Discord reports normal -- likely our network egress");
  });
});

describe("buildRecoveredAlertContent", () => {
  it("starts with the owner mention when configured", () => {
    const content = buildRecoveredAlertContent(health({ level: "ok" }), "999", true);
    expect(content.startsWith("<@999>")).toBe(true);
  });

  it("has no mention at all when no owner id is configured", () => {
    const content = buildRecoveredAlertContent(health({ level: "ok" }), undefined, true);
    expect(content).not.toContain("<@");
  });

  it("reports the recovered level and the checkedAt timestamp", () => {
    const content = buildRecoveredAlertContent(
      health({ level: "ok", checkedAt: new Date("2026-08-04T13:30:00.000Z") }),
      undefined,
      true,
    );
    expect(content).toContain("`ok`");
    expect(content).toContain("2026-08-04T13:30:00.000Z");
  });

  it("says player-facing notices were cleared when the incident was player-impacting", () => {
    const content = buildRecoveredAlertContent(health({ level: "ok" }), undefined, true);
    expect(content).toContain("Player-facing notices (banner + thread notes) have been cleared.");
  });

  it("says internal-only, nothing to clear when the incident was never player-impacting", () => {
    const content = buildRecoveredAlertContent(health({ level: "ok" }), undefined, false);
    expect(content).toContain("Internal only");
    expect(content).not.toContain("have been cleared");
  });
});

describe("banner + thread notice text", () => {
  it("DEGRADED_BANNER_LINE is a non-empty warning line", () => {
    expect(DEGRADED_BANNER_LINE.length).toBeGreaterThan(0);
    expect(DEGRADED_BANNER_LINE).toContain("warning");
  });

  it("buildThreadDegradedNotice and buildThreadRecoveredNotice are distinct, non-empty, deterministic strings", () => {
    expect(buildThreadDegradedNotice()).toBe(buildThreadDegradedNotice());
    expect(buildThreadRecoveredNotice()).toBe(buildThreadRecoveredNotice());
    expect(buildThreadDegradedNotice()).not.toBe(buildThreadRecoveredNotice());
    expect(buildThreadDegradedNotice().length).toBeGreaterThan(0);
    expect(buildThreadRecoveredNotice().length).toBeGreaterThan(0);
  });
});

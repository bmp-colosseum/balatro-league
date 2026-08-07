import { describe, it, expect } from "vitest";
import {
  ALERT_EXEMPT_QUEUES,
  computeRestStats,
  deriveAttribution,
  deriveHealth,
  describeAttribution,
  filterGenuinelyStalled,
  GATEWAY_PING_DEGRADED_MS,
  isAlertExemptQueue,
  MIN_REST_SAMPLES_FOR_SIGNAL,
  percentile,
  REST_ERROR_RATE_DEGRADED,
  REST_P95_DEGRADED_MS,
  type AttributionInputs,
  type DiscordStatusInfo,
  type HealthSampleInputs,
  type QueueStallCandidate,
  type RestSample,
} from "./bot-health.js";

const now = new Date("2026-08-04T12:00:00.000Z");

const OPERATIONAL_STATUS: DiscordStatusInfo = { indicator: "none", description: "All Systems Operational" };

// A fully-healthy baseline -- individual tests override just the field(s)
// under test so each case reads as "what changed from healthy".
function healthyInputs(overrides: Partial<HealthSampleInputs> = {}): HealthSampleInputs {
  return {
    db: { ok: true, latencyMs: 5 },
    discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0, sampleCount: 50 },
    queue: { stalled: [] },
    discordStatus: OPERATIONAL_STATUS,
    ...overrides,
  };
}

describe("deriveHealth", () => {
  it("reports ok when db/discord/queue are all healthy", () => {
    const health = deriveHealth(healthyInputs(), now);
    expect(health.level).toBe("ok");
    expect(health.discord.level).toBe("ok");
    expect(health.db).toEqual({ ok: true, latencyMs: 5 });
    expect(health.queue).toEqual({ stalled: [], stalledLowPriority: [], ok: true });
    expect(health.checkedAt).toBe(now);
    expect(health.notes).toEqual(["All systems normal."]);
  });

  it("degrades on a slow Discord REST p95 (the '4.3s message-edit' incident shape)", () => {
    // Real incident measured a 4.3s p95 -- well past the threshold, so this
    // must land as degraded, not just barely.
    const health = deriveHealth(
      healthyInputs({ discord: { gatewayPingMs: 40, restP95Ms: 4300, restErrorRate: 0, sampleCount: 50 } }),
      now,
    );
    expect(health.level).toBe("degraded");
    expect(health.discord.level).toBe("degraded");
    expect(health.discord.restP95Ms).toBe(4300);
    expect(health.notes.some((n) => n.includes("Discord REST is slow") && n.includes("4300ms"))).toBe(true);
  });

  it("does not degrade a p95 right at or under the threshold", () => {
    const health = deriveHealth(
      healthyInputs({
        discord: { gatewayPingMs: 40, restP95Ms: REST_P95_DEGRADED_MS, restErrorRate: 0, sampleCount: 50 },
      }),
      now,
    );
    expect(health.level).toBe("ok");
    expect(health.discord.level).toBe("ok");
  });

  it("degrades on a high Discord REST error rate", () => {
    const health = deriveHealth(
      healthyInputs({ discord: { gatewayPingMs: 40, restP95Ms: 150, restErrorRate: 0.2, sampleCount: 50 } }),
      now,
    );
    expect(health.level).toBe("degraded");
    expect(health.discord.level).toBe("degraded");
    expect(health.notes.some((n) => n.includes("Discord REST error rate") && n.includes("20.0%"))).toBe(true);
  });

  it("does not degrade an error rate right at the threshold", () => {
    const health = deriveHealth(
      healthyInputs({
        discord: {
          gatewayPingMs: 40,
          restP95Ms: 150,
          restErrorRate: REST_ERROR_RATE_DEGRADED,
          sampleCount: 50,
        },
      }),
      now,
    );
    expect(health.level).toBe("ok");
  });

  it("degrades on a high gateway ping", () => {
    const health = deriveHealth(
      healthyInputs({ discord: { gatewayPingMs: 1500, restP95Ms: 150, restErrorRate: 0, sampleCount: 50 } }),
      now,
    );
    expect(health.level).toBe("degraded");
    expect(health.discord.level).toBe("degraded");
    expect(health.notes.some((n) => n.includes("Discord gateway ping") && n.includes("1500ms"))).toBe(true);
  });

  it("does not degrade a gateway ping right at the threshold", () => {
    const health = deriveHealth(
      healthyInputs({
        discord: { gatewayPingMs: GATEWAY_PING_DEGRADED_MS, restP95Ms: 150, restErrorRate: 0, sampleCount: 50 },
      }),
      now,
    );
    expect(health.level).toBe("ok");
  });

  it("goes down when the database is unreachable, overriding everything else", () => {
    const health = deriveHealth(healthyInputs({ db: { ok: false, latencyMs: null } }), now);
    expect(health.level).toBe("down");
    expect(health.db).toEqual({ ok: false, latencyMs: null });
    // Db-down note leads the list -- it's the most important thing to see.
    expect(health.notes[0]).toBe("Database is unreachable.");
  });

  it("db down + discord degraded: top-level is down, discord subsystem still reports its own degraded level", () => {
    const health = deriveHealth(
      healthyInputs({
        db: { ok: false, latencyMs: null },
        discord: { gatewayPingMs: 40, restP95Ms: 5000, restErrorRate: 0, sampleCount: 50 },
      }),
      now,
    );
    expect(health.level).toBe("down");
    expect(health.discord.level).toBe("degraded");
    expect(health.notes).toContain("Database is unreachable.");
    expect(health.notes.some((n) => n.includes("Discord REST is slow"))).toBe(true);
  });

  it("degrades on a stalled queue and names it", () => {
    const health = deriveHealth(healthyInputs({ queue: { stalled: ["announce", "notify-dm"] } }), now);
    expect(health.level).toBe("degraded");
    expect(health.queue).toEqual({ stalled: ["announce", "notify-dm"], stalledLowPriority: [], ok: false });
    expect(health.notes.some((n) => n.includes("announce") && n.includes("notify-dm"))).toBe(true);
  });

  it("reports insufficient data below the REST sample floor without fabricating a verdict", () => {
    const health = deriveHealth(
      healthyInputs({
        discord: { gatewayPingMs: 40, restP95Ms: null, restErrorRate: null, sampleCount: 2 },
      }),
      now,
    );
    expect(health.level).toBe("ok");
    expect(health.discord.level).toBe("ok");
    expect(health.discord.restP95Ms).toBeNull();
    expect(health.discord.restErrorRate).toBeNull();
    expect(health.notes.some((n) => n.includes("insufficient data") && n.includes("2 samples"))).toBe(true);
  });

  it("singularizes the sample count note for exactly one sample", () => {
    const health = deriveHealth(
      healthyInputs({ discord: { gatewayPingMs: 40, restP95Ms: null, restErrorRate: null, sampleCount: 1 } }),
      now,
    );
    expect(health.notes.some((n) => n.includes("1 sample so far"))).toBe(true);
  });

  it("everything healthy at exactly the sample floor uses the real numbers, not insufficient data", () => {
    const health = deriveHealth(
      healthyInputs({
        discord: {
          gatewayPingMs: 40,
          restP95Ms: 150,
          restErrorRate: 0,
          sampleCount: MIN_REST_SAMPLES_FOR_SIGNAL,
        },
      }),
      now,
    );
    expect(health.level).toBe("ok");
    expect(health.notes).toEqual(["All systems normal."]);
  });
});

describe("percentile", () => {
  it("computes p95 on a known 10-element array via nearest-rank", () => {
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    // ceil(0.95 * 10) = 10th smallest (1-indexed) = the max.
    expect(percentile(values, 95)).toBe(1000);
  });

  it("computes p50 (median) on a known array", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    // ceil(0.5 * 10) = 5th smallest (1-indexed) = 50.
    expect(percentile(values, 50)).toBe(50);
  });

  it("is order-independent (sorts internally)", () => {
    const shuffled = [500, 100, 900, 300, 1000, 200, 700, 400, 800, 600];
    expect(percentile(shuffled, 95)).toBe(1000);
  });

  it("returns 0 for an empty array rather than throwing", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("returns the single value for a one-element array", () => {
    expect(percentile([42], 95)).toBe(42);
  });
});

describe("computeRestStats", () => {
  function samples(entries: Array<[number, boolean]>): RestSample[] {
    return entries.map(([durationMs, ok]) => ({ durationMs, ok }));
  }

  it("reports insufficient data below MIN_REST_SAMPLES_FOR_SIGNAL", () => {
    const few = samples([
      [100, true],
      [200, true],
    ]);
    expect(few.length).toBeLessThan(MIN_REST_SAMPLES_FOR_SIGNAL);
    expect(computeRestStats(few)).toEqual({ restP95Ms: null, restErrorRate: null, sampleCount: 2 });
  });

  it("computes p95 + error rate on a known sample array at/above the floor", () => {
    const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const all = samples(durations.map((d, i) => [d, i !== 9] as [number, boolean])); // last one failed
    const stats = computeRestStats(all);
    expect(stats.sampleCount).toBe(10);
    expect(stats.restP95Ms).toBe(1000);
    expect(stats.restErrorRate).toBeCloseTo(0.1, 10);
  });

  it("reports a 0% error rate when every sample succeeded", () => {
    const all = samples(Array.from({ length: 8 }, (_, i) => [50 + i, true] as [number, boolean]));
    expect(computeRestStats(all).restErrorRate).toBe(0);
  });

  it("reports a 100% error rate when every sample failed", () => {
    const all = samples(Array.from({ length: 6 }, (_, i) => [50 + i, false] as [number, boolean]));
    expect(computeRestStats(all).restErrorRate).toBe(1);
  });
});

describe("filterGenuinelyStalled", () => {
  function candidate(name: string, jobCount: number): QueueStallCandidate {
    return { name, jobCount };
  }

  it("drops a queue whose queued count DECREASED since the last tick -- it's draining, not stalled", () => {
    // The real incident this guards against: snapshot.mmr at 37 queued last
    // tick, 36 this tick -- visibly making progress despite its oldest job
    // being old enough to trip devops-alarm's 5min threshold.
    const previous = new Map([["snapshot.mmr", 37]]);
    const result = filterGenuinelyStalled([candidate("snapshot.mmr", 36)], previous);
    expect(result).toEqual([]);
  });

  it("keeps a queue whose queued count is unchanged since the last tick -- genuinely not moving", () => {
    const previous = new Map([["notify.announce-result", 12]]);
    const result = filterGenuinelyStalled([candidate("notify.announce-result", 12)], previous);
    expect(result).toEqual([candidate("notify.announce-result", 12)]);
  });

  it("keeps a queue whose queued count INCREASED since the last tick -- a genuinely growing backlog", () => {
    const previous = new Map([["email", 5]]);
    const result = filterGenuinelyStalled([candidate("email", 9)], previous);
    expect(result).toEqual([candidate("email", 9)]);
  });

  it("keeps a queue with no prior tick on record -- conservative on first sight", () => {
    const result = filterGenuinelyStalled([candidate("brand-new-queue", 3)], new Map());
    expect(result).toEqual([candidate("brand-new-queue", 3)]);
  });

  it("evaluates each queue independently against its own previous count", () => {
    const previous = new Map([
      ["draining", 40],
      ["growing", 2],
    ]);
    const result = filterGenuinelyStalled(
      [candidate("draining", 30), candidate("growing", 6)],
      previous,
    );
    expect(result).toEqual([candidate("growing", 6)]);
  });
});

describe("isAlertExemptQueue / ALERT_EXEMPT_QUEUES", () => {
  it("exempts snapshot.mmr", () => {
    expect(isAlertExemptQueue("snapshot.mmr")).toBe(true);
    expect(ALERT_EXEMPT_QUEUES.has("snapshot.mmr")).toBe(true);
  });

  it("does not exempt an arbitrary player-facing queue", () => {
    expect(isAlertExemptQueue("notify.announce-result")).toBe(false);
    expect(isAlertExemptQueue("report.post-pending")).toBe(false);
  });
});

describe("deriveHealth: alert-exempt queue stalls", () => {
  it("an exempt-only stall stays 'ok' and is reported under stalledLowPriority, not stalled", () => {
    const health = deriveHealth(healthyInputs({ queue: { stalled: ["snapshot.mmr"] } }), now);
    expect(health.level).toBe("ok");
    expect(health.queue).toEqual({ stalled: [], stalledLowPriority: ["snapshot.mmr"], ok: true });
    // No "Stalled queue(s)" note either -- an exempt stall must not read as
    // a degrading factor.
    expect(health.notes.some((n) => n.includes("Stalled queue"))).toBe(false);
  });

  it("a non-exempt stall still degrades level and lands in queue.stalled", () => {
    const health = deriveHealth(healthyInputs({ queue: { stalled: ["notify.announce-result"] } }), now);
    expect(health.level).toBe("degraded");
    expect(health.queue).toEqual({ stalled: ["notify.announce-result"], stalledLowPriority: [], ok: false });
    expect(health.notes.some((n) => n.includes("Stalled queue(s): notify.announce-result"))).toBe(true);
  });

  it("mixes exempt + non-exempt correctly: level degrades on the non-exempt one only, both are visible", () => {
    const health = deriveHealth(
      healthyInputs({ queue: { stalled: ["snapshot.mmr", "notify.announce-result"] } }),
      now,
    );
    expect(health.level).toBe("degraded");
    expect(health.queue.stalled).toEqual(["notify.announce-result"]);
    expect(health.queue.stalledLowPriority).toEqual(["snapshot.mmr"]);
    // The alert-worthy note names only the non-exempt queue.
    const stallNote = health.notes.find((n) => n.startsWith("Stalled queue(s):"));
    expect(stallNote).toBe("Stalled queue(s): notify.announce-result.");
    expect(stallNote).not.toContain("snapshot.mmr");
  });
});

describe("deriveAttribution", () => {
  const DEGRADED_STATUS: DiscordStatusInfo = { indicator: "major", description: "Some systems affected" };

  function attrInputs(overrides: Partial<AttributionInputs> = {}): AttributionInputs {
    return {
      db: { ok: true },
      discord: { level: "ok" },
      queue: { stalled: [] },
      discordStatus: OPERATIONAL_STATUS,
      ...overrides,
    };
  }

  it("db not ok -> 'database', regardless of anything else", () => {
    expect(
      deriveAttribution(
        attrInputs({ db: { ok: false }, discord: { level: "degraded" }, discordStatus: DEGRADED_STATUS }),
      ),
    ).toBe("database");
  });

  it("discord degraded + discordstatus.com reports a real incident -> 'discord'", () => {
    expect(
      deriveAttribution(attrInputs({ discord: { level: "degraded" }, discordStatus: DEGRADED_STATUS })),
    ).toBe("discord");
  });

  it("discord degraded + discordstatus.com says operational -> 'network' (likely our own egress)", () => {
    expect(
      deriveAttribution(attrInputs({ discord: { level: "degraded" }, discordStatus: OPERATIONAL_STATUS })),
    ).toBe("network");
  });

  it("discord degraded + discordstatus.com unreachable/unknown -> 'unknown'", () => {
    expect(deriveAttribution(attrInputs({ discord: { level: "degraded" }, discordStatus: null }))).toBe(
      "unknown",
    );
  });

  it("only non-exempt queues stalled (db/discord fine) -> 'queue'", () => {
    expect(
      deriveAttribution(attrInputs({ queue: { stalled: ["notify.announce-result"] } })),
    ).toBe("queue");
  });

  it("everything fine -> 'none'", () => {
    expect(deriveAttribution(attrInputs())).toBe("none");
  });

  it("deriveHealth wires discordStatus and attribution straight through into the snapshot", () => {
    const health = deriveHealth(
      healthyInputs({
        discord: { gatewayPingMs: 40, restP95Ms: 4300, restErrorRate: 0, sampleCount: 50 },
        discordStatus: DEGRADED_STATUS,
      }),
      now,
    );
    expect(health.discordStatus).toEqual(DEGRADED_STATUS);
    expect(health.attribution).toBe("discord");
  });
});

describe("describeAttribution", () => {
  it("returns distinct, non-empty text for every attribution value", () => {
    const attributions = ["database", "discord", "network", "unknown", "queue", "none"] as const;
    const texts = attributions.map((a) =>
      describeAttribution(a, a === "discord" ? { indicator: "major", description: "Some systems affected" } : null),
    );
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("names discordstatus.com as the corroboration source for a Discord-attributed incident", () => {
    expect(describeAttribution("discord", { indicator: "major", description: "x" })).toContain(
      "confirmed by discordstatus.com",
    );
  });

  it("calls out our own egress for a network-attributed incident", () => {
    expect(describeAttribution("network", OPERATIONAL_STATUS)).toContain("our network egress");
  });
});

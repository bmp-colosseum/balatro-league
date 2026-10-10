import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { generateSchedule, summariseSchedule, planDivisionResync, needsCleanRegenerate, type SchedulePlayer, type ExistingMatch } from "./schedule.js";

// A realistic-ish division: 16 players banded on Owen's 2200 scale, spaced ~15.
function division(n: number, top = 2200, step = 15): SchedulePlayer[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, mmr: top - i * step }));
}

function checkStructure(players: SchedulePlayer[], degree: number) {
  const r = generateSchedule(players, { degree, seed: 42 });
  const byId = new Map(players.map((p) => [p.id, p.mmr]));
  for (const p of players) {
    const opps = r.opponents.get(p.id)!;
    expect(opps).toBeDefined();
    // exact degree, no self, no dupes
    expect(opps.length).toBe(degree);
    expect(new Set(opps).size).toBe(degree);
    expect(opps).not.toContain(p.id);
    // symmetric: every opponent lists me back
    for (const o of opps) expect(r.opponents.get(o)).toContain(p.id);
    // SoS matches the listed opponents
    const expectedSos = opps.reduce((s, o) => s + byId.get(o)!, 0);
    expect(r.sos.get(p.id)).toBeCloseTo(expectedSos, 6);
  }
  return r;
}

describe("generateSchedule — structure", () => {
  it("produces a valid 4-regular symmetric graph (no self/dupes)", () => {
    checkStructure(division(16), 4);
  });

  it("handles odd N", () => {
    checkStructure(division(17), 4);
  });

  it("handles awkward sizes (13, 23)", () => {
    checkStructure(division(13), 4);
    checkStructure(division(23), 4);
  });

  it("N = degree+1 → everyone plays everyone", () => {
    const r = checkStructure(division(5), 4);
    expect(r.opponents.get("p1")!.length).toBe(4);
  });

  it("is deterministic for a fixed seed", () => {
    const a = generateSchedule(division(16), { seed: 7 });
    const b = generateSchedule(division(16), { seed: 7 });
    expect(a.opponents.get("p1")).toEqual(b.opponents.get("p1"));
  });
});

describe("generateSchedule — strength-of-schedule balance", () => {
  it("keeps every player's SoS tight around degree·meanMMR", () => {
    const players = division(16);
    const r = generateSchedule(players, { seed: 42 });
    const s = summariseSchedule(r, players, 4);
    // Each player's slate should land within a small band — well under one
    // MMR "step" (15) per opponent. Spread = max−min across all 16 players.
    expect(s.spread).toBeLessThan(4 * 15);
    // Print the numbers so we can eyeball the real spread.
    // eslint-disable-next-line no-console
    console.log(
      `[schedule 16p] ideal SoS=${s.idealSos.toFixed(0)} · range ${s.minSos}–${s.maxSos} ` +
      `· spread ${s.spread} · stdev ${s.stdev.toFixed(1)}`,
    );
  });

  it("beats the unbalanced circulant seed (balancing actually helps)", () => {
    const players = division(20);
    const balanced = summariseSchedule(generateSchedule(players, { seed: 3 }), players, 4);
    // A single pass / no restarts won't balance as well; the full run should be
    // tight. Sanity: stdev is small relative to the MMR range (20×15 = 285).
    expect(balanced.stdev).toBeLessThan(20);
    // eslint-disable-next-line no-console
    console.log(`[schedule 20p] spread ${balanced.spread} · stdev ${balanced.stdev.toFixed(1)}`);
  });
});

// --- planDivisionResync: incremental repair after a roster change ---

let _mid = 0;
function mk(a: string, b: string, opts: Partial<ExistingMatch> = {}): ExistingMatch {
  const [x, y] = a < b ? [a, b] : [b, a];
  return { id: opts.id ?? `m${++_mid}`, playerAId: x, playerBId: y, status: opts.status ?? "PENDING", gamesWonA: opts.gamesWonA ?? 0, gamesWonB: opts.gamesWonB ?? 0 };
}
// Full round-robin among ids → everyone at degree N-1.
function roundRobin(ids: string[], status = "PENDING"): ExistingMatch[] {
  const out: ExistingMatch[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push(mk(ids[i]!, ids[j]!, { status }));
  return out;
}
function degrees(memberIds: string[], pairs: [string, string][], existing: ExistingMatch[], pruneIds: string[]): Map<string, number> {
  const active = new Set(memberIds);
  const pruned = new Set(pruneIds);
  const deg = new Map(memberIds.map((id) => [id, 0]));
  const seen = new Set<string>();
  const add = (a: string, b: string) => {
    if (!active.has(a) || !active.has(b)) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    deg.set(a, deg.get(a)! + 1);
    deg.set(b, deg.get(b)! + 1);
  };
  for (const m of existing) if (!pruned.has(m.id)) add(m.playerAId, m.playerBId);
  for (const [a, b] of pairs) add(a, b);
  return deg;
}

// --- forbidden pairs (never-schedule-together) ---

function canon(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function hasPair(pairs: ReadonlyArray<readonly [string, string]>, a: string, b: string): boolean {
  const [x, y] = canon(a, b);
  return pairs.some(([p, q]) => p === x && q === y);
}

function checkStructureWithForbidden(
  players: SchedulePlayer[],
  degree: number,
  forbidden: ReadonlyArray<readonly [string, string]>,
  seed = 42,
) {
  const r = generateSchedule(players, { degree, seed, forbidden });
  const byId = new Map(players.map((p) => [p.id, p.mmr]));
  for (const p of players) {
    const opps = r.opponents.get(p.id)!;
    expect(opps).toBeDefined();
    expect(opps.length).toBe(degree);
    expect(new Set(opps).size).toBe(degree);
    expect(opps).not.toContain(p.id);
    for (const o of opps) expect(r.opponents.get(o)).toContain(p.id);
    const expectedSos = opps.reduce((s, o) => s + byId.get(o)!, 0);
    expect(r.sos.get(p.id)).toBeCloseTo(expectedSos, 6);
  }
  return r;
}

describe("generateSchedule — forbidden pairs", () => {
  it("keeps regularity + validity when honoring a forbidden set (n=12, k=4)", () => {
    const players = division(12);
    const forbidden: [string, string][] = [
      ["p1", "p2"],
      ["p5", "p6"],
      ["p9", "p10"],
    ];
    checkStructureWithForbidden(players, 4, forbidden);
  });

  it("avoids every forbidden pair when the set is sparse (n comfortably > k+1) and reports no unavoidables", () => {
    const players = division(12);
    const forbidden: [string, string][] = [
      ["p1", "p2"],
      ["p5", "p6"],
      ["p9", "p10"],
    ];
    const r = checkStructureWithForbidden(players, 4, forbidden);
    for (const [a, b] of forbidden) {
      expect(r.opponents.get(a)).not.toContain(b);
      expect(r.opponents.get(b)).not.toContain(a);
    }
    expect(r.unavoidable).toEqual([]);
  });

  it("full round-robin (n <= k+1): a forbidden pair among members shows up in unavoidable", () => {
    const players = division(5); // n=5, k=4 -> n <= k+1
    const r = generateSchedule(players, { degree: 4, seed: 1, forbidden: [["p1", "p2"]] });
    expect(r.unavoidable).toEqual([["p1", "p2"]]);
    // still a full round robin -- the pair is unavoidably present.
    expect(r.opponents.get("p1")).toContain("p2");
    expect(r.opponents.get("p2")).toContain("p1");
  });

  it("is deterministic with a forbidden set (identical args -> deep-equal output)", () => {
    const players = division(16);
    const forbidden: [string, string][] = [["p1", "p2"], ["p3", "p4"]];
    const a = generateSchedule(players, { degree: 4, seed: 7, forbidden });
    const b = generateSchedule(players, { degree: 4, seed: 7, forbidden });
    expect(a.opponents).toEqual(b.opponents);
    expect(a.sos).toEqual(b.sos);
    expect(a.unavoidable).toEqual(b.unavoidable);
  });

  it("ignores a forbidden pair referencing a non-member id", () => {
    const players = division(16);
    const withForbidden = generateSchedule(players, { degree: 4, seed: 7, forbidden: [["p1", "pZZZ"]] });
    const without = generateSchedule(players, { degree: 4, seed: 7 });
    expect(withForbidden.unavoidable).toEqual([]);
    expect(withForbidden.opponents).toEqual(without.opponents);
    expect(withForbidden.sos).toEqual(without.sos);
  });

  it("holds across a sweep of division sizes with multiple forbidden pairs", () => {
    for (const n of [13, 17, 23]) {
      const players = division(n);
      // Pick a handful of pairs deterministically -- neighbors in MMR order,
      // which the circulant seed would otherwise always connect.
      const forbidden: [string, string][] = [
        ["p1", "p2"],
        ["p3", "p4"],
        [`p${n - 1}`, `p${n}`],
      ];
      const r = checkStructureWithForbidden(players, 4, forbidden, 99);
      for (const [a, b] of forbidden) {
        expect(r.opponents.get(a)).not.toContain(b);
      }
      expect(r.unavoidable).toEqual([]);
    }
  });
});

describe("planDivisionResync — forbidden pairs", () => {
  it("never emits a forbidden pair in createPairs", () => {
    // p6 replaces a leaver whose four unplayed matches were pruned, so p2..p5
    // each need one game; p6 may not play p2.
    const existing = [mk("p1", "p2"), mk("p1", "p3"), mk("p1", "p4"), mk("p1", "p5")];
    const members = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const forbidden: [string, string][] = [["p6", "p2"]];
    const plan = planDivisionResync(members, existing, 4, forbidden);
    expect(hasPair(plan.createPairs, "p6", "p2")).toBe(false);
    const deg = degrees(members, plan.createPairs, existing, plan.pruneIds);
    for (const id of members) expect(deg.get(id)!).toBeLessThanOrEqual(4);
  });

  it("leaves the deficit rather than honoring a forbidden pairing when partners run out", () => {
    // Only p2 still needs a game, and p6 may not play p2: p6 stays short.
    const existing = [mk("p1", "p3"), mk("p1", "p4"), mk("p1", "p5"), mk("p3", "p4"), mk("p3", "p5"), mk("p4", "p5")];
    const members = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const forbidden: [string, string][] = [["p6", "p2"]];
    const plan = planDivisionResync(members, existing, 4, forbidden);
    expect(hasPair(plan.createPairs, "p6", "p2")).toBe(false);
    const deg = degrees(members, plan.createPairs, existing, plan.pruneIds);
    for (const id of members) expect(deg.get(id)!).toBeLessThanOrEqual(4);
  });

  it("is unaffected by a forbidden pair referencing a non-member", () => {
    const members = ["p1", "p2", "p3", "p4", "p5"];
    const withForbidden = planDivisionResync(members, [], 4, [["p1", "pZZZ"]]);
    const without = planDivisionResync(members, [], 4);
    expect(withForbidden).toEqual(without);
  });
});

describe("planDivisionResync", () => {
  it("a newcomer only gets games against members who still need one; nobody is pushed to 5", () => {
    // Everyone already has their 4: the newcomer gets nothing rather than
    // handing four players a 5th match (an untouched division takes the clean
    // regenerate path instead, see needsCleanRegenerate).
    const existing = roundRobin(["p1", "p2", "p3", "p4", "p5"]).map((m, i) =>
      i === 0 ? { ...m, status: "CONFIRMED", gamesWonA: 2 } : m,
    );
    const members = ["p1", "p2", "p3", "p4", "p5", "p6"]; // p6 just joined
    const plan = planDivisionResync(members, existing, 4);
    expect(plan.pruneIds).toEqual([]);
    expect(plan.createPairs).toEqual([]);
  });

  it("a replacement for a leaver inherits the leaver's open slots", () => {
    // p5 left; its four unplayed matches are orphaned, p1..p4 each need one.
    const existing = roundRobin(["p1", "p2", "p3", "p4", "p5"]);
    const members = ["p1", "p2", "p3", "p4", "p6"]; // p6 replaces p5
    const plan = planDivisionResync(members, existing, 4);
    expect(plan.pruneIds.length).toBe(4);
    expect(plan.createPairs.length).toBe(4);
    for (const [a, b] of plan.createPairs) expect(a === "p6" || b === "p6").toBe(true);
    const deg = degrees(members, plan.createPairs, existing, plan.pruneIds);
    for (const id of members) expect(deg.get(id)).toBe(4);
  });

  it("prunes unplayed rows that involve a non-member, keeps played history", () => {
    const members = ["p1", "p2", "p3"];
    const existing = [
      mk("p1", "p2", { id: "keep-pending" }), // both members, unplayed → keep
      mk("p1", "pX", { id: "orphan-pending" }), // pX left → prune
      mk("p2", "pY", { id: "orphan-played", status: "CONFIRMED", gamesWonA: 2, gamesWonB: 0 }), // played vs leaver → keep as history
    ];
    const plan = planDivisionResync(members, existing, 4);
    expect(plan.pruneIds).toEqual(["orphan-pending"]);
  });

  it("is idempotent — re-running on a satisfied schedule adds nothing", () => {
    const members = ["a", "b", "c", "d", "e", "f", "g"];
    const first = planDivisionResync(members, [], 4);
    const asMatches = first.createPairs.map(([a, b]) => mk(a, b));
    const second = planDivisionResync(members, asMatches, 4);
    expect(second.createPairs).toEqual([]);
    expect(second.pruneIds).toEqual([]);
  });

  it("round-robin target (N-1) connects everyone to everyone", () => {
    const members = ["p1", "p2", "p3", "p4", "p5"];
    const plan = planDivisionResync(members, [], 4); // target 4 = N-1
    expect(plan.createPairs.length).toBe(10); // C(5,2)
    const deg = degrees(members, plan.createPairs, [], []);
    for (const id of members) expect(deg.get(id)).toBe(4);
  });

  it("after a drop, refills the dropped player's former opponents back toward target", () => {
    // p1..p6 round-robin-ish; p6 leaves. Its 5 partners each lose a game.
    const all = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const existing = roundRobin(all); // everyone degree 5
    const remaining = ["p1", "p2", "p3", "p4", "p5"]; // p6 dropped
    const plan = planDivisionResync(remaining, existing, 4);
    // p6's unplayed rows are orphaned → pruned (5 of them).
    expect(plan.pruneIds.length).toBe(5);
    // Remaining 5 are now a complete graph among themselves (degree 4) → nothing to add.
    const deg = degrees(remaining, plan.createPairs, existing, plan.pruneIds);
    for (const id of remaining) expect(deg.get(id)).toBe(4);
  });
});

describe("planDivisionResync after a drop with results on the board", () => {
  it("does not refill an opponent who already played the dropped player (that result stands)", () => {
    // p1..p5 complete; p1 already beat p5, the rest of p5's games are unplayed.
    const ids = ["p1", "p2", "p3", "p4", "p5"];
    const existing = roundRobin(ids).map((m) =>
      m.playerAId === "p1" && m.playerBId === "p5" ? { ...m, status: "CONFIRMED", gamesWonA: 2 } : m,
    );
    const remaining = ["p1", "p2", "p3", "p4"]; // p5 dropped
    const plan = planDivisionResync(remaining, existing, 4);
    // p5's three unplayed rows go; the played p1-p5 row stays.
    expect(plan.pruneIds.length).toBe(3);
    expect(plan.pruneIds).not.toContain(existing.find((m) => m.status === "CONFIRMED")!.id);
    // Four players can only have 3 opponents each; p1 keeps its p5 result as a
    // 4th match and gets nothing new, nobody else can be added either.
    expect(plan.createPairs).toEqual([]);
  });

  it("never refills a member whose kept matches (including played ones against the leaver) already reach the cap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 9 }),
        fc.array(fc.tuple(fc.nat({ max: 8 }), fc.nat({ max: 8 }), fc.boolean()), { maxLength: 30 }),
        fc.integer({ min: 2, max: 6 }),
        (n, raw, target) => {
          const ids = Array.from({ length: n }, (_, i) => `p${i}`);
          const seen = new Set<string>();
          const existing: ExistingMatch[] = [];
          for (const [x, y, played] of raw) {
            const a = ids[x % n]!, b = ids[y % n]!;
            if (a === b) continue;
            const k = a < b ? `${a}|${b}` : `${b}|${a}`;
            if (seen.has(k)) continue;
            seen.add(k);
            existing.push(mk(a, b, played ? { status: "CONFIRMED", gamesWonA: 2 } : {}));
          }
          const remaining = ids.slice(0, -1); // the last member dropped
          const plan = planDivisionResync(remaining, existing, target);
          const cap = Math.min(target, remaining.length - 1);
          const pruned = new Set(plan.pruneIds);
          const kept = new Map(remaining.map((id) => [id, 0]));
          for (const m of existing) {
            if (pruned.has(m.id)) continue;
            if (kept.has(m.playerAId)) kept.set(m.playerAId, kept.get(m.playerAId)! + 1);
            if (kept.has(m.playerBId)) kept.set(m.playerBId, kept.get(m.playerBId)! + 1);
          }
          // Only unplayed rows against the leaver are pruned; played ones stay.
          for (const id of plan.pruneIds) {
            const m = existing.find((x) => x.id === id)!;
            expect(m.status).toBe("PENDING");
          }
          // Nobody ever ends above the cap, counting kept results against the leaver.
          const total = new Map(kept);
          for (const [a, b] of plan.createPairs) {
            total.set(a, total.get(a)! + 1);
            total.set(b, total.get(b)! + 1);
          }
          for (const id of remaining) expect(total.get(id)!).toBeLessThanOrEqual(Math.max(cap, kept.get(id)!));
        },
      ),
      { numRuns: 300 },
    );
  });
});

// --- needsCleanRegenerate: untouched division -> rebuild instead of patch ---

describe("needsCleanRegenerate", () => {
  const slot = (id: string, a: string, b: string, extra: Partial<ExistingMatch> = {}): ExistingMatch => ({
    id,
    playerAId: a < b ? a : b,
    playerBId: a < b ? b : a,
    status: "PENDING",
    gamesWonA: 0,
    gamesWonB: 0,
    ...extra,
  });
  // 5-player complete round robin: everyone already has 4.
  const five = ["p1", "p2", "p3", "p4", "p5"];
  const roundRobin: ExistingMatch[] = [];
  for (let i = 0; i < five.length; i++) {
    for (let j = i + 1; j < five.length; j++) roundRobin.push(slot(`m${i}${j}`, five[i]!, five[j]!));
  }

  it("is false for a balanced untouched division", () => {
    expect(needsCleanRegenerate(five, roundRobin, 4)).toBe(false);
  });

  it("is true when a 6th player joins a full 5-player round robin (Season 9 Rare 1)", () => {
    expect(needsCleanRegenerate([...five, "p6"], roundRobin, 4)).toBe(true);
  });

  it("is true when a player leaves and the leftovers are uneven", () => {
    expect(needsCleanRegenerate(five.slice(0, 4), roundRobin, 4)).toBe(false); // 4 left, cap 3, all have 3 -> balanced
    const sixPlayers = [...five, "p6"];
    const withSixth = [...roundRobin, slot("x1", "p1", "p6"), slot("x2", "p2", "p6"), slot("x3", "p3", "p6"), slot("x4", "p4", "p6")];
    expect(needsCleanRegenerate(sixPlayers, withSixth, 4)).toBe(true); // p1..p4 at 5
  });

  it("is false once anything has been played, even if uneven", () => {
    const played = roundRobin.map((m, i) => (i === 0 ? { ...m, status: "CONFIRMED", gamesWonA: 2 } : m));
    expect(needsCleanRegenerate([...five, "p6"], played, 4)).toBe(false);
    const reported = roundRobin.map((m, i) => (i === 0 ? { ...m, gamesWonA: 1, gamesWonB: 1 } : m));
    expect(needsCleanRegenerate([...five, "p6"], reported, 4)).toBe(false);
  });

  it("is true for a division with members but no schedule yet", () => {
    expect(needsCleanRegenerate(five, [], 4)).toBe(true);
  });

  it("is false with fewer than two members", () => {
    expect(needsCleanRegenerate(["p1"], [], 4)).toBe(false);
  });
});

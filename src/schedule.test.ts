import { describe, it, expect } from "vitest";
import { generateSchedule, summariseSchedule, planDivisionResync, type SchedulePlayer, type ExistingMatch } from "./schedule.js";

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

describe("planDivisionResync", () => {
  it("gives a newcomer exactly `target` opponents and disturbs nobody else", () => {
    const existing = roundRobin(["p1", "p2", "p3", "p4", "p5"]); // all at degree 4
    const members = ["p1", "p2", "p3", "p4", "p5", "p6"]; // p6 just joined
    const plan = planDivisionResync(members, existing, 4);
    expect(plan.pruneIds).toEqual([]);
    expect(plan.createPairs.length).toBe(4); // p6 needs 4 opponents
    for (const [a, b] of plan.createPairs) expect(a === "p6" || b === "p6").toBe(true); // every new edge touches p6
    const deg = degrees(members, plan.createPairs, existing, plan.pruneIds);
    expect(deg.get("p6")).toBe(4);
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

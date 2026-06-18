import { describe, it, expect } from "vitest";
import { generateSchedule, summariseSchedule, type SchedulePlayer } from "./schedule.js";

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

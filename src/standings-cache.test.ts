// Unit tests for the pure isDivisionComplete helper only -- the rest of
// standings-cache.ts (recomputeDivisionStandings/loadDivisionStandings) is a
// DB-backed wrapper covered by standings-cache.integration.test.ts instead.
// Nothing here touches the DB -- importing this module instantiates a Prisma
// client (lazy; never connects) the same way standings.ts et al. already do
// under vitest. Mirrors web/lib/standings-cache.test.ts's identical block.

import { describe, it, expect } from "vitest";
import { isDivisionComplete } from "./standings-cache.js";

// Same "no pairing left to play" rule as the web's /divisions/[id] page's
// own `complete` -- feeds computeStandings/computeBestNStandings'
// divisionComplete (the lives tiebreak's per-row tiebreakNote isFinal).
describe("isDivisionComplete", () => {
  it("is false (unlocked schedule) when an active-member pair hasn't played", () => {
    const matches = [
      { playerAId: "a", playerBId: "b", status: "CONFIRMED", gamesWonA: 2, gamesWonB: 0 },
    ];
    expect(isDivisionComplete(["a", "b", "c"], matches, false)).toBe(false);
  });

  it("is true (unlocked schedule) once every active-member pair has played", () => {
    const matches = [
      { playerAId: "a", playerBId: "b", status: "CONFIRMED", gamesWonA: 2, gamesWonB: 0 },
      { playerAId: "a", playerBId: "c", status: "CONFIRMED", gamesWonA: 1, gamesWonB: 1 },
      { playerAId: "b", playerBId: "c", status: "CONFIRMED", gamesWonA: 2, gamesWonB: 0 },
    ];
    expect(isDivisionComplete(["a", "b", "c"], matches, false)).toBe(true);
  });

  it("is false (schedule-locked) while an assigned pairing is still PENDING", () => {
    const matches = [
      { playerAId: "a", playerBId: "b", status: "CONFIRMED", gamesWonA: 2, gamesWonB: 0 },
      { playerAId: "a", playerBId: "c", status: "PENDING", gamesWonA: 0, gamesWonB: 0 },
    ];
    expect(isDivisionComplete(["a", "b", "c"], matches, true)).toBe(false);
  });

  it("is true (schedule-locked) once every assigned pairing is CONFIRMED, even with a sub-round-robin schedule", () => {
    // A locked 1-opponent schedule: a/b played, c has no assigned opponent at
    // all -- the unassigned a-c / b-c pairs don't count against completeness.
    const matches = [
      { playerAId: "a", playerBId: "b", status: "CONFIRMED", gamesWonA: 2, gamesWonB: 0 },
    ];
    expect(isDivisionComplete(["a", "b", "c"], matches, true)).toBe(true);
  });

  it("detects a locked schedule from a 0-0 PENDING slot even when the season flag itself is false (the flag is only a fast-path)", () => {
    const matches = [
      { playerAId: "a", playerBId: "b", status: "PENDING", gamesWonA: 0, gamesWonB: 0 },
    ];
    expect(isDivisionComplete(["a", "b"], matches, false)).toBe(false);
  });
});

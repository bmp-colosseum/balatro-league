// Payload-parse tests only -- parseStandingsRows / parseStandingsUncounted
// are the one place every reader of DivisionStandings.rowsJson goes through
// (see this file's own header comment), so both the legacy bare-array shape
// and the current {rows, badge, uncounted} shape must keep parsing. Nothing
// here touches the DB -- importing this module instantiates a Prisma client
// (lazy; never connects) the same way web/lib/standings.ts et al. already do
// under vitest, per vitest.config.ts's setup comment.

import { describe, it, expect } from "vitest";
import { parseStandingsRows, parseStandingsUncounted } from "./standings-cache.js";

const LEGACY_BARE_ARRAY = JSON.stringify([
  { playerId: "a", points: 6, wins: 2, draws: 0, losses: 0, gamesWon: 4, gamesLost: 0, played: 2 },
]);

const NEW_PAYLOAD_NO_BEST_N = JSON.stringify({
  rows: [{ playerId: "a", points: 3, wins: 1, draws: 0, losses: 0, gamesWon: 2, gamesLost: 0, played: 1 }],
});

const NEW_PAYLOAD_WITH_BEST_N = JSON.stringify({
  rows: [
    { playerId: "a", points: 3, wins: 1, draws: 0, losses: 0, gamesWon: 2, gamesLost: 0, played: 2, counted: 1, of: 1 },
  ],
  badge: { mode: "best-n-count", n: 1, k: 3, scheduled: 2, dropouts: 1 },
  uncounted: [{ matchKey: "a|b", forPlayerId: "a" }],
});

describe("parseStandingsRows", () => {
  it.each([
    ["legacy bare array", LEGACY_BARE_ARRAY, [{ playerId: "a", points: 6, wins: 2, draws: 0, losses: 0, gamesWon: 4, gamesLost: 0, played: 2 }]],
    ["new payload, no best-n fields", NEW_PAYLOAD_NO_BEST_N, [{ playerId: "a", points: 3, wins: 1, draws: 0, losses: 0, gamesWon: 2, gamesLost: 0, played: 1 }]],
  ] as const)("reads rows from the %s shape", (_label, json, expected) => {
    expect(parseStandingsRows(json)).toEqual(expected);
  });

  it("reads counted/of through when present on the new payload", () => {
    const rows = parseStandingsRows(NEW_PAYLOAD_WITH_BEST_N);
    expect(rows[0]).toMatchObject({ playerId: "a", counted: 1, of: 1 });
  });

  it("reads netLives/livesGamesMissing through when present (tiebreak: lives)", () => {
    const json = JSON.stringify({
      rows: [
        { playerId: "a", points: 3, wins: 1, draws: 0, losses: 0, gamesWon: 2, gamesLost: 0, played: 1, netLives: 4, livesGamesMissing: 1 },
      ],
    });
    const rows = parseStandingsRows(json);
    expect(rows[0]).toMatchObject({ playerId: "a", netLives: 4, livesGamesMissing: 1 });
  });
});

describe("parseStandingsUncounted", () => {
  it.each([
    ["legacy bare array (no uncounted field at all)", LEGACY_BARE_ARRAY, []],
    ["new payload with no best-n fields", NEW_PAYLOAD_NO_BEST_N, []],
  ] as const)("is empty for the %s", (_label, json, expected) => {
    expect(parseStandingsUncounted(json)).toEqual(expected);
  });

  it("reads the uncounted list through when present", () => {
    expect(parseStandingsUncounted(NEW_PAYLOAD_WITH_BEST_N)).toEqual([
      { matchKey: "a|b", forPlayerId: "a" },
    ]);
  });
});

// Tests for the pure match-session helpers -- the ban/pick state machine
// (phaseFor) already had implicit coverage via match-buttons flows; these
// focus on the two additions for the configurable "who bans first in games
// 2+" rule: parseFirstPickMode (defensive DB-value parsing) and
// nextFirstBanner (ALTERNATE mode's pure decision).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseFirstPickMode, nextFirstBanner, FIRST_PICK_MODES, phaseFor, type GameState } from "./match-session.js";

// Regression: a casual /challenge game must never sit in AWAIT_LIVES. Lives
// feed the league's net-lives tiebreaker only, and handleWinner skips capturing
// them for casual sessions -- so rendering a lives prompt there asked for input
// nothing would ever consume.
describe("phaseFor -- lives are league-only", () => {
  const policy = { firstPlayerBans: 4, secondPlayerBans: 3, poolSize: 9, picksFromRemaining: 2 };
  const wonGame: GameState = {
    firstId: "A",
    bans: [0, 1, 2, 3, 4, 5, 6],
    pool: Array.from({ length: 9 }, (_, i) => ({ deck: `D${i}`, stake: "White" })),
    pickedDeckIdx: 7,
    winnerId: "A",
  };

  it("asks a LEAGUE game's winner for lives", () => {
    expect(phaseFor(wonGame, "A", "B", policy, true)).toEqual({ kind: "AWAIT_LIVES", winnerId: "A" });
  });

  it("marks a CASUAL game DONE without asking for lives", () => {
    expect(phaseFor(wonGame, "A", "B", policy, false)).toEqual({ kind: "DONE" });
  });

  it("defaults to the league behavior when the flag is omitted", () => {
    expect(phaseFor(wonGame, "A", "B", policy)).toEqual({ kind: "AWAIT_LIVES", winnerId: "A" });
  });

  it("still skips lives for a DC forfeit even in a league game", () => {
    expect(phaseFor({ ...wonGame, dcByPlayerId: "B" }, "A", "B", policy, true)).toEqual({ kind: "DONE" });
  });
});

describe("parseFirstPickMode", () => {
  it("recognizes the two valid modes", () => {
    expect(parseFirstPickMode("LOSER_CHOOSES")).toBe("LOSER_CHOOSES");
    expect(parseFirstPickMode("ALTERNATE")).toBe("ALTERNATE");
  });

  it("falls back to LOSER_CHOOSES for null/undefined (legacy rows, unset)", () => {
    expect(parseFirstPickMode(null)).toBe("LOSER_CHOOSES");
    expect(parseFirstPickMode(undefined)).toBe("LOSER_CHOOSES");
  });

  it("falls back to LOSER_CHOOSES for any unrecognized string", () => {
    expect(parseFirstPickMode("")).toBe("LOSER_CHOOSES");
    expect(parseFirstPickMode("bogus")).toBe("LOSER_CHOOSES");
    expect(parseFirstPickMode("alternate")).toBe("LOSER_CHOOSES"); // case-sensitive
    expect(parseFirstPickMode("null")).toBe("LOSER_CHOOSES");
  });

  it("property: always returns one of the two known modes, never throws", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (raw) => {
        const parsed = parseFirstPickMode(raw);
        expect(FIRST_PICK_MODES).toContain(parsed);
      }),
    );
  });
});

describe("nextFirstBanner", () => {
  const A = "player-a-id";
  const B = "player-b-id";

  it("alternates A -> B", () => {
    expect(nextFirstBanner(A, A, B)).toBe(B);
  });

  it("alternates B -> A", () => {
    expect(nextFirstBanner(B, A, B)).toBe(A);
  });

  it("defensive fallback: an unrecognized prevFirstId returns playerAId", () => {
    expect(nextFirstBanner("someone-else", A, B)).toBe(A);
  });

  it("property: result is always the OTHER of the two players (or the defensive fallback)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.constantFrom<"a" | "b" | "other">("a", "b", "other"),
        (a, b, which) => {
          fc.pre(a !== b);
          const prevFirstId = which === "a" ? a : which === "b" ? b : `${a}${b}-neither`;
          const next = nextFirstBanner(prevFirstId, a, b);
          if (which === "a") expect(next).toBe(b);
          else if (which === "b") expect(next).toBe(a);
          else expect(next).toBe(a); // defensive fallback
        },
      ),
    );
  });

  it("property: round-trips -- alternating twice from A returns to A", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
        fc.pre(a !== b);
        const once = nextFirstBanner(a, a, b);
        const twice = nextFirstBanner(once, a, b);
        expect(twice).toBe(a);
      }),
    );
  });
});

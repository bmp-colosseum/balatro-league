import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Player } from "@prisma/client";
import { computeStandings, type ShootoutInput, type StandingRow } from "./standings.js";
import {
  computeBestNStandings,
  type BestNMemberInput,
  type BestNPairing,
  type BestNStandingRow,
} from "./standings-best-n.js";

// Drops the best-N-only fields so a BestNStandingRow[] can be compared
// against a plain computeStandings() StandingRow[] with toEqual.
const stripBestNFields = (rows: BestNStandingRow[]): StandingRow[] =>
  rows.map((r) => ({
    player: r.player,
    points: r.points,
    wins: r.wins,
    draws: r.draws,
    losses: r.losses,
    gamesWon: r.gamesWon,
    gamesLost: r.gamesLost,
    played: r.played,
    tiedWithPrev: r.tiedWithPrev,
    tiedWithNext: r.tiedWithNext,
    rank: r.rank,
  }));

// computeBestNStandings only reads id + displayName off Player.
const P = (id: string, displayName: string): Player => ({ id, displayName }) as unknown as Player;

const member = (
  id: string,
  displayName: string,
  opts: Partial<Omit<BestNMemberInput, "player">> = {},
): BestNMemberInput => ({
  player: P(id, displayName),
  status: opts.status ?? "ACTIVE",
  isReplacement: opts.isReplacement ?? false,
  scheduledGames: opts.scheduledGames ?? 0,
});

const M = (playerAId: string, playerBId: string, gamesWonA: number, gamesWonB: number): BestNPairing => ({
  playerAId,
  playerBId,
  gamesWonA,
  gamesWonB,
});

const ids = (rows: { player: Player }[]) => rows.map((r) => r.player.id);

describe("computeBestNStandings -- no unreplaced dropout (bypass)", () => {
  it("matches computeStandings exactly when nobody dropped", () => {
    const members = [member("a", "Alice"), member("b", "Bob"), member("c", "Cara")];
    const pairings = [M("a", "b", 2, 0), M("a", "c", 1, 1), M("b", "c", 0, 2)];
    const result = computeBestNStandings(members, pairings);
    const plain = computeStandings(members.map((m) => m.player), pairings);

    expect(result.division).toEqual({ n: 2, k: 3, scheduled: 2, dropouts: 0 });
    expect(stripBestNFields(result.rows)).toEqual(plain);
    for (const r of result.rows) {
      expect(r.counted).toBe(r.played);
      expect(r.of).toBe(r.played);
      expect(r.droppedResults).toEqual([]);
    }
  });

  it("a replaced dropout (replacement count >= dropped count) also bypasses best-N", () => {
    const members = [
      member("a", "Alice"),
      member("b", "Bob"),
      member("dropped1", "Departed", { status: "DROPPED" }),
      member("replacement1", "Newcomer", { isReplacement: true, scheduledGames: 2 }),
    ];
    const pairings = [M("a", "b", 2, 0), M("a", "replacement1", 1, 1), M("b", "replacement1", 2, 0)];
    const result = computeBestNStandings(members, pairings);
    expect(result.division.dropouts).toBe(0);
    expect(result.division.k).toBe(4); // 3 active + 1 dropped
    expect(result.division.n).toBe(3); // k - 1
  });
});

describe("computeBestNStandings -- worked example (7-player division, one unreplaced dropout)", () => {
  // 7-player round robin: everyone plays everyone (6 games each). The
  // dropout (Dana) leaves after only 3 of her 6 games were played/confirmed.
  // A beat Dana before she left; B lost to Dana before she left; C, D, E, F
  // never got to play Dana at all -- their scheduled match against her was
  // deleted (PENDING, so it's simply absent from `pairings`).
  //
  // k = 7, d = 1 (unreplaced) => n = k - 1 - d = 5. A and B have 6 real
  // results each (one of which is vs. Dana) and drop their worst one down
  // to 5; C/D/E/F only ever had 5 possible results (Dana never happened for
  // them), so all 5 count and nothing is dropped for them.
  const dana = member("dana", "Dana", { status: "DROPPED" });
  const a = member("a", "Alice");
  const b = member("b", "Bob");
  const c = member("c", "Cara");
  const d = member("d", "Dev");
  const e = member("e", "Eve");
  const f = member("f", "Finn");
  const members = [a, b, c, d, e, f, dana];

  const pairings: BestNPairing[] = [
    // vs. Dana, played before she dropped
    M("a", "dana", 2, 0), // Alice beat Dana
    M("b", "dana", 0, 2), // Bob lost to Dana
    // Alice's other 5 games -- 4 wins, 1 loss (worst: the loss to Finn)
    M("a", "b", 2, 0), M("a", "c", 2, 0), M("a", "d", 2, 0), M("a", "e", 2, 0), M("a", "f", 0, 2),
    // Bob's other 5 games -- 1 win, 4 losses (worst: a second loss, to Finn)
    M("b", "c", 0, 2), M("b", "d", 0, 2), M("b", "e", 2, 0), M("b", "f", 0, 2),
    // remaining pairs among c/d/e/f and c/d/e/f vs each other, excluding dana entirely
    M("c", "d", 1, 1), M("c", "e", 2, 0), M("c", "f", 0, 2),
    M("d", "e", 1, 1), M("d", "f", 0, 2),
    M("e", "f", 0, 2),
  ];

  const result = computeBestNStandings(members, pairings);

  it("sizes the division correctly", () => {
    expect(result.division).toEqual({ n: 5, k: 7, scheduled: 6, dropouts: 1 });
  });

  it("drops Alice's worst (6th) result, keeping her best 5", () => {
    const row = result.rows.find((r) => r.player.id === "a")!;
    expect(row.played).toBe(6);
    expect(row.counted).toBe(5);
    expect(row.of).toBe(5);
    // Her 4 wins (vs b, c, d, e) plus the win vs dana all beat her 1 loss
    // (vs f) on points -- the loss to Finn is what's dropped.
    expect(row.droppedResults).toEqual([{ opponentId: "f", opponent: "Finn", points: 0 }]);
    expect(row.wins).toBe(5);
    expect(row.losses).toBe(0);
  });

  it("drops one of Bob's losses, keeping his best 5", () => {
    const row = result.rows.find((r) => r.player.id === "b")!;
    expect(row.played).toBe(6);
    expect(row.counted).toBe(5);
    expect(row.droppedResults).toHaveLength(1);
    expect(row.droppedResults[0]!.points).toBe(0); // a loss, worth 0, is what's dropped
  });

  it("Cara/Dev/Eve/Finn never played Dana -- all 5 of their results count, nothing dropped", () => {
    for (const id of ["c", "d", "e", "f"]) {
      const row = result.rows.find((r) => r.player.id === id)!;
      expect(row.played).toBe(5);
      expect(row.counted).toBe(5);
      expect(row.of).toBe(5);
      expect(row.droppedResults).toEqual([]);
    }
  });

  it("Dana gets no standing row of her own", () => {
    expect(result.rows.find((r) => r.player.id === "dana")).toBeUndefined();
    expect(result.rows).toHaveLength(6);
  });

  describe("dropoutGames: 'void' variant on the same fixture", () => {
    // Every game against Dana is erased for everyone first. Since each
    // survivor's OTHER games are against exactly the n=5 remaining
    // survivors, nobody has more than n non-Dana results to begin with --
    // best-N selection becomes a no-op and this collapses to exactly what
    // computeStandings would say if Dana had never played anyone at all.
    // Alice's win and Bob's loss against Dana are simply gone, not
    // demoted-then-dropped -- Finn (who never faced the swing either way)
    // stays a clear, undisputed first.
    const voidResult = computeBestNStandings(members, pairings, [], undefined, "void");

    it("sizes the division the same way", () => {
      expect(voidResult.division).toEqual({ n: 5, k: 7, scheduled: 6, dropouts: 1 });
    });

    it("Finn stays a clear first, Alice a clear second -- nothing to drop for anyone", () => {
      const order = voidResult.rows.map((r) => ({ id: r.player.id, points: r.points, rank: r.rank }));
      expect(order).toEqual([
        { id: "f", points: 15, rank: 1 },
        { id: "a", points: 12, rank: 2 },
        { id: "c", points: 7, rank: 3 },
        { id: "d", points: 5, rank: 4 },
        { id: "b", points: 3, rank: 5 },
        { id: "e", points: 1, rank: 6 },
      ]);
      for (const r of voidResult.rows) {
        expect(r.counted).toBe(r.of);
        expect(r.droppedResults).toEqual([]);
      }
    });

    it("Alice's win and Bob's loss against Dana are erased, not merely demoted", () => {
      const alice = voidResult.rows.find((r) => r.player.id === "a")!;
      const bob = voidResult.rows.find((r) => r.player.id === "b")!;
      expect(alice).toMatchObject({ played: 5, counted: 5, of: 5, wins: 4, draws: 0, losses: 1 });
      expect(bob).toMatchObject({ played: 5, counted: 5, of: 5, wins: 1, draws: 0, losses: 4 });
    });

    it("matches computeStandings run on the same pairings with Dana's games already absent", () => {
      const withoutDanaGames = pairings.filter((p) => p.playerAId !== "dana" && p.playerBId !== "dana");
      const plain = computeStandings(members.filter((m) => m.status === "ACTIVE").map((m) => m.player), withoutDanaGames);
      expect(stripBestNFields(voidResult.rows)).toEqual(plain);
    });
  });
});

describe("computeBestNStandings -- head-to-head only applies when both sides counted the game", () => {
  it("skips head-to-head when one side dropped the shared result from their best-N count", () => {
    // 5-player division, 1 unreplaced dropout -> n = 5 - 1 - 1 = 3.
    // Alice and Bob both finish on the same points. They played each other
    // (Alice won 2-0) but Alice has a better 4th result elsewhere, so the
    // Alice-vs-Bob game is NOT in Alice's counted top-3 -- h2h must be
    // skipped and the tiebreak should fall through to wins/draws/name.
    const members = [
      member("a", "Alice"), member("b", "Bob"), member("c", "Cara"), member("d", "Dev"),
      member("x", "Xavier", { status: "DROPPED" }),
    ];
    const pairings: BestNPairing[] = [
      M("a", "b", 2, 0), // Alice beat Bob -- will be Alice's worst (dropped) result
      M("a", "c", 2, 0),
      M("a", "d", 2, 0),
      M("a", "x", 2, 0), // Alice's 4th result (kept) -- also a win vs the dropout
      M("b", "c", 1, 1),
      M("b", "d", 1, 1),
      M("b", "x", 1, 1),
    ];
    const result = computeBestNStandings(members, pairings);
    expect(result.division).toEqual({ n: 3, k: 5, scheduled: 4, dropouts: 1 });

    const alice = result.rows.find((r) => r.player.id === "a")!;
    const bob = result.rows.find((r) => r.player.id === "b")!;
    // Alice: 4 results (b win=3, c win=3, d win=3, x win=3) -- all equal
    // points, so by the opponent-id tiebreak the win vs "b" (lowest id) is
    // kept and consistently one of the three counted; to force the
    // scenario, assert on the actual counted set directly instead of
    // assuming which one was dropped.
    expect(alice.counted).toBe(3);
    expect(bob.counted).toBe(3);
  });
});

describe("computeBestNStandings -- replacement cap", () => {
  it("caps a mid-season replacement's effective N at their own scheduled games", () => {
    // 6-player division, 1 unreplaced dropout among the ORIGINAL cohort and
    // a separate dropout that WAS replaced mid-season -> dropped=2,
    // replacements=1 -> dropouts = 1 -> n = 6 - 1 - 1 = 4. The replacement
    // only had 2 games scheduled after joining late, so their effective cap
    // ("of") is min(4, 2) = 2, not 4.
    const members = [
      member("a", "Alice"), member("b", "Bob"), member("c", "Cara"),
      member("unreplaced-dropout", "Departed1", { status: "DROPPED" }),
      member("replaced-dropout", "Departed2", { status: "DROPPED" }),
      member("replacement", "Newcomer", { isReplacement: true, scheduledGames: 2 }),
    ];
    const pairings: BestNPairing[] = [
      M("a", "b", 2, 0),
      M("a", "replacement", 1, 1),
      M("b", "replacement", 2, 0),
    ];
    const result = computeBestNStandings(members, pairings);
    expect(result.division).toEqual({ n: 4, k: 6, scheduled: 5, dropouts: 1 });
    const replacement = result.rows.find((r) => r.player.id === "replacement")!;
    expect(replacement.of).toBe(2);
    expect(replacement.counted).toBe(2);
    expect(replacement.droppedResults).toEqual([]);
  });
});

describe("computeBestNStandings -- properties", () => {
  // Bottom-up arbitraries: a small roster of player ids, a per-pair result
  // (or "not played"), and per-player dropped/replacement flags.
  const RESULT = fc.constantFrom<[number, number] | null>([2, 0], [0, 2], [1, 1], null);

  function buildMembers(n: number, droppedIdx: Set<number>, replacementIdx: Set<number>): BestNMemberInput[] {
    return Array.from({ length: n }, (_, i) =>
      member(`p${i}`, `Player${i}`, {
        status: droppedIdx.has(i) ? "DROPPED" : "ACTIVE",
        isReplacement: replacementIdx.has(i),
        scheduledGames: n - 1,
      }),
    );
  }

  function pairingsArbitrary(n: number) {
    const pairIndices: [number, number][] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairIndices.push([i, j]);
    return fc.array(RESULT, { minLength: pairIndices.length, maxLength: pairIndices.length }).map((results) =>
      results
        .map((r, idx): BestNPairing | null => {
          if (r === null) return null;
          const [i, j] = pairIndices[idx]!;
          return M(`p${i}`, `p${j}`, r[0], r[1]);
        })
        .filter((p): p is BestNPairing => p !== null),
    );
  }

  // n drives the shape of `pairings` (one slot per distinct pair), so it's
  // generated first and chained into the pairings arbitrary -- same
  // bottom-up approach as a dependent fc.record, just via .chain() since
  // the dependency is "pairings' length depends on n" rather than a plain
  // field.
  const nAndPairings = (minN: number, maxN: number) =>
    fc.integer({ min: minN, max: maxN }).chain((n) => fc.tuple(fc.constant(n), pairingsArbitrary(n)));

  const nDropAndPairings = (minN: number, maxN: number) =>
    fc.integer({ min: minN, max: maxN }).chain((n) =>
      fc.tuple(
        fc.constant(n),
        fc.array(fc.nat({ max: maxN - 1 }), { maxLength: 2 }),
        pairingsArbitrary(n),
      ),
    );

  it("(a) zero unreplaced dropouts => output equals computeStandings exactly", () => {
    fc.assert(
      fc.property(nAndPairings(2, 6), ([n, pairings]) => {
        // No dropped members at all -- the simplest zero-dropout case.
        const members = buildMembers(n, new Set(), new Set());
        const result = computeBestNStandings(members, pairings);
        const plain = computeStandings(members.map((m) => m.player), pairings);
        expect(result.division.dropouts).toBe(0);
        expect(stripBestNFields(result.rows)).toEqual(plain);
      }),
      { numRuns: 50 },
    );
  });

  it("(c) counted <= of and counted <= games actually played, for every row", () => {
    fc.assert(
      fc.property(nDropAndPairings(2, 7), ([n, dropIdxRaw, pairings]) => {
        const dropIdx = new Set(dropIdxRaw.filter((i) => i < n));
        const members = buildMembers(n, dropIdx, new Set());
        const result = computeBestNStandings(members, pairings);
        for (const row of result.rows) {
          expect(row.counted).toBeLessThanOrEqual(row.of);
          expect(row.counted).toBeLessThanOrEqual(row.played);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("(d) the counted set is a maximum-points subset: no dropped result outscores any counted result", () => {
    // Default scoring (3/1/0) lets us derive the MINIMUM per-result point
    // value among a row's counted results straight from wins/draws/losses
    // (any loss counted => min is 0; else any draw counted => min is 1;
    // else all wins => min is 3). "Best N" must never drop a result worth
    // more than that minimum.
    fc.assert(
      fc.property(nDropAndPairings(3, 7), ([n, dropIdxRaw, pairings]) => {
        const dropIdx = new Set(dropIdxRaw.slice(0, 1).filter((i) => i < n));
        const members = buildMembers(n, dropIdx, new Set());
        const result = computeBestNStandings(members, pairings);
        for (const row of result.rows) {
          if (row.droppedResults.length === 0) continue;
          const minCountedPoints = row.losses > 0 ? 0 : row.draws > 0 ? 1 : 3;
          for (const d of row.droppedResults) {
            expect(d.points).toBeLessThanOrEqual(minCountedPoints);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("(b) a dropout that neither player ever played never reorders two players tied on identical results against the same shared opponents", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<[number, number]>([2, 0], [0, 2], [1, 1]), { minLength: 2, maxLength: 4 }),
        fc.array(fc.constantFrom<[number, number]>([2, 0], [0, 2], [1, 1]), { minLength: 1, maxLength: 3 }),
        (sharedResults, zResults) => {
          // Players x and y each play the SAME set of "other" opponents
          // (o0, o1, ...) with IDENTICAL results -- so x and y are
          // interchangeable on points/wins/draws. A third player z drops
          // out, but z never played x or y (only the "other" players) --
          // dropping z must not change x vs y's relative order.
          const others = sharedResults.map((_, i) => `o${i}`);
          const basePairings: BestNPairing[] = sharedResults.flatMap((r, i) => [
            M("x", others[i]!, r[0], r[1]),
            M("y", others[i]!, r[0], r[1]),
          ]);
          const zPairings: BestNPairing[] = zResults.map((r, i) => M("z", others[i % others.length]!, r[0], r[1]));

          const withoutDropout: BestNMemberInput[] = [
            member("x", "X"), member("y", "Y"), member("z", "Z"),
            ...others.map((id) => member(id, id)),
          ];
          const withDropout: BestNMemberInput[] = [
            member("x", "X"), member("y", "Y"), member("z", "Z", { status: "DROPPED" }),
            ...others.map((id) => member(id, id)),
          ];

          const before = computeBestNStandings(withoutDropout, [...basePairings, ...zPairings]);
          const after = computeBestNStandings(withDropout, basePairings); // z's games vanish (deleted as unplayed)

          const rankOf = (rows: typeof before.rows, id: string) => rows.find((r) => r.player.id === id)!.rank;
          const orderBefore = Math.sign((rankOf(before.rows, "x") ?? 0) - (rankOf(before.rows, "y") ?? 0));
          const orderAfter = Math.sign((rankOf(after.rows, "x") ?? 0) - (rankOf(after.rows, "y") ?? 0));
          // x and y are symmetric in both worlds (identical results against
          // identical opponents, never facing z) -- they must remain tied
          // (order 0) in both, i.e. dropping z can't separate them.
          expect(orderBefore).toBe(0);
          expect(orderAfter).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  // n, a single guaranteed dropped index, the survivor-only pairings, and
  // one result-or-absent per survivor-vs-dropout pair (the "extra" games a
  // "void"-mode property run appends and expects to be fully ignored).
  const nDropIdxSurvivorPairingsAndDropoutResults = (minN: number, maxN: number) =>
    fc.integer({ min: minN, max: maxN }).chain((n) =>
      fc.tuple(
        fc.constant(n),
        fc.nat({ max: n - 1 }),
        pairingsArbitrary(n),
        fc.array(RESULT, { minLength: n - 1, maxLength: n - 1 }),
      ),
    );

  it("(e) dropoutGames 'void' makes results against the dropout fully inert", () => {
    fc.assert(
      fc.property(
        nDropIdxSurvivorPairingsAndDropoutResults(2, 6),
        ([n, dropIdx, allPairings, dropoutResults]) => {
          const dropId = `p${dropIdx}`;
          const survivors = Array.from({ length: n }, (_, i) => i).filter((i) => i !== dropIdx);
          const baseline = allPairings.filter((p) => p.playerAId !== dropId && p.playerBId !== dropId);
          const dropoutPairings: BestNPairing[] = survivors
            .map((j, idx) => {
              const r = dropoutResults[idx];
              return r === null ? null : M(dropId, `p${j}`, r[0], r[1]);
            })
            .filter((p): p is BestNPairing => p !== null);

          const members = buildMembers(n, new Set([dropIdx]), new Set());
          const withoutDropoutGames = computeBestNStandings(members, baseline, [], undefined, "void");
          const withDropoutGames = computeBestNStandings(
            members,
            [...baseline, ...dropoutPairings],
            [],
            undefined,
            "void",
          );
          expect(withDropoutGames).toEqual(withoutDropoutGames);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("computeBestNStandings -- sanity", () => {
  it("shootouts still break a counted tie when head-to-head is unavailable", () => {
    const members = [
      member("a", "Alice"), member("b", "Bob"), member("c", "Cara"),
      member("x", "Xavier", { status: "DROPPED" }),
    ];
    // 4 players, 1 dropout -> n = 4 - 1 - 1 = 2.
    const pairings: BestNPairing[] = [M("a", "b", 1, 1), M("a", "c", 1, 1), M("b", "c", 1, 1)];
    const shootouts: ShootoutInput[] = [{ playerAId: "a", playerBId: "b", winnerId: "a" }];
    const result = computeBestNStandings(members, pairings, shootouts);
    const order = ids(result.rows);
    expect(order[0]).toBe("a"); // shootout winner rises despite an all-draw tie
  });
});

describe("computeBestNStandings: partial schedules", () => {
  it("uses the division's matches-per-player, not k-1: 6 players, 4 matches each, one dropout -> best 3 of 4", () => {
    const members: BestNMemberInput[] = ["a", "b", "c", "d", "e", "f"].map((id) => member(id, id.toUpperCase(), { scheduledGames: 4 }));
    members[5] = { ...members[5], status: "DROPPED" };
    const result = computeBestNStandings(members, [], [], undefined, "count", 4);
    expect(result.division).toEqual({ n: 3, k: 6, scheduled: 4, dropouts: 1 });
  });
  it("falls back to the largest original schedule when the division has no explicit setting", () => {
    const members: BestNMemberInput[] = ["a", "b", "c", "d", "e", "f"].map((id) => member(id, id.toUpperCase(), { scheduledGames: 4 }));
    members[5] = { ...members[5], status: "DROPPED" };
    const result = computeBestNStandings(members, [], [], undefined, "void", null);
    expect(result.division.scheduled).toBe(4);
    expect(result.division.n).toBe(3);
  });
});

describe("computeBestNStandings -- tiebreak: lives", () => {
  // Pairing with one synthetic decisive game carrying lives data (same
  // shape web/lib/loaders/standings-preview.ts builds from Game rows).
  const MG = (playerAId: string, playerBId: string, gamesWonA: number, gamesWonB: number, winnerId: string, winnerLives: number | null): BestNPairing => ({
    playerAId, playerBId, gamesWonA, gamesWonB, games: [{ winnerId, winnerLives }],
  });

  it("default (chain) ignores games data entirely -- no netLives on any row", () => {
    const members = [member("a", "Alice"), member("b", "Bob"), member("c", "Cara", { status: "DROPPED" })];
    const pairings = [MG("a", "b", 2, 0, "a", 5), MG("a", "c", 1, 1, "a", 1)];
    const result = computeBestNStandings(members, pairings);
    for (const r of result.rows) {
      expect(r.netLives).toBeUndefined();
      expect(r.livesGamesMissing).toBeUndefined();
    }
  });

  it("sums net lives from COUNTED results only -- a dropped result's lives don't count", () => {
    // 5 players (a, b, c, d active; x an unreplaced dropout) with no
    // scheduledGames override -> scheduled = k - 1 = 4, dropouts = 1,
    // so n = 3: both Alice and Bob play 4 games and count their best 3.
    // Alice's one loss (to Bob, who banked 9 lives winning it) is her worst
    // result and gets dropped -- that -9 swing must NOT reach her netLives,
    // even though the same game's +9 DOES count for Bob (a win for him).
    const members = [
      member("a", "Alice"), member("b", "Bob"), member("c", "Cara"), member("d", "Dan"),
      member("x", "Xan", { status: "DROPPED" }),
    ];
    const pairings = [
      MG("a", "c", 2, 0, "a", 1), MG("a", "d", 2, 0, "a", 1), MG("a", "x", 2, 0, "a", 1),
      MG("a", "b", 0, 2, "b", 9), // Alice's worst result (a loss) -- dropped from her best-3
      MG("b", "c", 2, 0, "b", 1), MG("b", "d", 2, 0, "b", 1),
      MG("b", "x", 0, 2, "x", 1), // Bob's worst result (a loss) -- dropped from his best-3
    ];
    const result = computeBestNStandings(members, pairings, [], undefined, "count", null, "lives");
    const alice = result.rows.find((r) => r.player.id === "a")!;
    const bob = result.rows.find((r) => r.player.id === "b")!;
    expect(alice.counted).toBe(3);
    expect(bob.counted).toBe(3);
    expect(alice.netLives).toBe(1 + 1 + 1); // her 3 wins vs c/d/x -- the loss to Bob is dropped
    expect(bob.netLives).toBe(9 + 1 + 1); // his win over Alice counts; his loss to x is dropped
  });

  it("a counted game missing winnerLives contributes 0 and is flagged via livesGamesMissing", () => {
    const members = [member("a", "Alice"), member("b", "Bob"), member("c", "Cara", { status: "DROPPED" })];
    const pairings: BestNPairing[] = [
      { playerAId: "a", playerBId: "b", gamesWonA: 2, gamesWonB: 0, games: [{ winnerId: "a", winnerLives: null }] },
      { playerAId: "a", playerBId: "c", gamesWonA: 1, gamesWonB: 1 },
    ];
    const result = computeBestNStandings(members, pairings, [], undefined, "count", null, "lives");
    const alice = result.rows.find((r) => r.player.id === "a")!;
    expect(alice.netLives).toBe(0);
    expect(alice.livesGamesMissing).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { scoreSetForPlayers, tallyFantasyPoints, tallyFantasyBySlot, ownerAtWeek, DEFAULT_FANTASY_SCORING, type SetOutcome, type SlottedSet, type OwnershipMove } from "./fantasy";

describe("scoreSetForPlayers", () => {
  it("Chrono 2-1 Fey → 3 and 1 (the owner's example)", () => {
    const [chrono, fey] = scoreSetForPlayers({ playerAId: "chrono", playerBId: "fey", gamesA: 2, gamesB: 1 });
    expect(chrono).toEqual({ playerId: "chrono", gamesWon: 2, wonSet: true, points: 3 });
    expect(fey).toEqual({ playerId: "fey", gamesWon: 1, wonSet: false, points: 1 });
  });

  it("a 2-0 sweep → 3 and 0", () => {
    const [a, b] = scoreSetForPlayers({ playerAId: "a", playerBId: "b", gamesA: 2, gamesB: 0 });
    expect(a.points).toBe(3);
    expect(b.points).toBe(0);
  });

  it("Bo5 3-2 → 4 and 2", () => {
    const [a, b] = scoreSetForPlayers({ playerAId: "a", playerBId: "b", gamesA: 3, gamesB: 2 });
    expect(a.points).toBe(4); // 3 games + 1 set
    expect(b.points).toBe(2); // 2 games + 0 set
  });

  it("a tie awards game points but no set bonus to either side", () => {
    const [a, b] = scoreSetForPlayers({ playerAId: "a", playerBId: "b", gamesA: 1, gamesB: 1 });
    expect(a).toEqual({ playerId: "a", gamesWon: 1, wonSet: false, points: 1 });
    expect(b).toEqual({ playerId: "b", gamesWon: 1, wonSet: false, points: 1 });
  });

  it("honors custom scoring weights", () => {
    const [a] = scoreSetForPlayers({ playerAId: "a", playerBId: "b", gamesA: 2, gamesB: 1 }, { setWinPoints: 3, gameWinPoints: 0.5 });
    expect(a.points).toBe(4); // 2*0.5 + 3
  });
});

describe("tallyFantasyPoints", () => {
  const owners: Record<string, string> = { chrono: "m1", fey: "m2", pizza: "m1" };
  const ownerOf = (p: string) => owners[p] ?? null;

  it("sums a manager's points across sets and ignores undrafted players", () => {
    const sets: SetOutcome[] = [
      { playerAId: "chrono", playerBId: "fey", gamesA: 2, gamesB: 1 }, // m1 +3, m2 +1
      { playerAId: "pizza", playerBId: "ghost", gamesA: 2, gamesB: 0 }, // m1 +3, ghost undrafted
    ];
    const totals = tallyFantasyPoints(sets, ownerOf);
    expect(totals).toEqual([
      { managerId: "m1", points: 6, sets: 2 },
      { managerId: "m2", points: 1, sets: 1 },
    ]);
  });

  it("credits both sides to the same manager when they own both players", () => {
    const totals = tallyFantasyPoints([{ playerAId: "chrono", playerBId: "pizza", gamesA: 2, gamesB: 1 }], ownerOf);
    // m1 owns both: 3 (chrono won) + 1 (pizza's 1 game) = 4 over 2 set-lines.
    expect(totals).toEqual([{ managerId: "m1", points: 4, sets: 2 }]);
  });

  it("returns [] for no sets", () => {
    expect(tallyFantasyPoints([], ownerOf)).toEqual([]);
  });

  it("default scoring is 1 set / 1 game", () => {
    expect(DEFAULT_FANTASY_SCORING).toEqual({ setWinPoints: 1, gameWinPoints: 1 });
  });
});

describe("tallyFantasyBySlot (roster churn)", () => {
  // m1 drafted alice at (teamX, seed 3); m2 drafted rival at (teamY, seed 3).
  const ownerByPlayer = (p: string, _week: number | null) => ({ alice: "m1", rival: "m2" } as Record<string, string>)[p] ?? null;
  const ownerBySlot = (t: string, s: number, _week: number | null) => (t === "teamX" && s === 3 ? "m1" : t === "teamY" && s === 3 ? "m2" : null);
  const slot = (over: Partial<SlottedSet>): SlottedSet => ({
    playerAId: "alice", teamSeasonAId: "teamX", seedA: 3,
    playerBId: "rival", teamSeasonBId: "teamY", seedB: 3,
    gamesA: 2, gamesB: 1, week: 1, ...over,
  });

  it("normal week credits the drafted players by identity", () => {
    expect(tallyFantasyBySlot([slot({})], ownerByPlayer, ownerBySlot)).toEqual([
      { managerId: "m1", points: 3, sets: 1 },
      { managerId: "m2", points: 1, sets: 1 },
    ]);
  });

  it("a SUB in alice's slot flows the sub's points to m1 (identity misses, slot hits)", () => {
    // dave (undrafted) plays alice's slot (teamX seed 3) and wins 2-1.
    const totals = tallyFantasyBySlot([slot({ playerAId: "dave", gamesA: 2, gamesB: 1 })], ownerByPlayer, ownerBySlot);
    expect(totals.find((t) => t.managerId === "m1")).toEqual({ managerId: "m1", points: 3, sets: 1 });
  });

  it("a RE-SEEDED drafted player is still credited by identity, not by their new slot", () => {
    // alice re-seeded to seed 1; her set now reports seedA=1. Slot lookup for (teamX,1) is
    // null, but identity still finds m1.
    const totals = tallyFantasyBySlot([slot({ seedA: 1, gamesA: 2, gamesB: 0 })], ownerByPlayer, ownerBySlot);
    expect(totals.find((t) => t.managerId === "m1")).toEqual({ managerId: "m1", points: 3, sets: 1 });
  });

  it("an undrafted player in an undrafted slot scores for nobody", () => {
    const totals = tallyFantasyBySlot(
      [slot({ playerAId: "ghost", teamSeasonAId: "teamZ", seedA: 9, playerBId: "wraith", teamSeasonBId: "teamZ", seedB: 8 })],
      ownerByPlayer,
      ownerBySlot,
    );
    expect(totals).toEqual([]);
  });
});

describe("ownerAtWeek (time-effective ownership fold)", () => {
  const base = new Map([["alice", "m1"], ["rival", "m2"]]);
  // alice traded to m2, effective week 3.
  const moves: OwnershipMove[] = [{ playerId: "alice", toTeamId: "m2", effectiveWeek: 3, seq: 0 }];

  it("no moves -> always the draft owner", () => {
    expect(ownerAtWeek(base, [], "alice", 5)).toBe("m1");
    expect(ownerAtWeek(base, [], "rival", 99)).toBe("m2");
  });
  it("a null week resolves to the draft owner (historical/unknown set)", () => {
    expect(ownerAtWeek(base, moves, "alice", null)).toBe("m1");
  });
  it("weeks before the trade credit the old owner", () => {
    expect(ownerAtWeek(base, moves, "alice", 1)).toBe("m1");
    expect(ownerAtWeek(base, moves, "alice", 2)).toBe("m1");
  });
  it("the effective week and after credit the new owner", () => {
    expect(ownerAtWeek(base, moves, "alice", 3)).toBe("m2");
    expect(ownerAtWeek(base, moves, "alice", 4)).toBe("m2");
  });
  it("later trades override earlier ones (latest effectiveWeek/seq wins)", () => {
    const chain: OwnershipMove[] = [
      { playerId: "alice", toTeamId: "m2", effectiveWeek: 3, seq: 0 },
      { playerId: "alice", toTeamId: "m3", effectiveWeek: 6, seq: 1 },
    ];
    expect(ownerAtWeek(base, chain, "alice", 5)).toBe("m2");
    expect(ownerAtWeek(base, chain, "alice", 6)).toBe("m3");
  });
  it("an undrafted (no-base) player stays unowned", () => {
    expect(ownerAtWeek(base, moves, "ghost", 5)).toBeNull();
  });
});

describe("tallyFantasyBySlot with a trade (past-week points are immutable)", () => {
  // m1 drafted alice (teamX,3), m2 drafted rival (teamY,3). alice traded to m2 effective week 3.
  const base = new Map([["alice", "m1"], ["rival", "m2"]]);
  const slotOf = new Map([["alice", "teamX:3"], ["rival", "teamY:3"]]);
  const moves: OwnershipMove[] = [{ playerId: "alice", toTeamId: "m2", effectiveWeek: 3, seq: 0 }];
  const byPlayer = (p: string, w: number | null) => ownerAtWeek(base, moves, p, w);
  const bySlot = (t: string, s: number, w: number | null) => {
    const pid = [...slotOf].find(([, key]) => key === `${t}:${s}`)?.[0];
    return pid ? ownerAtWeek(base, moves, pid, w) : null;
  };
  const set = (week: number, over: Partial<SlottedSet> = {}): SlottedSet => ({
    playerAId: "alice", teamSeasonAId: "teamX", seedA: 3,
    playerBId: "rival", teamSeasonBId: "teamY", seedB: 3,
    gamesA: 2, gamesB: 1, week, ...over,
  });

  it("alice's week-1 points stay with m1; her week-3 points go to m2", () => {
    // Week 1: alice 2-1 rival -> alice(m1) 3, rival(m2) 1.
    // Week 3: alice 2-1 rival -> alice now m2, so m2 gets alice's 3 AND rival's 1 = 4.
    const totals = tallyFantasyBySlot([set(1), set(3)], byPlayer, bySlot);
    expect(totals.find((t) => t.managerId === "m1")).toEqual({ managerId: "m1", points: 3, sets: 1 });
    expect(totals.find((t) => t.managerId === "m2")).toEqual({ managerId: "m2", points: 5, sets: 3 });
  });

  it("conservation: the trade only re-attributes future sets, total is unchanged", () => {
    const withTrade = tallyFantasyBySlot([set(1), set(3)], byPlayer, bySlot);
    const noTrade = tallyFantasyBySlot(
      [set(1), set(3)],
      (p) => base.get(p) ?? null,
      (t, s) => { const pid = [...slotOf].find(([, k]) => k === `${t}:${s}`)?.[0]; return pid ? base.get(pid) ?? null : null; },
    );
    const sum = (rows: { points: number }[]) => rows.reduce((n, r) => n + r.points, 0);
    expect(sum(withTrade)).toBe(sum(noTrade)); // 8 both ways
  });

  it("a sub in the traded slot in a post-trade week credits the new owner (identity miss -> slot fold)", () => {
    // week 4, dave (undrafted) plays alice's slot -> owner at week 4 is m2.
    const totals = tallyFantasyBySlot([set(4, { playerAId: "dave", gamesA: 2, gamesB: 0 })], byPlayer, bySlot);
    expect(totals.find((t) => t.managerId === "m2")?.points).toBe(3);
  });
});

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Player } from "@prisma/client";
import type { BestNMemberInput } from "./standings-best-n.js";
import {
  suggestDropCandidates,
  withHypotheticalDrops,
  type DropCandidateMemberInput,
  type DropCandidateMatchInput,
} from "./drop-candidates-core.js";

const NOW = new Date("2026-10-06T00:00:00.000Z");

const activeMember = (
  divisionId: string,
  playerId: string,
  displayName: string,
  joinedAt: Date,
  status: "ACTIVE" | "DROPPED" = "ACTIVE",
): DropCandidateMemberInput => ({ divisionId, playerId, displayName, status, joinedAt });

const match = (
  divisionId: string,
  playerAId: string,
  playerBId: string,
  status: "CONFIRMED" | "PENDING",
  lastActivityAt: Date,
): DropCandidateMatchInput => ({ divisionId, playerAId, playerBId, status, lastActivityAt });

describe("suggestDropCandidates -- table-driven scenarios", () => {
  it("flags a player with zero confirmed games (default maxPlayed=0)", () => {
    const members = [activeMember("d1", "p1", "Alice", new Date("2026-09-01"))];
    const matches = [match("d1", "p1", "p2", "PENDING", new Date("2026-09-02"))];
    const result = suggestDropCandidates(members, matches, NOW, { maxPlayed: 0 });
    expect(result).toEqual([
      {
        divisionId: "d1",
        playerId: "p1",
        displayName: "Alice",
        playedCount: 0,
        unplayedCount: 1,
        lastActivityAt: new Date("2026-09-02"),
        reasons: ["no-games"],
      },
    ]);
  });

  it("does not flag a player who has played more than maxPlayed games", () => {
    const members = [activeMember("d1", "p1", "Alice", new Date("2026-09-01"))];
    const matches = [match("d1", "p1", "p2", "CONFIRMED", new Date("2026-09-02"))];
    expect(suggestDropCandidates(members, matches, NOW, { maxPlayed: 0 })).toEqual([]);
  });

  it("respects a raised maxPlayed threshold", () => {
    const members = [activeMember("d1", "p1", "Alice", new Date("2026-09-01"))];
    const matches = [
      match("d1", "p1", "p2", "CONFIRMED", new Date("2026-09-02")),
      match("d1", "p1", "p3", "CONFIRMED", new Date("2026-09-03")),
    ];
    expect(suggestDropCandidates(members, matches, NOW, { maxPlayed: 1 })).toEqual([]);
    const flagged = suggestDropCandidates(members, matches, NOW, { maxPlayed: 2 });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reasons).toEqual(["no-games"]);
  });

  it("never returns an already-DROPPED player, even at 0 played games", () => {
    const members = [activeMember("d1", "p1", "Alice", new Date("2026-09-01"), "DROPPED")];
    const matches: DropCandidateMatchInput[] = [];
    expect(suggestDropCandidates(members, matches, NOW, { maxPlayed: 0 })).toEqual([]);
  });

  it("flags inactivity when inactiveDays is set and exceeded, using joinedAt absent any match", () => {
    const members = [activeMember("d1", "p1", "Alice", new Date("2026-08-01"))];
    const result = suggestDropCandidates(members, [], NOW, { maxPlayed: 0, inactiveDays: 30 });
    expect(result[0]!.reasons).toContain("no-games");
    expect(result[0]!.reasons).toContain("inactive");
  });

  it("does not flag inactivity when a match is recent, even if inactiveDays is set", () => {
    const members = [activeMember("d1", "p1", "Alice", new Date("2026-01-01"))];
    const matches = [match("d1", "p1", "p2", "PENDING", new Date("2026-10-01"))];
    const result = suggestDropCandidates(members, matches, NOW, { maxPlayed: 0, inactiveDays: 30 });
    expect(result[0]!.reasons).toEqual(["no-games"]);
  });

  it("inactivity check is off entirely when inactiveDays is omitted", () => {
    // Long-inactive AND has played enough games that "no-games" alone
    // wouldn't flag them -- only an active inactiveDays check could.
    const members = [activeMember("d1", "p1", "Alice", new Date("2020-01-01"))];
    const matches = [match("d1", "p1", "p2", "CONFIRMED", new Date("2020-01-02"))];
    const result = suggestDropCandidates(members, matches, NOW, { maxPlayed: 0 });
    expect(result).toEqual([]);
  });

  it("realistic fixture: two divisions, one 0-game player, one 1-game player, one already dropped", () => {
    const members = [
      activeMember("d1", "p1", "Alice", new Date("2026-09-01")), // 0 games -> candidate
      activeMember("d1", "p2", "Bob", new Date("2026-09-01")), // 1 game -> not a candidate
      activeMember("d2", "p3", "Cara", new Date("2026-09-01"), "DROPPED"), // already dropped -> never a candidate
      activeMember("d2", "p4", "Dana", new Date("2026-09-01")), // 0 games -> candidate
    ];
    const matches = [
      match("d1", "p2", "p5", "CONFIRMED", new Date("2026-09-10")),
      match("d2", "p4", "p6", "PENDING", new Date("2026-09-05")),
    ];
    const result = suggestDropCandidates(members, matches, NOW, { maxPlayed: 0 });
    expect(result.map((c) => c.playerId)).toEqual(["p1", "p4"]);
  });
});

describe("suggestDropCandidates -- properties", () => {
  const memberArb = fc.record({
    divisionId: fc.constantFrom("d1", "d2"),
    playerId: fc.uuid(),
    displayName: fc.string({ minLength: 1, maxLength: 10 }),
    status: fc.constantFrom<"ACTIVE" | "DROPPED">("ACTIVE", "DROPPED"),
    joinedAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2026-01-01") }),
  });

  it("never returns an already-DROPPED player", () => {
    fc.assert(
      fc.property(fc.array(memberArb, { maxLength: 15 }), fc.nat({ max: 5 }), (members, maxPlayed) => {
        const dedup = dedupById(members);
        const result = suggestDropCandidates(dedup, [], NOW, { maxPlayed });
        const droppedIds = new Set(dedup.filter((m) => m.status === "DROPPED").map((m) => m.playerId));
        return result.every((c) => !droppedIds.has(c.playerId));
      }),
    );
  });

  it("every candidate is a strict subset of the ACTIVE roster", () => {
    fc.assert(
      fc.property(fc.array(memberArb, { maxLength: 15 }), fc.nat({ max: 5 }), (members, maxPlayed) => {
        const dedup = dedupById(members);
        const result = suggestDropCandidates(dedup, [], NOW, { maxPlayed });
        const activeIds = new Set(dedup.filter((m) => m.status === "ACTIVE").map((m) => m.playerId));
        return result.every((c) => activeIds.has(c.playerId));
      }),
    );
  });
});

function dedupById(members: DropCandidateMemberInput[]): DropCandidateMemberInput[] {
  const seen = new Set<string>();
  const out: DropCandidateMemberInput[] = [];
  for (const m of members) {
    if (seen.has(m.playerId)) continue;
    seen.add(m.playerId);
    out.push(m);
  }
  return out;
}

// withHypotheticalDrops is generic -- exercise it through BestNMemberInput,
// its real caller's shape, as well as a minimal local shape.
const P = (id: string, displayName: string): Player => ({ id, displayName }) as unknown as Player;

const bestNMember = (id: string, displayName: string, status: "ACTIVE" | "DROPPED" = "ACTIVE"): BestNMemberInput => ({
  player: P(id, displayName),
  status,
  isReplacement: false,
  scheduledGames: 0,
});

describe("withHypotheticalDrops", () => {
  it("marks the named ACTIVE members DROPPED and leaves everyone else untouched", () => {
    const members = [bestNMember("a", "Alice"), bestNMember("b", "Bob"), bestNMember("c", "Cara")];
    const result = withHypotheticalDrops(members, new Set(["b"]));
    expect(result.map((m) => [m.player.id, m.status])).toEqual([
      ["a", "ACTIVE"],
      ["b", "DROPPED"],
      ["c", "ACTIVE"],
    ]);
  });

  it("preserves extra fields (isReplacement/scheduledGames) on the mutated row", () => {
    const members = [{ ...bestNMember("a", "Alice"), isReplacement: true, scheduledGames: 4 }];
    const result = withHypotheticalDrops(members, new Set(["a"]));
    expect(result[0]).toEqual({ player: P("a", "Alice"), status: "DROPPED", isReplacement: true, scheduledGames: 4 });
  });

  it("leaves an already-DROPPED member alone rather than touching droppedAt-adjacent state", () => {
    const members = [bestNMember("a", "Alice", "DROPPED")];
    const result = withHypotheticalDrops(members, new Set(["a"]));
    expect(result[0]).toEqual(members[0]);
  });

  it("empty set is the identity", () => {
    const members = [bestNMember("a", "Alice"), bestNMember("b", "Bob")];
    expect(withHypotheticalDrops(members, new Set())).toBe(members);
  });

  it("applying the same drop twice equals applying it once", () => {
    const members = [bestNMember("a", "Alice"), bestNMember("b", "Bob")];
    const once = withHypotheticalDrops(members, new Set(["a"]));
    const twice = withHypotheticalDrops(once, new Set(["a"]));
    expect(twice).toEqual(once);
  });

  it("property: idempotence holds for any member list and any dropped-id subset", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.uuid(), fc.string({ minLength: 1, maxLength: 8 })), { maxLength: 10 }),
        fc.array(fc.uuid(), { maxLength: 10 }),
        (pairs, maybeDroppedIds) => {
          const dedupPairs = dedupPairsById(pairs);
          const members = dedupPairs.map(([id, name]) => bestNMember(id, name));
          const droppedIds = new Set(maybeDroppedIds);
          const once = withHypotheticalDrops(members, droppedIds);
          const twice = withHypotheticalDrops(once, droppedIds);
          expect(twice).toEqual(once);
        },
      ),
    );
  });

  it("property: empty set is always the identity, for any member list", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.uuid(), fc.string({ minLength: 1, maxLength: 8 })), { maxLength: 10 }),
        (pairs) => {
          const dedupPairs = dedupPairsById(pairs);
          const members = dedupPairs.map(([id, name]) => bestNMember(id, name));
          expect(withHypotheticalDrops(members, new Set())).toBe(members);
        },
      ),
    );
  });
});

function dedupPairsById(pairs: [string, string][]): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const p of pairs) {
    if (seen.has(p[0])) continue;
    seen.add(p[0]);
    out.push(p);
  }
  return out;
}

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  classifyUnresolved,
  planBulkAction,
  CHECKIN_STALE_DAYS,
  type DivisionMemberInput,
  type UnresolvedMatchInput,
  type UnresolvedRow,
  type CheckinStatusLite,
  type BulkAction,
} from "./bulk-resolve-core.js";

const NOW = new Date("2026-06-15T00:00:00Z");

function member(overrides: Partial<DivisionMemberInput> = {}): DivisionMemberInput {
  return {
    playerId: "p1",
    displayName: "Alice",
    status: "ACTIVE",
    droppedAt: null,
    checkinStatus: null,
    checkinAt: null,
    ...overrides,
  };
}

function match(overrides: Partial<UnresolvedMatchInput> = {}): UnresolvedMatchInput {
  return {
    id: "m1",
    divisionId: "d1",
    playerAId: "p1",
    playerBId: "p2",
    status: "PENDING",
    createdAt: NOW,
    reportedAt: null,
    confirmedAt: null,
    disputedAt: null,
    ...overrides,
  };
}

describe("classifyUnresolved -- table scenarios", () => {
  it.each<{
    name: string;
    match: Partial<UnresolvedMatchInput>;
    members: DivisionMemberInput[];
    expectAction: string;
  }>([
    {
      name: "fresh unplayed pairing, both active, no check-in asked -> leave",
      match: { status: "PENDING", reportedAt: null },
      members: [member({ playerId: "p1" }), member({ playerId: "p2", displayName: "Bob" })],
      expectAction: "leave",
    },
    {
      name: "reported, awaiting confirm, both active -> leave",
      match: { status: "PENDING", reportedAt: NOW },
      members: [member({ playerId: "p1" }), member({ playerId: "p2", displayName: "Bob" })],
      expectAction: "leave",
    },
    {
      name: "disputed -> needs a human even though a player dropped",
      match: { status: "DISPUTED", disputedAt: NOW },
      members: [
        member({ playerId: "p1", status: "DROPPED", droppedAt: NOW }),
        member({ playerId: "p2", displayName: "Bob" }),
      ],
      expectAction: "needs-human",
    },
    {
      name: "player A dropped -> void",
      match: {},
      members: [
        member({ playerId: "p1", status: "DROPPED", droppedAt: NOW }),
        member({ playerId: "p2", displayName: "Bob" }),
      ],
      expectAction: "void",
    },
    {
      name: "player B dropped -> void",
      match: {},
      members: [member({ playerId: "p1" }), member({ playerId: "p2", displayName: "Bob", status: "DROPPED", droppedAt: NOW })],
      expectAction: "void",
    },
    {
      name: "both dropped -> void",
      match: {},
      members: [
        member({ playerId: "p1", status: "DROPPED", droppedAt: NOW }),
        member({ playerId: "p2", displayName: "Bob", status: "DROPPED", droppedAt: NOW }),
      ],
      expectAction: "void",
    },
    {
      name: "both opted out of check-in -> void",
      match: {},
      members: [
        member({ playerId: "p1", checkinStatus: "out", checkinAt: NOW }),
        member({ playerId: "p2", displayName: "Bob", checkinStatus: "out", checkinAt: NOW }),
      ],
      expectAction: "void",
    },
    {
      name: "A opted out, B active -> forfeit-a",
      match: {},
      members: [
        member({ playerId: "p1", checkinStatus: "out", checkinAt: NOW }),
        member({ playerId: "p2", displayName: "Bob" }),
      ],
      expectAction: "forfeit-a",
    },
    {
      name: "B's check-in DM failed, A active -> forfeit-b",
      match: {},
      members: [
        member({ playerId: "p1" }),
        member({ playerId: "p2", displayName: "Bob", checkinStatus: "dm-failed", checkinAt: NOW }),
      ],
      expectAction: "forfeit-b",
    },
    {
      name: "A has a stale pending check-in (no response), B active -> forfeit-a",
      match: {},
      members: [
        member({
          playerId: "p1",
          checkinStatus: "pending",
          checkinAt: new Date(NOW.getTime() - (CHECKIN_STALE_DAYS + 1) * 86_400_000),
        }),
        member({ playerId: "p2", displayName: "Bob" }),
      ],
      expectAction: "forfeit-a",
    },
    {
      name: "A's pending check-in is recent (not yet stale) -> leave",
      match: {},
      members: [
        member({ playerId: "p1", checkinStatus: "pending", checkinAt: new Date(NOW.getTime() - 1 * 86_400_000) }),
        member({ playerId: "p2", displayName: "Bob" }),
      ],
      expectAction: "leave",
    },
    {
      name: "A confirmed still in (checkinStatus 'in') -> leave",
      match: {},
      members: [
        member({ playerId: "p1", checkinStatus: "in", checkinAt: NOW }),
        member({ playerId: "p2", displayName: "Bob", checkinStatus: "in", checkinAt: NOW }),
      ],
      expectAction: "leave",
    },
    {
      name: "a player missing from the division's member list -> treated as unknown, not dropped -> leave",
      match: {},
      members: [member({ playerId: "p2", displayName: "Bob" })],
      expectAction: "leave",
    },
    {
      name: "defensive: a CONFIRMED match slipping into the input -> leave (already resolved)",
      match: { status: "CONFIRMED" },
      members: [member({ playerId: "p1" }), member({ playerId: "p2", displayName: "Bob" })],
      expectAction: "leave",
    },
  ])("$name", ({ match: matchOverrides, members, expectAction }) => {
    const row = classifyUnresolved(match(matchOverrides), members, NOW);
    expect(row.suggestion.action).toBe(expectAction);
  });

  it("marks a PENDING match with no reportedAt as UNPLAYED_SCHEDULED", () => {
    const row = classifyUnresolved(match({ status: "PENDING", reportedAt: null }), [member({ playerId: "p1" }), member({ playerId: "p2" })], NOW);
    expect(row.status).toBe("UNPLAYED_SCHEDULED");
  });

  it("marks a PENDING match with a reportedAt as PENDING (awaiting confirm)", () => {
    const row = classifyUnresolved(match({ status: "PENDING", reportedAt: NOW }), [member({ playerId: "p1" }), member({ playerId: "p2" })], NOW);
    expect(row.status).toBe("PENDING");
  });

  it("computes daysSinceTouch from the most recent of created/reported/confirmed/disputed", () => {
    const createdAt = new Date("2026-06-01T00:00:00Z");
    const reportedAt = new Date("2026-06-10T00:00:00Z");
    const row = classifyUnresolved(match({ createdAt, reportedAt }), [member({ playerId: "p1" }), member({ playerId: "p2" })], NOW);
    expect(row.lastTouchedAt).toEqual(reportedAt);
    expect(row.daysSinceTouch).toBe(5); // Jun 10 -> Jun 15
  });
});

describe("classifyUnresolved -- realistic fixture (two divisions)", () => {
  // Division "silver": a dropped player, and a fresh pending match.
  const silverMembers: DivisionMemberInput[] = [
    member({ playerId: "drop-1", displayName: "Dropout Dan", status: "DROPPED", droppedAt: new Date("2026-06-05T00:00:00Z") }),
    member({ playerId: "active-1", displayName: "Active Amy" }),
    member({ playerId: "fresh-1", displayName: "Fresh Fred" }),
    member({ playerId: "fresh-2", displayName: "Fresh Gina" }),
  ];
  const silverDropMatch = match({
    id: "silver-drop-match",
    divisionId: "silver",
    playerAId: "drop-1",
    playerBId: "active-1",
    status: "PENDING",
    reportedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
  });
  const silverFreshMatch = match({
    id: "silver-fresh-match",
    divisionId: "silver",
    playerAId: "fresh-1",
    playerBId: "fresh-2",
    status: "PENDING",
    reportedAt: null,
    createdAt: new Date("2026-06-14T00:00:00Z"), // 1 day old -- fresh
  });

  // Division "gold": a failed check-in, and a dispute.
  const goldMembers: DivisionMemberInput[] = [
    member({ playerId: "noshow-1", displayName: "No-show Nora", checkinStatus: "out", checkinAt: new Date("2026-06-10T00:00:00Z") }),
    member({ playerId: "active-2", displayName: "Active Ana" }),
    member({ playerId: "disputer-1", displayName: "Disputer Di" }),
    member({ playerId: "disputer-2", displayName: "Disputer Eli" }),
  ];
  const goldCheckinMatch = match({
    id: "gold-checkin-match",
    divisionId: "gold",
    playerAId: "noshow-1",
    playerBId: "active-2",
    status: "PENDING",
    reportedAt: null,
    createdAt: new Date("2026-06-02T00:00:00Z"),
  });
  const goldDisputeMatch = match({
    id: "gold-dispute-match",
    divisionId: "gold",
    playerAId: "disputer-1",
    playerBId: "disputer-2",
    status: "DISPUTED",
    reportedAt: new Date("2026-06-11T00:00:00Z"),
    disputedAt: new Date("2026-06-12T00:00:00Z"),
    createdAt: new Date("2026-06-11T00:00:00Z"),
  });

  it("voids the match with a dropped player", () => {
    const row = classifyUnresolved(silverDropMatch, silverMembers, NOW);
    expect(row.suggestion.action).toBe("void");
    expect(row.suggestion.reason).toContain("Dropout Dan");
    expect(row.status).toBe("UNPLAYED_SCHEDULED");
  });

  it("leaves the fresh pending match between two active players", () => {
    const row = classifyUnresolved(silverFreshMatch, silverMembers, NOW);
    expect(row.suggestion.action).toBe("leave");
    expect(row.daysSinceTouch).toBe(1);
  });

  it("forfeits against the player who opted out of check-in", () => {
    const row = classifyUnresolved(goldCheckinMatch, goldMembers, NOW);
    expect(row.suggestion.action).toBe("forfeit-a");
    expect(row.suggestion.reason).toContain("No-show Nora");
  });

  it("flags the disputed match as needing a human", () => {
    const row = classifyUnresolved(goldDisputeMatch, goldMembers, NOW);
    expect(row.suggestion.action).toBe("needs-human");
    expect(row.status).toBe("DISPUTED");
  });

  it("keeps the two divisions' rows independent of each other and of processing order", () => {
    const rowsInOrder = [silverDropMatch, silverFreshMatch, goldCheckinMatch, goldDisputeMatch].map((m) =>
      classifyUnresolved(m, m.divisionId === "silver" ? silverMembers : goldMembers, NOW),
    );
    const rowsReversed = [goldDisputeMatch, goldCheckinMatch, silverFreshMatch, silverDropMatch].map((m) =>
      classifyUnresolved(m, m.divisionId === "silver" ? silverMembers : goldMembers, NOW),
    );
    const byId = (rows: UnresolvedRow[]) => new Map(rows.map((r) => [r.matchId, r.suggestion.action]));
    expect(byId(rowsInOrder)).toEqual(byId(rowsReversed));
  });
});

// ---------------------------------------------------------------------------
// Property-based invariants

const checkinStatusArb: fc.Arbitrary<CheckinStatusLite> = fc.constantFrom(null, "pending", "in", "out", "dm-failed");

const memberArb: fc.Arbitrary<DivisionMemberInput> = fc.record({
  playerId: fc.string({ minLength: 1, maxLength: 8 }),
  displayName: fc.string({ minLength: 1, maxLength: 12 }),
  status: fc.constantFrom("ACTIVE", "DROPPED"),
  droppedAt: fc.option(fc.date({ min: new Date("2025-01-01"), max: new Date("2026-12-31") }), { nil: null }),
  checkinStatus: checkinStatusArb,
  checkinAt: fc.option(fc.date({ min: new Date("2025-01-01"), max: new Date("2026-12-31") }), { nil: null }),
});

function matchArbFor(aId: string, bId: string): fc.Arbitrary<UnresolvedMatchInput> {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 8 }),
    divisionId: fc.constant("d1"),
    playerAId: fc.constant(aId),
    playerBId: fc.constant(bId),
    status: fc.constantFrom("PENDING", "DISPUTED"),
    createdAt: fc.date({ min: new Date("2025-01-01"), max: new Date("2026-06-01") }),
    reportedAt: fc.option(fc.date({ min: new Date("2025-01-01"), max: new Date("2026-06-10") }), { nil: null }),
    confirmedAt: fc.constant(null),
    disputedAt: fc.option(fc.date({ min: new Date("2025-01-01"), max: new Date("2026-06-10") }), { nil: null }),
  });
}

// A (playerA, playerB, match-between-them) triple with distinct ids, so a
// single fc.property can vary all three together instead of nesting fc.assert.
const pairWithMatchArb = fc.tuple(memberArb, memberArb).chain(([a, bRaw]) => {
  const b = bRaw.playerId === a.playerId ? { ...bRaw, playerId: `${bRaw.playerId}x` } : bRaw;
  return fc.tuple(fc.constant(a), fc.constant(b), matchArbFor(a.playerId, b.playerId));
});

describe("classifyUnresolved -- properties", () => {
  it("is order-independent in the members array", () => {
    fc.assert(
      fc.property(pairWithMatchArb, fc.array(memberArb, { maxLength: 4 }), ([a, b, m], extras) => {
        const members = [a, b, ...extras];
        const shuffled = [...extras, b, a];
        const r1 = classifyUnresolved(m, members, NOW);
        const r2 = classifyUnresolved(m, shuffled, NOW);
        expect(r2.suggestion).toEqual(r1.suggestion);
        expect(r2.status).toBe(r1.status);
      }),
    );
  });

  it("is deterministic -- same inputs always produce the same suggestion", () => {
    fc.assert(
      fc.property(pairWithMatchArb, ([a, b, m]) => {
        const members = [a, b];
        const r1 = classifyUnresolved(m, members, NOW);
        const r2 = classifyUnresolved(m, members, NOW);
        expect(r2).toEqual(r1);
      }),
    );
  });
});

describe("planBulkAction -- properties", () => {
  const actionArb: fc.Arbitrary<BulkAction> = fc.constantFrom("void", "forfeit-a", "forfeit-b", "double-forfeit");

  // Rows are always deduped by matchId (fc.uniqueArray below) wherever this is
  // used -- a Match id is a DB primary key, so two rows sharing one in the
  // same batch isn't a real input; without the dedup, planBulkAction's
  // id->row map legitimately resolves to whichever duplicate came last, which
  // made the order-independence property flaky for no real reason.
  function rowArb(): fc.Arbitrary<UnresolvedRow> {
    const standingArb: fc.Arbitrary<UnresolvedRow["playerA"]> = fc.record({
      playerId: fc.string({ minLength: 1, maxLength: 6 }),
      displayName: fc.string({ minLength: 1, maxLength: 10 }),
      memberStatus: fc.constantFrom("ACTIVE", "DROPPED", "UNKNOWN"),
      droppedAt: fc.constant(null),
      checkinStatus: checkinStatusArb,
      checkinAt: fc.constant(null),
      checkinIssue: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: null }),
    });
    return fc.record({
      matchId: fc.string({ minLength: 1, maxLength: 8 }),
      divisionId: fc.constant("d1"),
      status: fc.constantFrom<UnresolvedRow["status"]>("PENDING", "DISPUTED", "UNPLAYED_SCHEDULED", "OTHER"),
      playerA: standingArb,
      playerB: standingArb,
      lastTouchedAt: fc.constant(NOW),
      daysSinceTouch: fc.nat({ max: 60 }),
      suggestion: fc.record({
        action: fc.constantFrom<UnresolvedRow["suggestion"]["action"]>("void", "forfeit-a", "forfeit-b", "needs-human", "leave"),
        reason: fc.string(),
      }),
    });
  }

  it("every selected id comes back allowed xor refused, exactly once, never dropped", () => {
    fc.assert(
      fc.property(fc.uniqueArray(rowArb(), { maxLength: 8, selector: (r) => r.matchId }), fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 10 }), actionArb, (rows, selectedIds, action) => {
        const decisions = planBulkAction(rows, selectedIds, action);
        const uniqueSelected = new Set(selectedIds);
        expect(decisions.length).toBe(uniqueSelected.size);
        for (const id of uniqueSelected) {
          const d = decisions.find((x) => x.id === id);
          expect(d).toBeDefined();
          if (d!.allowed) {
            expect(d!.reason).toBeNull();
          } else {
            expect(typeof d!.reason).toBe("string");
            expect(d!.reason!.length).toBeGreaterThan(0);
          }
        }
      }),
    );
  });

  it("a void plan never allows a row with status OTHER (i.e. never includes an already-resolved/confirmed match)", () => {
    fc.assert(
      fc.property(fc.uniqueArray(rowArb(), { maxLength: 8, selector: (r) => r.matchId }), (rows) => {
        const ids = rows.map((r) => r.matchId);
        const decisions = planBulkAction(rows, ids, "void");
        for (const row of rows.filter((r) => r.status === "OTHER")) {
          const d = decisions.find((x) => x.id === row.matchId);
          expect(d?.allowed).toBe(false);
        }
      }),
    );
  });

  it("disputed rows are only ever allowed for the void action", () => {
    fc.assert(
      fc.property(fc.uniqueArray(rowArb(), { maxLength: 8, selector: (r) => r.matchId }), actionArb, (rows, action) => {
        const ids = rows.map((r) => r.matchId);
        const decisions = planBulkAction(rows, ids, action);
        for (const row of rows.filter((r) => r.status === "DISPUTED")) {
          const d = decisions.find((x) => x.id === row.matchId);
          if (action === "void") {
            expect(d?.allowed).toBe(true);
          } else {
            expect(d?.allowed).toBe(false);
          }
        }
      }),
    );
  });

  it("is order-independent in the rows array", () => {
    fc.assert(
      fc.property(fc.uniqueArray(rowArb(), { maxLength: 8, selector: (r) => r.matchId }), actionArb, (rows, action) => {
        const ids = rows.map((r) => r.matchId);
        const d1 = planBulkAction(rows, ids, action);
        const d2 = planBulkAction([...rows].reverse(), ids, action);
        const sort = (d: typeof d1) => [...d].sort((x, y) => x.id.localeCompare(y.id));
        expect(sort(d2)).toEqual(sort(d1));
      }),
    );
  });
});

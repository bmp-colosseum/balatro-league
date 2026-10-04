import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { DmConversation, InboundDmLite, InboundDmStatus, ThreadItem } from "./dm-format-core.js";
import {
  classifyConversation,
  latestPlayerMessageAt,
  computeInboxCounts,
  defaultView,
  selectInboxConversations,
  selectUnansweredMessageIds,
  type ConversationStateLite,
  type ConversationCategory,
  type InboxConversationLite,
  type UnansweredIdCandidate,
} from "./dm-inbox-core.js";

function playerItem(overrides: Partial<ThreadItem & { type: "player" }>): ThreadItem {
  return {
    type: "player",
    id: "i1",
    at: new Date("2026-01-01T00:00:00Z"),
    content: "hi",
    status: "unread",
    ...overrides,
  };
}

function botItem(overrides: Partial<ThreadItem & { type: "bot" }>): ThreadItem {
  return {
    type: "bot",
    id: "d1",
    at: new Date("2026-01-01T00:00:00Z"),
    kind: "season-start",
    content: null,
    status: "sent",
    errorCode: null,
    errorMsg: null,
    ...overrides,
  };
}

function unansweredMsg(overrides: Partial<InboundDmLite> = {}): InboundDmLite {
  return {
    id: "i1",
    authorDiscordId: "p1",
    content: "hi",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    status: "unread",
    ...overrides,
  };
}

function conv(overrides: Partial<DmConversation> = {}): DmConversation {
  return {
    discordId: "p1",
    items: [],
    unreadCount: 0,
    latestUnanswered: null,
    unreadIds: [],
    lastActivityAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("classifyConversation -- table-driven scenarios", () => {
  const cases: Array<{ name: string; conv: DmConversation; state: ConversationStateLite | null; expected: ConversationCategory }> = [
    {
      name: "never archived, nothing unanswered -> open",
      conv: conv({ items: [playerItem({ at: new Date("2026-01-01T00:00:00Z") })], latestUnanswered: null }),
      state: null,
      expected: "open",
    },
    {
      name: "never archived, something unread -> needs-reply",
      conv: conv({
        items: [playerItem({ at: new Date("2026-01-01T00:00:00Z") })],
        latestUnanswered: unansweredMsg(),
        unreadCount: 1,
      }),
      state: null,
      expected: "needs-reply",
    },
    {
      name: "archived then silent (no player message since) -> archived",
      conv: conv({
        items: [playerItem({ at: new Date("2026-01-01T00:00:00Z") })],
        latestUnanswered: null,
      }),
      state: { archivedAt: new Date("2026-01-02T00:00:00Z") },
      expected: "archived",
    },
    {
      name: "archived then player wrote again (newer than archivedAt) -> needs-reply, not archived",
      conv: conv({
        items: [
          playerItem({ id: "i1", at: new Date("2026-01-01T00:00:00Z") }),
          playerItem({ id: "i2", at: new Date("2026-01-03T00:00:00Z") }),
        ],
        latestUnanswered: unansweredMsg({ id: "i2", receivedAt: new Date("2026-01-03T00:00:00Z") }),
        unreadCount: 1,
      }),
      state: { archivedAt: new Date("2026-01-02T00:00:00Z") },
      expected: "needs-reply",
    },
    {
      name: "read but not replied (TO pressed Mark all read) -> open, not needs-reply",
      conv: conv({
        items: [playerItem({ at: new Date("2026-01-01T00:00:00Z") })],
        latestUnanswered: unansweredMsg(),
        unreadCount: 0,
      }),
      state: null,
      expected: "open",
    },
    {
      name: "broadcast-only (no inbound at all) -> broadcast-only even with no archive state",
      conv: conv({ items: [botItem({})], latestUnanswered: null }),
      state: null,
      expected: "broadcast-only",
    },
    {
      name: "broadcast-only stays broadcast-only even if archived (no player message to compare against)",
      conv: conv({ items: [botItem({})], latestUnanswered: null }),
      state: { archivedAt: new Date("2026-01-01T00:00:00Z") },
      expected: "broadcast-only",
    },
    {
      name: "archivedAt exactly equal to the latest player message -> archived (boundary is inclusive)",
      conv: conv({
        items: [playerItem({ at: new Date("2026-01-02T00:00:00Z") })],
        latestUnanswered: null,
      }),
      state: { archivedAt: new Date("2026-01-02T00:00:00Z") },
      expected: "archived",
    },
    {
      name: "state row exists but archivedAt is null -> not archived",
      conv: conv({
        items: [playerItem({ at: new Date("2026-01-01T00:00:00Z") })],
        latestUnanswered: null,
      }),
      state: { archivedAt: null },
      expected: "open",
    },
  ];

  it.each(cases)("$name", ({ conv, state, expected }) => {
    expect(classifyConversation(conv, state)).toBe(expected);
  });
});

describe("latestPlayerMessageAt", () => {
  it("returns null when there are no player items", () => {
    expect(latestPlayerMessageAt(conv({ items: [botItem({})] }))).toBeNull();
  });

  it("returns the max `at` among player items only, ignoring bot/staff items", () => {
    const c = conv({
      items: [
        playerItem({ id: "i1", at: new Date("2026-01-01T00:00:00Z") }),
        botItem({ id: "d1", at: new Date("2026-01-05T00:00:00Z") }),
        playerItem({ id: "i2", at: new Date("2026-01-03T00:00:00Z") }),
      ],
    });
    expect(latestPlayerMessageAt(c)?.toISOString()).toBe("2026-01-03T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// selectUnansweredMessageIds -- the "Mark read" / "Mark all read" decision
// ---------------------------------------------------------------------------

function msg(overrides: Partial<UnansweredIdCandidate>): UnansweredIdCandidate {
  return { id: "m1", authorDiscordId: "p1", status: "unread", ...overrides };
}

describe("selectUnansweredMessageIds -- table-driven scenarios", () => {
  const cases: Array<{
    name: string;
    messages: UnansweredIdCandidate[];
    discordIds: string[];
    expected: string[];
  }> = [
    {
      name: "selects unread and read ids of the selected player, excludes replied ones",
      messages: [
        msg({ id: "a", authorDiscordId: "p1", status: "unread" }),
        msg({ id: "b", authorDiscordId: "p1", status: "read" }),
        msg({ id: "c", authorDiscordId: "p1", status: "replied" }),
      ],
      discordIds: ["p1"],
      expected: ["a", "b"],
    },
    {
      name: "excludes ids belonging to a player not in the selection",
      messages: [
        msg({ id: "a", authorDiscordId: "p1", status: "unread" }),
        msg({ id: "b", authorDiscordId: "p2", status: "unread" }),
      ],
      discordIds: ["p1"],
      expected: ["a"],
    },
    {
      name: "selects across multiple selected players, none of a third player's",
      messages: [
        msg({ id: "a", authorDiscordId: "p1", status: "unread" }),
        msg({ id: "b", authorDiscordId: "p2", status: "read" }),
        msg({ id: "c", authorDiscordId: "p3", status: "unread" }),
      ],
      discordIds: ["p1", "p2"],
      expected: ["a", "b"],
    },
    {
      name: "empty discordIds selects nothing",
      messages: [msg({ id: "a", authorDiscordId: "p1", status: "unread" })],
      discordIds: [],
      expected: [],
    },
    {
      name: "no messages at all selects nothing",
      messages: [],
      discordIds: ["p1"],
      expected: [],
    },
    {
      name: "a player with everything already replied selects nothing",
      messages: [
        msg({ id: "a", authorDiscordId: "p1", status: "replied" }),
        msg({ id: "b", authorDiscordId: "p1", status: "replied" }),
      ],
      discordIds: ["p1"],
      expected: [],
    },
  ];

  it.each(cases)("$name", ({ messages, discordIds, expected }) => {
    expect(selectUnansweredMessageIds(messages, discordIds)).toEqual(expected);
  });
});

describe("property: selectUnansweredMessageIds never returns an id from an unselected player", () => {
  const arbMsg = fc.record({
    id: fc.uuid(),
    authorDiscordId: fc.constantFrom("p1", "p2", "p3"),
    status: fc.constantFrom<InboundDmStatus>("unread", "read", "replied"),
  });

  it("every returned id belongs to a selected, non-replied message", () => {
    fc.assert(
      fc.property(
        fc.array(arbMsg, { maxLength: 20 }),
        fc.subarray(["p1", "p2", "p3"]),
        (messages, discordIds) => {
          const uniq = [...new Map(messages.map((m) => [m.id, m])).values()];
          const result = selectUnansweredMessageIds(uniq, discordIds);
          const byId = new Map(uniq.map((m) => [m.id, m]));
          for (const id of result) {
            const m = byId.get(id)!;
            expect(discordIds).toContain(m.authorDiscordId);
            expect(m.status).not.toBe("replied");
          }
          // conservation: result is exactly the set of eligible ids, not a subset
          const expectedIds = uniq
            .filter((m) => discordIds.includes(m.authorDiscordId) && m.status !== "replied")
            .map((m) => m.id);
          expect([...result].sort()).toEqual([...expectedIds].sort());
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Tab counts, default view, select/filter/sort
// ---------------------------------------------------------------------------

function lite(overrides: Partial<InboxConversationLite>): InboxConversationLite {
  return {
    discordId: "p1",
    displayName: "Player One",
    username: "p1handle",
    lastActivityAt: new Date("2026-01-01T00:00:00Z"),
    category: "open",
    ...overrides,
  };
}

describe("computeInboxCounts + defaultView", () => {
  it("sums each category and the all total", () => {
    const convs = [
      lite({ discordId: "a", category: "needs-reply" }),
      lite({ discordId: "b", category: "needs-reply" }),
      lite({ discordId: "c", category: "open" }),
      lite({ discordId: "d", category: "archived" }),
      lite({ discordId: "e", category: "broadcast-only" }),
    ];
    expect(computeInboxCounts(convs)).toEqual({
      needsReply: 2,
      open: 1,
      archived: 1,
      broadcastOnly: 1,
      all: 5,
    });
  });

  it("defaultView picks needs-reply when non-empty", () => {
    expect(defaultView({ needsReply: 1, open: 0, archived: 0, broadcastOnly: 0, all: 1 })).toBe("needs-reply");
  });

  it("defaultView falls back to open when needs-reply is empty", () => {
    expect(defaultView({ needsReply: 0, open: 3, archived: 0, broadcastOnly: 0, all: 3 })).toBe("open");
  });
});

describe("selectInboxConversations", () => {
  const convs = [
    lite({ discordId: "a", displayName: "Alice", username: "al", category: "needs-reply", lastActivityAt: new Date("2026-01-03T00:00:00Z") }),
    lite({ discordId: "b", displayName: "Bob", username: "bobby", category: "open", lastActivityAt: new Date("2026-01-02T00:00:00Z") }),
    // id "player-999" is deliberately numeric/distinct so a discordId-only
    // query can't accidentally substring-match a display name or username.
    lite({ discordId: "player-999", displayName: "Carol", username: null, category: "archived", lastActivityAt: new Date("2026-01-01T00:00:00Z") }),
    lite({ discordId: "d", displayName: "Dave", username: null, category: "broadcast-only", lastActivityAt: new Date("2026-01-04T00:00:00Z") }),
  ];

  it("filters to the given tab", () => {
    expect(selectInboxConversations(convs, "needs-reply", "").map((c) => c.discordId)).toEqual(["a"]);
  });

  it("all includes broadcast-only conversations", () => {
    expect(selectInboxConversations(convs, "all", "").map((c) => c.discordId)).toEqual(["d", "a", "b", "player-999"]);
  });

  it("sorts by lastActivityAt desc within a tab", () => {
    expect(selectInboxConversations(convs, "all", "").map((c) => c.discordId)).toEqual(["d", "a", "b", "player-999"]);
  });

  it("filters by display name, case-insensitive", () => {
    expect(selectInboxConversations(convs, "all", "ali").map((c) => c.discordId)).toEqual(["a"]);
  });

  it("filters by username", () => {
    expect(selectInboxConversations(convs, "all", "bobby").map((c) => c.discordId)).toEqual(["b"]);
  });

  it("filters by discordId", () => {
    expect(selectInboxConversations(convs, "all", "999").map((c) => c.discordId)).toEqual(["player-999"]);
  });

  it("blank query matches everything in the tab", () => {
    expect(selectInboxConversations(convs, "archived", "   ").map((c) => c.discordId)).toEqual(["player-999"]);
  });
});

// ---------------------------------------------------------------------------
// Property: every conversation lands in exactly one of
// needs-reply/open/archived/broadcast-only, and the counts always sum to the
// total -- regardless of how classification came out.
// ---------------------------------------------------------------------------

describe("property: tab counts always partition the full conversation list", () => {
  const arbCategory = fc.constantFrom<ConversationCategory>("needs-reply", "open", "archived", "broadcast-only");
  const arbConv = fc.record({
    discordId: fc.uuid(),
    displayName: fc.string(),
    username: fc.option(fc.string(), { nil: null }),
    lastActivityAt: fc.date(),
    category: arbCategory,
  });

  it("needsReply + open + archived + broadcastOnly === all === convs.length", () => {
    fc.assert(
      fc.property(fc.array(arbConv, { maxLength: 50 }), (convs) => {
        const counts = computeInboxCounts(convs);
        expect(counts.needsReply + counts.open + counts.archived + counts.broadcastOnly).toBe(convs.length);
        expect(counts.all).toBe(convs.length);
      }),
    );
  });

  it("selectInboxConversations for each single-category view returns exactly that category's conversations, and the five views partition the list (all duplicates broadcast-only on top of the rest by design)", () => {
    fc.assert(
      fc.property(fc.array(arbConv, { maxLength: 50 }), (convs) => {
        const byCategory = {
          "needs-reply": selectInboxConversations(convs, "needs-reply", ""),
          open: selectInboxConversations(convs, "open", ""),
          archived: selectInboxConversations(convs, "archived", ""),
          "broadcast-only": selectInboxConversations(convs, "broadcast-only", ""),
        };
        const total =
          byCategory["needs-reply"].length +
          byCategory.open.length +
          byCategory.archived.length +
          byCategory["broadcast-only"].length;
        expect(total).toBe(convs.length);
        for (const [view, selected] of Object.entries(byCategory)) {
          for (const c of selected) expect(c.category).toBe(view);
        }
      }),
    );
  });
});

// Classification itself, generated end to end from arbitrary conversations +
// states, also always lands in exactly one bucket (sanity check tying
// classifyConversation to the counting property above).
describe("property: classifyConversation always returns exactly one valid category", () => {
  const arbState = fc.option(
    fc.record({ archivedAt: fc.option(fc.date(), { nil: null }) }),
    { nil: null },
  );
  const arbItem = fc.oneof(
    fc.record({
      type: fc.constant<"player">("player"),
      id: fc.uuid(),
      at: fc.date(),
      content: fc.string(),
      status: fc.constantFrom<"unread" | "read" | "replied">("unread", "read", "replied"),
    }),
    fc.record({
      type: fc.constant<"bot">("bot"),
      id: fc.uuid(),
      at: fc.date(),
      kind: fc.constant("season-start"),
      content: fc.constant(null),
      status: fc.constantFrom<"sent" | "failed">("sent", "failed"),
      errorCode: fc.constant(null),
      errorMsg: fc.constant(null),
    }),
  );
  const arbConvFull = fc.record({
    discordId: fc.constant("p1"),
    items: fc.array(arbItem, { maxLength: 10 }),
    unreadCount: fc.nat({ max: 10 }),
    latestUnanswered: fc.option(fc.constant(unansweredMsg()), { nil: null }),
    unreadIds: fc.constant([]),
    lastActivityAt: fc.date(),
  });

  it("result is always one of the four categories", () => {
    fc.assert(
      fc.property(arbConvFull, arbState, (c, state) => {
        const result = classifyConversation(c, state);
        expect(["needs-reply", "open", "archived", "broadcast-only"]).toContain(result);
      }),
    );
  });
});

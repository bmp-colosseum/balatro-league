import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  MESSAGES_TABS,
  isMessagesTab,
  defaultMessagesTab,
  resolveMessagesTab,
  sortConversationsUnreadFirst,
  countUnreadConversations,
  TRANSCRIPT_KINDS,
  isTranscriptKind,
  type MessagesTab,
  type UnreadSortable,
} from "./messages-page-core.js";

describe("isMessagesTab / defaultMessagesTab / resolveMessagesTab", () => {
  it.each([
    ["inbox", true],
    ["sent", true],
    ["failed", true],
    ["transcripts", true],
    ["archived", false],
    ["", false],
    [undefined, false],
  ] as const)("isMessagesTab(%s) -> %s", (value, expected) => {
    expect(isMessagesTab(value)).toBe(expected);
  });

  it("defaultMessagesTab is inbox", () => {
    expect(defaultMessagesTab()).toBe("inbox");
  });

  it.each([
    ["inbox", "inbox"],
    ["sent", "sent"],
    ["failed", "failed"],
    ["transcripts", "transcripts"],
    ["bogus", "inbox"],
    [undefined, "inbox"],
    ["", "inbox"],
  ] as const)("resolveMessagesTab(%s) -> %s", (value, expected) => {
    expect(resolveMessagesTab(value)).toBe(expected);
  });

  it("property: resolveMessagesTab always returns a value from MESSAGES_TABS", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (value) => {
        expect(MESSAGES_TABS).toContain(resolveMessagesTab(value));
      }),
    );
  });
});

function conv(overrides: Partial<UnreadSortable> = {}): UnreadSortable {
  return { unreadCount: 0, lastActivityAt: new Date("2026-01-01T00:00:00Z"), ...overrides };
}

describe("sortConversationsUnreadFirst -- table-driven scenarios", () => {
  it("unread conversations sort before read ones regardless of timestamp", () => {
    const older = { ...conv({ unreadCount: 1, lastActivityAt: new Date("2026-01-01T00:00:00Z") }), id: "unread-old" };
    const newer = { ...conv({ unreadCount: 0, lastActivityAt: new Date("2026-01-05T00:00:00Z") }), id: "read-new" };
    expect(sortConversationsUnreadFirst([newer, older]).map((c) => c.id)).toEqual(["unread-old", "read-new"]);
  });

  it("within the unread group, sorts by lastActivityAt desc", () => {
    const a = { ...conv({ unreadCount: 1, lastActivityAt: new Date("2026-01-01T00:00:00Z") }), id: "a" };
    const b = { ...conv({ unreadCount: 2, lastActivityAt: new Date("2026-01-03T00:00:00Z") }), id: "b" };
    expect(sortConversationsUnreadFirst([a, b]).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("within the read group, sorts by lastActivityAt desc", () => {
    const a = { ...conv({ unreadCount: 0, lastActivityAt: new Date("2026-01-01T00:00:00Z") }), id: "a" };
    const b = { ...conv({ unreadCount: 0, lastActivityAt: new Date("2026-01-03T00:00:00Z") }), id: "b" };
    expect(sortConversationsUnreadFirst([a, b]).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = [conv({ unreadCount: 0 }), conv({ unreadCount: 1 })];
    const copy = [...input];
    sortConversationsUnreadFirst(input);
    expect(input).toEqual(copy);
  });

  it("empty input returns empty output", () => {
    expect(sortConversationsUnreadFirst([])).toEqual([]);
  });
});

describe("property: sortConversationsUnreadFirst", () => {
  const arbConv = fc.record({
    id: fc.uuid(),
    unreadCount: fc.nat({ max: 5 }),
    lastActivityAt: fc.date(),
  });

  it("is a permutation (conservation) of the input", () => {
    fc.assert(
      fc.property(fc.array(arbConv, { maxLength: 30 }), (convs) => {
        const sorted = sortConversationsUnreadFirst(convs);
        expect(sorted.length).toBe(convs.length);
        expect([...sorted].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
          [...convs].sort((a, b) => a.id.localeCompare(b.id)),
        );
      }),
    );
  });

  it("every unread conversation precedes every read conversation", () => {
    fc.assert(
      fc.property(fc.array(arbConv, { maxLength: 30 }), (convs) => {
        const sorted = sortConversationsUnreadFirst(convs);
        const firstReadIndex = sorted.findIndex((c) => c.unreadCount === 0);
        if (firstReadIndex === -1) return; // all unread or all empty, nothing to check
        for (let i = firstReadIndex; i < sorted.length; i++) {
          expect(sorted[i].unreadCount).toBe(0);
        }
      }),
    );
  });

  it("is idempotent -- sorting twice gives the same result", () => {
    fc.assert(
      fc.property(fc.array(arbConv, { maxLength: 30 }), (convs) => {
        const once = sortConversationsUnreadFirst(convs);
        const twice = sortConversationsUnreadFirst(once);
        expect(twice).toEqual(once);
      }),
    );
  });
});

describe("countUnreadConversations", () => {
  it.each([
    { name: "empty list", convs: [], expected: 0 },
    { name: "all read", convs: [{ unreadCount: 0 }, { unreadCount: 0 }], expected: 0 },
    { name: "mixed", convs: [{ unreadCount: 2 }, { unreadCount: 0 }, { unreadCount: 3 }], expected: 5 },
  ])("$name -> $expected", ({ convs, expected }) => {
    expect(countUnreadConversations(convs)).toBe(expected);
  });

  it("property: sum conservation, order-independent", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ unreadCount: fc.nat({ max: 20 }) }), { maxLength: 30 }), (convs) => {
        const total = countUnreadConversations(convs);
        const shuffled = [...convs].reverse();
        expect(countUnreadConversations(shuffled)).toBe(total);
        expect(total).toBe(convs.reduce((s, c) => s + c.unreadCount, 0));
      }),
    );
  });
});

describe("isTranscriptKind", () => {
  it.each([
    ["match", true],
    ["dispute", true],
    ["support", true],
    ["season", false],
    ["", false],
    [undefined, false],
  ] as const)("isTranscriptKind(%s) -> %s", (value, expected) => {
    expect(isTranscriptKind(value)).toBe(expected);
  });

  it("TRANSCRIPT_KINDS contains exactly the three recognized kinds", () => {
    expect(TRANSCRIPT_KINDS).toEqual(["match", "dispute", "support"]);
  });
});

// Sanity: the tab union type stays in sync with the runtime list (compile-time
// check only -- if this line fails to typecheck, MESSAGES_TABS drifted from
// MessagesTab).
const _typeCheck: MessagesTab = MESSAGES_TABS[0];
void _typeCheck;

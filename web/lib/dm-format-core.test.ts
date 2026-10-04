import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  formatStaffReply,
  truncateQuote,
  pickStaffDisplayName,
  buildDmThread,
  type InboundDmLite,
  type DmDeliveryLite,
  type StaffMemberLite,
} from "./dm-format-core.js";

describe("truncateQuote", () => {
  it("collapses internal whitespace/newlines to single spaces", () => {
    expect(truncateQuote("hello\n\nworld   there")).toBe("hello world there");
  });

  it("leaves short text untouched", () => {
    expect(truncateQuote("gg wp")).toBe("gg wp");
  });

  it("truncates past 200 chars with an ellipsis", () => {
    const long = "x".repeat(250);
    const out = truncateQuote(long);
    expect(out).toBe(`${"x".repeat(200)}...`);
    expect(out.length).toBe(203);
  });
});

describe("formatStaffReply -- table-driven scenarios", () => {
  const cases: Array<{ name: string; input: Parameters<typeof formatStaffReply>[0]; expected: string }> = [
    {
      name: "quoted message + reply",
      input: { staffName: "Mod Amy", quoted: "when does the season start", reply: "This Friday!" },
      expected: "Mod Amy (league staff) replied:\n> when does the season start\n\nThis Friday!",
    },
    {
      name: "no quoted message (null)",
      input: { staffName: "Mod Amy", quoted: null, reply: "Sure, go ahead." },
      expected: "Mod Amy (league staff) replied:\n\nSure, go ahead.",
    },
    {
      name: "quoted message is whitespace-only -- treated as no quote",
      input: { staffName: "Owen", quoted: "   \n  ", reply: "ok" },
      expected: "Owen (league staff) replied:\n\nok",
    },
    {
      name: "quoted message with newlines gets collapsed to one line",
      input: { staffName: "Owen", quoted: "line one\nline two", reply: "noted" },
      expected: "Owen (league staff) replied:\n> line one line two\n\nnoted",
    },
    {
      name: "long quoted message gets truncated",
      input: { staffName: "Owen", quoted: "a".repeat(250), reply: "ok" },
      expected: `Owen (league staff) replied:\n> ${"a".repeat(200)}...\n\nok`,
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(formatStaffReply(input)).toBe(expected);
  });
});

describe("pickStaffDisplayName", () => {
  const member = (overrides: Partial<StaffMemberLite>): StaffMemberLite => ({
    nickname: null,
    globalName: null,
    username: null,
    ...overrides,
  });

  it("prefers nickname", () => {
    expect(
      pickStaffDisplayName(member({ nickname: "Nicky", globalName: "Global", username: "handle" }), "Fallback", "123"),
    ).toBe("Nicky");
  });

  it("falls back to globalName when no nickname", () => {
    expect(pickStaffDisplayName(member({ globalName: "Global", username: "handle" }), "Fallback", "123")).toBe(
      "Global",
    );
  });

  it("falls back to username when no nickname/globalName", () => {
    expect(pickStaffDisplayName(member({ username: "handle" }), "Fallback", "123")).toBe("handle");
  });

  it("falls back to the session user's name when there's no GuildMember row", () => {
    expect(pickStaffDisplayName(null, "Fallback", "123")).toBe("Fallback");
  });

  it("falls back to the raw discordId as a last resort", () => {
    expect(pickStaffDisplayName(null, null, "123")).toBe("123");
    expect(pickStaffDisplayName(member({}), undefined, "123")).toBe("123");
  });
});

// ---------------------------------------------------------------------------
// buildDmThread
// ---------------------------------------------------------------------------

function inboundMsg(overrides: Partial<InboundDmLite>): InboundDmLite {
  return {
    id: "i1",
    authorDiscordId: "p1",
    content: "hi",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    status: "unread",
    ...overrides,
  };
}

function delivery(overrides: Partial<DmDeliveryLite>): DmDeliveryLite {
  return {
    id: "d1",
    discordId: "p1",
    status: "sent",
    sentAt: new Date("2026-01-01T00:01:00Z"),
    content: "hello",
    kind: "staff-reply",
    senderName: "Mod Amy",
    inReplyToInboundDmId: null,
    errorCode: null,
    errorMsg: null,
    ...overrides,
  };
}

describe("buildDmThread -- ordering + interleaving", () => {
  it("interleaves player/staff/bot items in time order within one conversation", () => {
    const inbound = [
      inboundMsg({ id: "i1", receivedAt: new Date("2026-01-01T00:00:00Z"), status: "replied" }),
      inboundMsg({ id: "i2", receivedAt: new Date("2026-01-01T00:10:00Z"), status: "unread" }),
    ];
    const deliveries = [
      delivery({ id: "d1", kind: "staff-reply", sentAt: new Date("2026-01-01T00:05:00Z"), inReplyToInboundDmId: "i1" }),
      delivery({ id: "d2", kind: "season-start", senderName: null, sentAt: new Date("2026-01-01T00:20:00Z") }),
    ];
    const [conv] = buildDmThread(inbound, deliveries);
    expect(conv!.items.map((it) => it.id)).toEqual(["i1", "d1", "i2", "d2"]);
    expect(conv!.items.map((it) => it.type)).toEqual(["player", "staff", "player", "bot"]);
  });

  it("groups by discordId into separate conversations, newest activity first", () => {
    const inbound = [
      inboundMsg({ id: "i1", authorDiscordId: "p1", receivedAt: new Date("2026-01-01T00:00:00Z") }),
      inboundMsg({ id: "i2", authorDiscordId: "p2", receivedAt: new Date("2026-01-02T00:00:00Z") }),
    ];
    const convs = buildDmThread(inbound, []);
    expect(convs.map((c) => c.discordId)).toEqual(["p2", "p1"]);
  });

  it("a player with only outbound deliveries (never messaged the bot) still gets a conversation", () => {
    const convs = buildDmThread([], [delivery({ discordId: "p9", kind: "season-start", senderName: null })]);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.discordId).toBe("p9");
    expect(convs[0]!.items[0]!.type).toBe("bot");
  });
});

describe("buildDmThread -- unread counts + latest unanswered", () => {
  it("counts only status=unread toward unreadCount, but includes read in unansweredIds", () => {
    const inbound = [
      inboundMsg({ id: "i1", receivedAt: new Date("2026-01-01T00:00:00Z"), status: "unread" }),
      inboundMsg({ id: "i2", receivedAt: new Date("2026-01-01T01:00:00Z"), status: "read" }),
      inboundMsg({ id: "i3", receivedAt: new Date("2026-01-01T02:00:00Z"), status: "replied" }),
    ];
    const [conv] = buildDmThread(inbound, []);
    expect(conv!.unreadCount).toBe(1);
    expect(conv!.unreadIds.sort()).toEqual(["i1", "i2"]);
  });

  it("latestUnanswered is the most recent non-replied message", () => {
    const inbound = [
      inboundMsg({ id: "i1", receivedAt: new Date("2026-01-01T00:00:00Z"), status: "read" }),
      inboundMsg({ id: "i2", receivedAt: new Date("2026-01-01T02:00:00Z"), status: "unread" }),
      inboundMsg({ id: "i3", receivedAt: new Date("2026-01-01T01:00:00Z"), status: "unread" }),
    ];
    const [conv] = buildDmThread(inbound, []);
    expect(conv!.latestUnanswered?.id).toBe("i2");
  });

  it("latestUnanswered is null once everything is replied", () => {
    const inbound = [inboundMsg({ id: "i1", status: "replied" })];
    const [conv] = buildDmThread(inbound, []);
    expect(conv!.latestUnanswered).toBeNull();
    expect(conv!.unreadIds).toEqual([]);
  });
});

describe("buildDmThread -- delivery rendering", () => {
  it("a staff-reply delivery links to its inbound message via inReplyToInboundDmId", () => {
    const inbound = [inboundMsg({ id: "i1", status: "replied" })];
    const deliveries = [delivery({ id: "d1", inReplyToInboundDmId: "i1" })];
    const [conv] = buildDmThread(inbound, deliveries);
    const staffItem = conv!.items.find((it) => it.type === "staff");
    expect(staffItem && staffItem.type === "staff" && staffItem.inReplyToInboundDmId).toBe("i1");
  });

  it("a failed delivery renders with status failed and its error fields", () => {
    const deliveries = [
      delivery({ id: "d1", kind: "roster-checkin", senderName: null, status: "failed", errorCode: 50007, errorMsg: "DMs closed" }),
    ];
    const [conv] = buildDmThread([], deliveries);
    const item = conv!.items[0]!;
    expect(item.type).toBe("bot");
    expect(item.status).toBe("failed");
    if (item.type === "bot") {
      expect(item.errorCode).toBe(50007);
      expect(item.errorMsg).toBe("DMs closed");
    }
  });

  it("a non-staff-reply kind renders as a bot item labeled by kind", () => {
    const deliveries = [delivery({ kind: "signup-ask", senderName: null })];
    const [conv] = buildDmThread([], deliveries);
    expect(conv!.items[0]!.type).toBe("bot");
    expect((conv!.items[0] as { kind: string }).kind).toBe("signup-ask");
  });

  it("a staff-reply with no senderName falls back to a generic label", () => {
    const deliveries = [delivery({ senderName: null })];
    const [conv] = buildDmThread([], deliveries);
    const item = conv!.items[0]!;
    expect(item.type === "staff" && item.staffName).toBe("league staff");
  });
});

describe("buildDmThread -- property: every input row appears exactly once", () => {
  const arbInbound = fc.array(
    fc.record({
      id: fc.uuid(),
      authorDiscordId: fc.constantFrom("p1", "p2", "p3"),
      content: fc.string(),
      receivedAt: fc.date({ min: new Date("2025-01-01"), max: new Date("2027-01-01") }),
      status: fc.constantFrom<InboundDmLite["status"]>("unread", "read", "replied"),
    }),
    { maxLength: 15 },
  );
  const arbDelivery = fc.array(
    fc.record({
      id: fc.uuid(),
      discordId: fc.constantFrom("p1", "p2", "p3"),
      status: fc.constantFrom<DmDeliveryLite["status"]>("sent", "failed"),
      sentAt: fc.date({ min: new Date("2025-01-01"), max: new Date("2027-01-01") }),
      content: fc.option(fc.string(), { nil: null }),
      kind: fc.option(fc.constantFrom("staff-reply", "signup-ask", "season-start"), { nil: null }),
      senderName: fc.option(fc.string(), { nil: null }),
      inReplyToInboundDmId: fc.constant(null),
      errorCode: fc.constant(null),
      errorMsg: fc.constant(null),
    }),
    { maxLength: 15 },
  );

  it("conservation: output item count equals input row count; ordering is non-decreasing by time within a conversation", () => {
    fc.assert(
      fc.property(arbInbound, arbDelivery, (inbound, deliveries) => {
        // dedupe ids within each list so "exactly once" is well-defined
        const uniqInbound = [...new Map(inbound.map((m) => [m.id, m])).values()];
        const uniqDeliveries = [...new Map(deliveries.map((d) => [d.id, d])).values()];

        const convs = buildDmThread(uniqInbound, uniqDeliveries);
        const totalItems = convs.reduce((n, c) => n + c.items.length, 0);
        expect(totalItems).toBe(uniqInbound.length + uniqDeliveries.length);

        for (const conv of convs) {
          for (let i = 1; i < conv.items.length; i++) {
            expect(conv.items[i]!.at.getTime()).toBeGreaterThanOrEqual(conv.items[i - 1]!.at.getTime());
          }
          // conversations are sorted newest-activity-first
        }
        for (let i = 1; i < convs.length; i++) {
          expect(convs[i - 1]!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(convs[i]!.lastActivityAt.getTime());
        }
      }),
    );
  });
});

describe("buildDmThread: replies recorded before deliveries carried content", () => {
  const base = { authorDiscordId: "p1", content: "hello?", receivedAt: new Date("2026-09-01T10:00:00Z") };
  it("synthesises a staff item from replyText when no staff delivery is linked", () => {
    const [conv] = buildDmThread(
      [{ ...base, id: "m1", status: "replied", replyText: "Fixed, sorry!", repliedAt: new Date("2026-09-01T11:00:00Z"), repliedByName: "MJ" }],
      [],
    );
    expect(conv.items.map((i) => i.type)).toEqual(["player", "staff"]);
    const staff = conv.items[1];
    expect(staff.type === "staff" && staff.staffName).toBe("MJ");
    expect(staff.type === "staff" && staff.content).toBe("Fixed, sorry!");
    expect(staff.type === "staff" && staff.inReplyToInboundDmId).toBe("m1");
  });
  it("does not duplicate a reply that already has a linked staff delivery", () => {
    const [conv] = buildDmThread(
      [{ ...base, id: "m1", status: "replied", replyText: "Fixed, sorry!", repliedAt: new Date("2026-09-01T11:00:00Z"), repliedByName: "MJ" }],
      [{ id: "d1", discordId: "p1", status: "sent", sentAt: new Date("2026-09-01T11:00:00Z"), content: "MJ (league staff) replied: > hello? Fixed, sorry!", kind: "staff-reply", senderName: "MJ", inReplyToInboundDmId: "m1", errorCode: null, errorMsg: null }],
    );
    expect(conv.items.filter((i) => i.type === "staff")).toHaveLength(1);
    expect(conv.items.find((i) => i.type === "staff")?.id).toBe("d1");
  });
});

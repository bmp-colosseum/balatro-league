import { describe, it, expect } from "vitest";
import {
  BOT_COMMANDS_STICKY_ID,
  buildBotCommandsStickyMessage,
  buildStickyActionsMessage,
  shouldRepostSticky,
  stickyConfigKey,
  STICKY_LULL_MS,
  STICKY_MIN_INTERVAL_MS,
  STICKY_MIN_NEW_MESSAGES,
  type StickyChannelState,
} from "./sticky-actions.js";

// Base "everything says go" state -- each test flips exactly one field to
// prove that gate (and only that gate) blocks a repost.
const NOW = 1_000_000_000;
function baseState(overrides: Partial<StickyChannelState> = {}): StickyChannelState {
  return {
    lastPostAt: NOW - STICKY_MIN_INTERVAL_MS - 1,
    newMessagesSincePost: STICKY_MIN_NEW_MESSAGES,
    lastMessageAt: NOW - STICKY_LULL_MS - 1,
    stickyIsNotLastMessage: true,
    ...overrides,
  };
}

describe("shouldRepostSticky -- throttle gates", () => {
  it("reposts when every gate passes", () => {
    expect(shouldRepostSticky(baseState(), NOW)).toBe(true);
  });

  it("never posted yet (lastPostAt null) still requires the other gates", () => {
    expect(shouldRepostSticky(baseState({ lastPostAt: null }), NOW)).toBe(true);
  });

  describe("min-interval gate", () => {
    it("blocks when the last repost was less than STICKY_MIN_INTERVAL_MS ago", () => {
      const state = baseState({ lastPostAt: NOW - STICKY_MIN_INTERVAL_MS + 1 });
      expect(shouldRepostSticky(state, NOW)).toBe(false);
    });

    it("allows exactly at the STICKY_MIN_INTERVAL_MS boundary", () => {
      const state = baseState({ lastPostAt: NOW - STICKY_MIN_INTERVAL_MS });
      expect(shouldRepostSticky(state, NOW)).toBe(true);
    });
  });

  describe("min-new-messages gate", () => {
    it("blocks with 0 new messages", () => {
      expect(shouldRepostSticky(baseState({ newMessagesSincePost: 0 }), NOW)).toBe(false);
    });

    it("blocks with 1 new message", () => {
      expect(shouldRepostSticky(baseState({ newMessagesSincePost: 1 }), NOW)).toBe(false);
    });

    it("blocks with 2 new messages (one short of the threshold)", () => {
      expect(shouldRepostSticky(baseState({ newMessagesSincePost: STICKY_MIN_NEW_MESSAGES - 1 }), NOW)).toBe(false);
    });

    it("allows at exactly STICKY_MIN_NEW_MESSAGES", () => {
      expect(shouldRepostSticky(baseState({ newMessagesSincePost: STICKY_MIN_NEW_MESSAGES }), NOW)).toBe(true);
    });

    it("allows with more than the threshold", () => {
      expect(shouldRepostSticky(baseState({ newMessagesSincePost: STICKY_MIN_NEW_MESSAGES + 50 }), NOW)).toBe(true);
    });
  });

  describe("lull gate -- the core 'don't interrupt a conversation' rule", () => {
    it("blocks when the last message was less than STICKY_LULL_MS ago (active conversation)", () => {
      const state = baseState({ lastMessageAt: NOW - STICKY_LULL_MS + 1 });
      expect(shouldRepostSticky(state, NOW)).toBe(false);
    });

    it("blocks when a message just happened (0ms ago)", () => {
      const state = baseState({ lastMessageAt: NOW });
      expect(shouldRepostSticky(state, NOW)).toBe(false);
    });

    it("allows exactly at the STICKY_LULL_MS boundary", () => {
      const state = baseState({ lastMessageAt: NOW - STICKY_LULL_MS });
      expect(shouldRepostSticky(state, NOW)).toBe(true);
    });

    it("blocks when there's no message activity at all (lastMessageAt null)", () => {
      expect(shouldRepostSticky(baseState({ lastMessageAt: null }), NOW)).toBe(false);
    });
  });

  describe("sticky-is-not-last-message gate", () => {
    it("blocks when the sticky is already the last message in the channel", () => {
      expect(shouldRepostSticky(baseState({ stickyIsNotLastMessage: false }), NOW)).toBe(false);
    });
  });

  describe("combined -- realistic scenarios", () => {
    it("a burst of 10 messages followed immediately by a repost check still waits for the lull", () => {
      const state = baseState({ newMessagesSincePost: 10, lastMessageAt: NOW - 1000 });
      expect(shouldRepostSticky(state, NOW)).toBe(false);
    });

    it("plenty of time + a lull, but too few messages, still blocks", () => {
      const state = baseState({
        newMessagesSincePost: 1,
        lastPostAt: NOW - STICKY_MIN_INTERVAL_MS * 5,
        lastMessageAt: NOW - STICKY_LULL_MS * 5,
      });
      expect(shouldRepostSticky(state, NOW)).toBe(false);
    });

    it("a fresh division with no prior post (bootstrap-ish state) still needs real activity to trigger a bump", () => {
      const state: StickyChannelState = {
        lastPostAt: null,
        newMessagesSincePost: 0,
        lastMessageAt: null,
        stickyIsNotLastMessage: true,
      };
      expect(shouldRepostSticky(state, NOW)).toBe(false);
    });
  });
});

// The gating decision (shouldRepostSticky) takes no divisionId/stickyId at
// all -- it's a plain StickyChannelState -> boolean function. Generalizing
// the sticky to also manage the bot-commands channel means BOTH targets run
// through this exact same function with no branching by kind, so every gate
// test above already covers the bot-commands sticky too. What's new below is
// proving (a) the key derivation is generic/collision-safe and (b) the
// bot-commands sticky's own gates behave identically to a division's, using
// the same base-state fixture.
describe("generalized sticky keying -- stickyId instead of divisionId", () => {
  it("keys a division sticky exactly as before: sticky_actions_msg:<divisionId>", () => {
    expect(stickyConfigKey("clxdivision123")).toBe("sticky_actions_msg:clxdivision123");
  });

  it("keys the bot-commands sticky under a distinct, non-cuid raw key", () => {
    expect(stickyConfigKey(BOT_COMMANDS_STICKY_ID)).toBe("sticky_actions_msg:bot-commands");
  });

  it("the two key spaces never collide for realistic ids", () => {
    const divisionKey = stickyConfigKey("some-division-cuid");
    const botCommandsKey = stickyConfigKey(BOT_COMMANDS_STICKY_ID);
    expect(divisionKey).not.toBe(botCommandsKey);
  });
});

describe("bot-commands sticky obeys the exact same throttle gates as a division sticky", () => {
  it("reposts when every gate passes -- same as a division sticky", () => {
    expect(shouldRepostSticky(baseState(), NOW)).toBe(true);
  });

  it("does not repost inside the min-interval cooldown", () => {
    const state = baseState({ lastPostAt: NOW - STICKY_MIN_INTERVAL_MS + 1 });
    expect(shouldRepostSticky(state, NOW)).toBe(false);
  });

  it("requires STICKY_MIN_NEW_MESSAGES new messages before considering a repost", () => {
    const state = baseState({ newMessagesSincePost: STICKY_MIN_NEW_MESSAGES - 1 });
    expect(shouldRepostSticky(state, NOW)).toBe(false);
  });

  it("waits for a lull -- won't interrupt an active #bot-commands conversation", () => {
    const state = baseState({ lastMessageAt: NOW - 1000 });
    expect(shouldRepostSticky(state, NOW)).toBe(false);
  });
});

describe("buildBotCommandsStickyMessage -- the quick-roll sticky payload", () => {
  it("carries the four random: buttons and pings nobody", () => {
    const msg = buildBotCommandsStickyMessage();
    expect(msg.allowedMentions).toEqual({ parse: [] });
    expect(msg.components).toHaveLength(1);
    const row = msg.components?.[0] as unknown as { components: Array<{ toJSON(): { custom_id?: string } }> };
    const customIds = row.components.map((b) => b.toJSON().custom_id);
    expect(customIds).toEqual(["random:deck", "random:stake", "random:combo", "random:bans"]);
  });

  it("is short -- a repost must never read as spammy", () => {
    const msg = buildBotCommandsStickyMessage();
    expect(typeof msg.content).toBe("string");
    expect((msg.content as string).length).toBeLessThan(200);
  });
});

describe("buildStickyActionsMessage -- division sticky payload stays unchanged", () => {
  it("still pings nobody and renders the player action rows", () => {
    const msg = buildStickyActionsMessage(["Some timeline line"]);
    expect(msg.allowedMentions).toEqual({ parse: [] });
    expect(msg.content).toContain("Some timeline line");
    expect(msg.content).toContain("**Quick actions**");
    expect(msg.components?.length).toBeGreaterThan(0);
  });
});

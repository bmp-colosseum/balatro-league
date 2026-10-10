import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildOnboardingGuideMessages,
  up,
  down,
  ONBOARDING_GUIDE_MAX_MESSAGE_LENGTH,
  type OnboardingGuideInput,
} from "./onboarding-guide.js";

function input(overrides: Partial<OnboardingGuideInput> = {}): OnboardingGuideInput {
  return {
    seasonLabel: "Season 7",
    seasonWindowLines: [],
    standingsUrl: "https://balatroleague.com/standings",
    supportChannelUrl: null,
    ...overrides,
  };
}

describe("up / down (promote/relegate agreement)", () => {
  it.each<{ n: number; up: string; down: string }>([
    { n: 1, up: "the top finisher moves up", down: "last place moves down" },
    { n: 2, up: "the top 2 finishers move up", down: "the bottom 2 move down" },
    { n: 3, up: "the top 3 finishers move up", down: "the bottom 3 move down" },
  ])("n=$n", ({ n, up: expectedUp, down: expectedDown }) => {
    expect(up(n)).toBe(expectedUp);
    expect(down(n)).toBe(expectedDown);
  });
});

describe("buildOnboardingGuideMessages", () => {
  it("returns exactly 3 messages", () => {
    expect(buildOnboardingGuideMessages(input())).toHaveLength(3);
  });

  it("every message stays under Discord's 2000-char limit", () => {
    for (const msg of buildOnboardingGuideMessages(input())) {
      expect(msg.length).toBeLessThan(ONBOARDING_GUIDE_MAX_MESSAGE_LENGTH);
    }
  });

  it("includes the season label and falls back to a generic dates line when seasonWindowLines is empty", () => {
    const [msg1] = buildOnboardingGuideMessages(input({ seasonLabel: "Season 7 -- Launch", seasonWindowLines: [] }));
    expect(msg1).toContain("Season 7 -- Launch");
    expect(msg1).toContain("Check the pinned message in #league-info for the exact dates.");
  });

  it("uses the real season window lines when given instead of the fallback", () => {
    const [msg1] = buildOnboardingGuideMessages(
      input({ seasonWindowLines: ["Started <t:1700000000:F>", "Ends <t:1710000000:F> (<t:1710000000:R>)"] }),
    );
    expect(msg1).toContain("Started <t:1700000000:F>");
    expect(msg1).toContain("Ends <t:1710000000:F>");
    expect(msg1).not.toContain("Check the pinned message");
  });

  it("includes the standings url", () => {
    const [, msg2] = buildOnboardingGuideMessages(input({ standingsUrl: "https://example.test/standings" }));
    expect(msg2).toContain("<https://example.test/standings>");
  });

  it("omits the support-channel mention when supportChannelUrl is null", () => {
    const [, , msg3] = buildOnboardingGuideMessages(input({ supportChannelUrl: null }));
    expect(msg3).toContain("Click **Help** at the bottom of your division channel, or DM **Chrono**, who runs the league. Good luck out there!");
    expect(msg3).not.toContain("league-support");
  });

  it("includes the support-channel jump link when provided", () => {
    const [, , msg3] = buildOnboardingGuideMessages(
      input({ supportChannelUrl: "https://discord.com/channels/1/2" }),
    );
    expect(msg3).toContain("#league-support (<https://discord.com/channels/1/2>)");
  });

  it("states both promotion/relegation brackets using the up()/down() wording", () => {
    const [, , msg3] = buildOnboardingGuideMessages(input());
    expect(msg3).toContain("the top finisher moves up");
    expect(msg3).toContain("last place moves down");
    expect(msg3).toContain("the top 2 finishers move up");
    expect(msg3).toContain("the bottom 2 move down");
  });

  it("property: every message stays under the Discord limit for arbitrary (reasonable) inputs", () => {
    fc.assert(
      fc.property(
        fc.record({
          seasonLabel: fc.string({ minLength: 1, maxLength: 40 }),
          seasonWindowLines: fc.array(fc.string({ maxLength: 120 }), { maxLength: 3 }),
          standingsUrl: fc.webUrl(),
          supportChannelUrl: fc.option(fc.webUrl(), { nil: null }),
        }),
        (i) => {
          const messages = buildOnboardingGuideMessages(i);
          expect(messages).toHaveLength(3);
          for (const msg of messages) {
            expect(msg.length).toBeLessThan(ONBOARDING_GUIDE_MAX_MESSAGE_LENGTH);
          }
        },
      ),
    );
  });
});

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildOnboardingGuideMessages,
  buildOnboardingGuideSections,
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
    expect(msg3).toContain("ask in the support channel (<https://discord.com/channels/1/2>)");
  });

  it("states both promotion/relegation brackets using the up()/down() wording", () => {
    const [, , msg3] = buildOnboardingGuideMessages(input());
    expect(msg3).toContain("the top finisher moves up");
    expect(msg3).toContain("last place moves down");
    expect(msg3).toContain("the top 2 finishers move up");
    expect(msg3).toContain("the bottom 2 move down");
  });

  // Locked to the exact output captured from the guide BEFORE it was
  // refactored into structured sections (buildOnboardingGuideSections) --
  // proves the refactor is byte-identical, not just "looks right". Any
  // intentional wording change must update this golden value deliberately.
  it("matches a byte-identical snapshot of the pre-refactor output", () => {
    const messages = buildOnboardingGuideMessages(
      input({
        seasonLabel: "Season 7 -- Launch",
        seasonWindowLines: ["Started <t:1700000000:F>", "Ends <t:1710000000:F> (<t:1710000000:R>)"],
        standingsUrl: "https://balatroleague.com/standings",
        supportChannelUrl: "https://discord.com/channels/111/222",
      }),
    );
    expect(messages).toEqual([
      "# \u{1F0CF} Welcome to the Balatro League!\nYou're new this season, so here's how it all works, start to finish.\n\n**The league runs in seasons.** You're playing in **Season 7 -- Launch** right now. Started <t:1700000000:F>. Ends <t:1710000000:F> (<t:1710000000:R>). A season usually runs about two weeks. Signups for the next one open about a week in and stay open until that next season starts, so keep an eye on #league-info.\n\n**Tiers and divisions.** Each season is split into tiers by skill, highest to lowest: **Legendary**, **Rare**, **Uncommon**, **Common**. Each tier is split into divisions (small groups) so you're playing people around your level. Your division channel's name tells you which one you're in.\n\n**Your schedule.** You're placed in one division with a set of assigned opponents -- not the whole server. The bot DMs you your matchups directly. If you lose track, click **Who do I play?** in your division channel any time; that's your reminder.",
      "**Playing a match.** When you're ready to play someone, click **Start a match** at the bottom of your division channel and pick your opponent. The bot runs the pick/ban phase for you. A match is **two games**, and the deck/stake combo never repeats within a matchup. After each game, the **winner records how many lives they had left** -- that number matters later for tiebreaks.\n\n**Results.** The bot records the result for you once the match is done -- nothing to report by hand.\n\n**Standings.** Full standings for every division: <https://balatroleague.com/standings>",
      "**How the season ends.** Divisions under 8 players: the top finisher moves up a division and last place moves down. Divisions of 8 or more: the top 2 finishers move up and the bottom 2 move down.\n\n**Ties.** Two players tied: play one extra game (a shootout) if you can -- that decides it. If you can't, the player who won your match against each other 2-0 takes it; failing that, the lives from that match, then total net lives for the season. Three or more tied: total net lives decide. Net lives = the lives you had left in your wins, minus the lives your opponents had left when they beat you.\n\n**Scheduling.** It's on you to set up your matches. Message your opponent in your division channel or by DM and agree on a time. Use Hammertime (<https://hammertime.cyou>) to post a time that shows correctly for both of you, whatever time zone you're in -- there's a **Schedule with Hammertime** button in your division channel.\n\n**Need help?** Click **Help** at the bottom of your division channel, ask in the support channel (<https://discord.com/channels/111/222>), or DM **Chrono**, who runs the league. Good luck out there!",
    ]);
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

describe("buildOnboardingGuideSections", () => {
  const EXPECTED_IDS = [
    "seasons",
    "tiers-and-divisions",
    "your-schedule",
    "playing-a-match",
    "results",
    "standings",
    "season-end",
    "ties",
    "scheduling",
    "need-help",
  ];

  it("returns the 10 sections in a stable order, each with a non-empty heading and body", () => {
    const content = buildOnboardingGuideSections(input());
    expect(content.sections.map((s) => s.id)).toEqual(EXPECTED_IDS);
    for (const section of content.sections) {
      expect(section.heading.length).toBeGreaterThan(0);
      expect(section.body.length).toBeGreaterThan(0);
    }
  });

  it("the need-help section uses '?' punctuation; every other section defaults to '.'", () => {
    const content = buildOnboardingGuideSections(input());
    for (const section of content.sections) {
      if (section.id === "need-help") {
        expect(section.headingPunctuation).toBe("?");
      } else {
        expect(section.headingPunctuation).toBeUndefined();
      }
    }
  });

  it("is the single source buildOnboardingGuideMessages assembles from -- every section body appears in the DM messages", () => {
    const i = input({ supportChannelUrl: "https://discord.com/channels/1/2" });
    const content = buildOnboardingGuideSections(i);
    const messages = buildOnboardingGuideMessages(i).join("\n");
    for (const section of content.sections) {
      expect(messages).toContain(section.body);
    }
  });

  it("property: section count and ids never change shape across arbitrary inputs", () => {
    fc.assert(
      fc.property(
        fc.record({
          seasonLabel: fc.string({ minLength: 1, maxLength: 40 }),
          seasonWindowLines: fc.array(fc.string({ maxLength: 120 }), { maxLength: 3 }),
          standingsUrl: fc.webUrl(),
          supportChannelUrl: fc.option(fc.webUrl(), { nil: null }),
        }),
        (i) => {
          const content = buildOnboardingGuideSections(i);
          expect(content.sections.map((s) => s.id)).toEqual(EXPECTED_IDS);
        },
      ),
    );
  });
});

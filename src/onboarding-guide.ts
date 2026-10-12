// Pure content builder for the first-timer "how it all works" guide. Powers
// TWO surfaces off the exact same structured sections:
//   - the onboarding DM (buildOnboardingGuideMessages, 3 Discord messages)
//   - the public /how-it-works page on the web (buildOnboardingGuideSections)
// so the two never disagree on wording. Reuses the exact wording already
// used in league-info-content.ts's STATIC_INTRO and queue.ts's
// renderDivisionWelcome -- the up()/down() promote/relegate agreement
// helpers below mirror renderDivisionWelcome's so all three surfaces agree.
//
// Only local import is ties-text.ts (also zero-import/pure), so this stays
// trivially unit-testable with plain data and can be mirrored into
// web/lib/onboarding-guide.ts (by web/scripts/sync-schema.mjs, which syncs
// ties-text.ts alongside it) for the admin preview and the public page to
// render identical copy.
//
// Discord's hard limit is 2000 chars per message; every returned message
// stays well under that, so the caller can send them as-is, in order.

import { tiesText, type SeasonTiebreak } from "./ties-text.js";

export interface OnboardingGuideInput {
  // e.g. "Season 7" or "Season 7 -- Launch" (formatSeasonLabel()).
  seasonLabel: string;
  // Pre-rendered season start/end line(s) (e.g. from seasonWindowLines()).
  // [] falls back to a generic "check the pinned info" line.
  seasonWindowLines: string[];
  // Link to the standings page -- the bot's DM needs the full URL Discord
  // requires (e.g. "https://balatroleague.com/standings"); the web page's
  // own loader passes a relative "/standings" instead (ux-round4 L10), since
  // discordMarkdownToHtml renders a bare "/path" as a same-tab link.
  standingsUrl: string;
  // Jump link to the support channel, or null to omit the direct mention.
  supportChannelUrl: string | null;
  // The active season's tiebreak mode -- drives the "Ties" section's exact
  // rule text via ties-text.ts. Pass normalizeTiebreak(season?.tiebreak)
  // (its "chain" default when no active season).
  tiebreak: SeasonTiebreak;
}

// One topic in the guide: a plain-text heading (no trailing punctuation --
// `headingPunctuation` supplies it for the DM's bold lead-in) and a body that
// may contain Discord markdown (**bold**, <url>). Stable `id`s so callers
// (the web page's anchors, tests) can address a section without depending on
// array order.
export interface OnboardingGuideSection {
  id: string;
  heading: string;
  // "." for a statement, "?" for a question. Defaults to "." when omitted.
  headingPunctuation?: "." | "?";
  body: string;
}

export interface OnboardingGuideContent {
  title: string;
  intro: string;
  sections: OnboardingGuideSection[];
}

// Promotion/relegation singular-vs-plural agreement -- mirrors up()/down() in
// src/queue.ts's renderDivisionWelcome so the wording never drifts apart.
export function up(n: number): string {
  return n === 1 ? "the top finisher moves up" : `the top ${n} finishers move up`;
}
export function down(n: number): string {
  return n === 1 ? "last place moves down" : `the bottom ${n} move down`;
}

// Assembles the guide's content as structured sections -- the single source
// both buildOnboardingGuideMessages (DM) and the web page build from.
export function buildOnboardingGuideSections(input: OnboardingGuideInput): OnboardingGuideContent {
  const windowLine =
    input.seasonWindowLines.length > 0
      ? `${input.seasonWindowLines.join(". ")}.`
      : "Check the pinned message in #league-info for the exact dates.";
  const helpBody = input.supportChannelUrl
    ? `Click **Help** at the bottom of your division channel, ask in the support channel: <${input.supportChannelUrl}>, or DM **Chrono**, who runs the league. Good luck out there!`
    : `Click **Help** at the bottom of your division channel, or DM **Chrono**, who runs the league. Good luck out there!`;

  return {
    title: "Welcome to the Balatro League!",
    intro: "You're new this season, so here's how it all works, start to finish.",
    sections: [
      {
        id: "seasons",
        heading: "The league runs in seasons",
        body: `You're playing in **${input.seasonLabel}** right now. ${windowLine} A season usually runs about two weeks. Signups for the next one open about a week in and stay open until that next season starts, so keep an eye on #league-info.`,
      },
      {
        id: "tiers-and-divisions",
        heading: "Tiers and divisions",
        body: `Each season is split into tiers by skill, highest to lowest: **Legendary**, **Rare**, **Uncommon**, **Common**. Each tier is split into divisions (small groups) so you're playing people around your level. Your division channel's name tells you which one you're in.`,
      },
      {
        id: "your-schedule",
        heading: "Your schedule",
        body: `You're placed in one division with a set of assigned opponents, not the whole server. The bot DMs you your matchups directly. If you lose track, click **Who do I play?** in your division channel any time; that's your reminder.`,
      },
      {
        id: "playing-a-match",
        heading: "Playing a match",
        body: `When you're ready to play someone, click **Start a match** at the bottom of your division channel and pick your opponent. The bot runs the bans and picks for you. A match is **two games**, and the deck/stake combo never repeats within a match. After each game, the **winner records how many lives they had left**. That number matters later for tiebreaks.`,
      },
      {
        id: "results",
        heading: "Results",
        body: `The bot records the result for you once the match is done. Nothing to report by hand.`,
      },
      {
        id: "standings",
        heading: "Standings",
        body: `Full standings for every division: <${input.standingsUrl}>`,
      },
      {
        id: "season-end",
        heading: "How the season ends",
        body: `The top finishers in each division move up a division and the bottom finishers move down. How many depends on the division. Your division channel and the standings show the exact number for yours.`,
      },
      {
        id: "ties",
        heading: "Ties",
        body: tiesText(input.tiebreak).rule,
      },
      {
        id: "scheduling",
        heading: "Scheduling",
        body: `It's on you to set up your matches. Message your opponent in your division channel or by DM and agree on a time. Use Hammertime: <https://hammertime.cyou> to post a time that shows correctly for both of you, whatever time zone you're in. There's a **Schedule with Hammertime** button in your division channel.`,
      },
      {
        id: "need-help",
        heading: "Need help",
        headingPunctuation: "?",
        body: helpBody,
      },
    ],
  };
}

// Renders one section as a Discord bold-lead-in line, e.g.
// "**Tiers and divisions.** Each season is split into tiers...".
function renderSectionLine(section: OnboardingGuideSection): string {
  const punctuation = section.headingPunctuation ?? ".";
  return `**${section.heading}${punctuation}** ${section.body}`;
}

function sectionById(sections: OnboardingGuideSection[], id: string): OnboardingGuideSection {
  const found = sections.find((s) => s.id === id);
  if (!found) throw new Error(`onboarding-guide: missing section "${id}"`);
  return found;
}

// Assembles the full guide as an ordered list of Discord messages, each kept
// under Discord's 2000-char limit. Send them in order, one after another.
export function buildOnboardingGuideMessages(input: OnboardingGuideInput): string[] {
  const content = buildOnboardingGuideSections(input);
  const byId = (id: string): OnboardingGuideSection => sectionById(content.sections, id);

  const message1 = [
    `# \u{1F0CF} ${content.title}`,
    content.intro,
    ``,
    renderSectionLine(byId("seasons")),
    ``,
    renderSectionLine(byId("tiers-and-divisions")),
    ``,
    renderSectionLine(byId("your-schedule")),
  ].join("\n");

  const message2 = [
    renderSectionLine(byId("playing-a-match")),
    ``,
    renderSectionLine(byId("results")),
    ``,
    renderSectionLine(byId("standings")),
  ].join("\n");

  const message3 = [
    renderSectionLine(byId("season-end")),
    ``,
    renderSectionLine(byId("ties")),
    ``,
    renderSectionLine(byId("scheduling")),
    ``,
    renderSectionLine(byId("need-help")),
  ].join("\n");

  return [message1, message2, message3];
}

export const ONBOARDING_GUIDE_MAX_MESSAGE_LENGTH = 2000;

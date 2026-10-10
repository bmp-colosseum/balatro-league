// Pure content builder for the first-timer "how it all works" DM (the
// onboarding guide). Reuses the exact wording already used in
// league-info-content.ts's STATIC_INTRO and queue.ts's renderDivisionWelcome
// -- the up()/down() promote/relegate agreement helpers below mirror
// renderDivisionWelcome's so the two surfaces never disagree on wording.
//
// No imports -- kept trivially pure (like checkin-message.ts) so it's
// unit-testable with plain data and can be mirrored into
// web/lib/onboarding-guide.ts (by web/scripts/sync-schema.mjs) for the admin
// preview to render identical copy.
//
// Discord's hard limit is 2000 chars per message; every returned message
// stays well under that, so the caller can send them as-is, in order.

export interface OnboardingGuideInput {
  // e.g. "Season 7" or "Season 7 -- Launch" (formatSeasonLabel()).
  seasonLabel: string;
  // Pre-rendered season start/end line(s) (e.g. from seasonWindowLines()).
  // [] falls back to a generic "check the pinned info" line.
  seasonWindowLines: string[];
  // Full URL to the standings page, e.g. "https://balatroleague.com/standings".
  standingsUrl: string;
  // Jump link to the support channel, or null to omit the direct mention.
  supportChannelUrl: string | null;
}

// Promotion/relegation singular-vs-plural agreement -- mirrors up()/down() in
// src/queue.ts's renderDivisionWelcome so the wording never drifts apart.
export function up(n: number): string {
  return n === 1 ? "the top finisher moves up" : `the top ${n} finishers move up`;
}
export function down(n: number): string {
  return n === 1 ? "last place moves down" : `the bottom ${n} move down`;
}

function message1(input: OnboardingGuideInput): string {
  const windowLine =
    input.seasonWindowLines.length > 0
      ? `${input.seasonWindowLines.join(". ")}.`
      : "Check the pinned message in #league-info for the exact dates.";
  return [
    `# \u{1F0CF} Welcome to the Balatro League!`,
    `You're new this season, so here's how it all works, start to finish.`,
    ``,
    `**The league runs in seasons.** You're playing in **${input.seasonLabel}** right now. ${windowLine} A season usually runs about two weeks. Signups for the next one open about a week in and stay open until that next season starts, so keep an eye on #league-info.`,
    ``,
    `**Tiers and divisions.** Each season is split into tiers by skill, highest to lowest: **Legendary**, **Rare**, **Uncommon**, **Common**. Each tier is split into divisions (small groups) so you're playing people around your level. Your division channel's name tells you which one you're in.`,
    ``,
    `**Your schedule.** You're placed in one division with a set of assigned opponents -- not the whole server. The bot DMs you your matchups directly. If you lose track, click **Who do I play?** in your division channel any time; that's your reminder.`,
  ].join("\n");
}

function message2(input: OnboardingGuideInput): string {
  return [
    `**Playing a match.** When you're ready to play someone, click **Start a match** at the bottom of your division channel and pick your opponent. The bot runs the pick/ban phase for you. A match is **two games**, and the deck/stake combo never repeats within a matchup. After each game, the **winner records how many lives they had left** -- that number matters later for tiebreaks.`,
    ``,
    `**Results.** The bot records the result once it's reported. Your opponent gets **confirm** or **dispute** buttons. A dispute goes to a staff thread to get sorted out; you don't need to do anything else.`,
    ``,
    `**Standings.** Full standings for every division: <${input.standingsUrl}>`,
  ].join("\n");
}

function message3(input: OnboardingGuideInput): string {
  const helpLine = input.supportChannelUrl
    ? `**Need help?** Click **Help** at the bottom of your division channel, ask in #league-support (<${input.supportChannelUrl}>), or DM **Chrono**, who runs the league. Good luck out there!`
    : `**Need help?** Click **Help** at the bottom of your division channel, or DM **Chrono**, who runs the league. Good luck out there!`;
  return [
    `**How the season ends.** Divisions under 8 players: ${up(1)} a division and ${down(1)}. Divisions of 8 or more: ${up(2)} and ${down(2)}.`,
    ``,
    `**Ties.** Two players tied: play one extra game (a shootout) if you can -- that decides it. If you can't, the player who won your match against each other 2-0 takes it; failing that, the lives from that match, then total net lives for the season. Three or more tied: total net lives decide. Net lives = the lives you had left in your wins, minus the lives your opponents had left when they beat you.`,
    ``,
    `**Scheduling.** It's on you to set up your matches. Message your opponent in your division channel or by DM and agree on a time. Click **Schedule a time** (Hammertime) to post a time that shows correctly for both of you, whatever time zone you're in.`,
    ``,
    helpLine,
  ].join("\n");
}

// Assembles the full guide as an ordered list of Discord messages, each kept
// under Discord's 2000-char limit. Send them in order, one after another.
export function buildOnboardingGuideMessages(input: OnboardingGuideInput): string[] {
  return [message1(input), message2(input), message3(input)];
}

export const ONBOARDING_GUIDE_MAX_MESSAGE_LENGTH = 2000;

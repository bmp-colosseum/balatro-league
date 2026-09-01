// Builds the self-updating #league-info pinned message: a static
// rules/intro block + a dynamic "current state" block reflecting
// whatever the league is doing right now (signups open / season N
// active / season N ended).
//
// Refresh is triggered by:
//   - /league bootstrap-server (first install)
//   - openSignupsForSeason / finalizeSignupsForSeason (web)
//   - performSeasonActivation / endSeason (web)
//   - sweepScheduledStarts (bot — scheduled activation)
// All paths fan into the league-info.refresh pg-boss queue worker
// which calls composeLeagueInfo + edits/pins the message.

import { prisma } from "./db.js";
import { formatSeasonLabel } from "./format-season.js";
import { webUrl } from "./web-url.js";
import { seasonEndsHammer, seasonStartsHammer } from "./season-timing.js";

const STATIC_INTRO = [
  "# 🃏 Balatro League",
  "",
  "Each season you're placed in a division by skill, then play a set of **assigned opponents** - **2 games each**. Run `/schedule` to see exactly who you play. The top finishers in each division **promote** up a division next season and the bottom finishers **relegate** down - how many move (and whether you're currently in a promotion or relegation spot) shows in `/standings` and `/status`.",
  "",
  "**Scoring:** `2-0` = 3 pts · `1-1` = 1 pt each · `0-2` = 0.",
  "",
  "**Lives & net lives:** the winner of each game records how many lives they had left (0-4). Your **net lives** = the leftover lives across your wins minus the lives your opponents had left when they beat you, so it rewards winning big and losing close.",
  "",
  "**How ties are broken** (for the promotion/relegation spots):",
  "- **Two players tied:** head-to-head decides it - whoever won when you played each other. If you split head-to-head (`1-1`), or you haven't played each other yet, it's settled by a **single shootout game** between the two of you.",
  "- **Three or more tied:** **net lives** breaks it - higher net lives ranks higher. It's a best-effort measure, but it's what settles multi-way ties.",
  "",
  "Play your matches with `/start-match @opponent` in your division channel. Type `/help` for every command.",
  "",
  `**Website:** <${webUrl()}> — standings, profiles, sign up.`,
].join("\n");

export async function composeLeagueInfoContent(): Promise<string> {
  const dynamic = await composeDynamicBlock();
  return `${STATIC_INTRO}\n\n${dynamic}`;
}

async function composeDynamicBlock(): Promise<string> {
  // The active season and an open signup round can BOTH be true (signups for
  // next season open while the current one is still being played) — so we
  // build each block independently and show both. Order: live season first,
  // then "signups open for next". Falls through to ended/none when neither.
  const now = new Date();
  const [openRound, activeSeason, fallbackUpcomingSeason] = await Promise.all([
    prisma.signupRound.findFirst({
      where: { status: "OPEN" },
      orderBy: { openedAt: "desc" },
      select: {
        name: true,
        channelId: true,
        resultingSeasonId: true,
        signups: { where: { withdrawn: false }, select: { id: true } },
      },
    }),
    prisma.season.findFirst({
      where: { isActive: true },
      select: { id: true, number: true, subtitle: true, startedAt: true, scheduledEndAt: true },
    }),
    // Fallback upcoming season when there's no open signup round to prefer
    // (see below) — the earliest not-active, not-ended season with a
    // scheduled start still in the future.
    prisma.season.findFirst({
      where: { isActive: false, endedAt: null, scheduledStartAt: { gt: now } },
      orderBy: { scheduledStartAt: "asc" },
      select: { id: true, number: true, subtitle: true, scheduledStartAt: true },
    }),
  ]);

  const blocks: string[] = [];

  if (activeSeason) {
    const label = formatSeasonLabel(activeSeason);
    const startH = seasonStartsHammer(activeSeason.startedAt);
    const endH = seasonEndsHammer(activeSeason.scheduledEndAt);
    blocks.push(
      [
        "─────────────────────",
        `## 🏆 ${label} is live!`,
        `Active since ${startH ? startH.full : "?"}${endH ? ` - scheduled to end ${endH.full}` : ""}.`,
        `**Standings:** <${webUrl("standings")}>`,
        "Use `/start-match @opponent` in your division channel to play.",
      ].join("\n"),
    );
  }

  // Which season's start date to show alongside signups (if any). Preferring
  // the open round's OWN resultingSeasonId keeps the signup block and this
  // date in agreement — they're describing the same season.
  let upcomingSeason: { id: string; number: number; subtitle: string | null; scheduledStartAt: Date | null } | null =
    fallbackUpcomingSeason;

  if (openRound) {
    let seasonLabel = openRound.name;
    if (openRound.resultingSeasonId) {
      const s = await prisma.season.findUnique({
        where: { id: openRound.resultingSeasonId },
        select: { number: true, subtitle: true, isActive: true, endedAt: true, scheduledStartAt: true },
      });
      if (s) {
        seasonLabel = formatSeasonLabel(s);
        if (!s.isActive && !s.endedAt) {
          upcomingSeason = {
            id: openRound.resultingSeasonId,
            number: s.number,
            subtitle: s.subtitle,
            scheduledStartAt: s.scheduledStartAt,
          };
        }
      }
    }
    blocks.push(
      [
        "─────────────────────",
        `## 📝 Signups open: ${seasonLabel}`,
        `Click the **Sign Up** button in <#${openRound.channelId}> to register.`,
        `**${openRound.signups.length} signed up so far.**`,
        "",
        `_Or sign up from <${webUrl("join")}>._`,
      ].join("\n"),
    );
  }

  if (upcomingSeason?.scheduledStartAt && upcomingSeason.scheduledStartAt.getTime() > now.getTime()) {
    const startH = seasonStartsHammer(upcomingSeason.scheduledStartAt);
    if (startH) {
      const label = formatSeasonLabel(upcomingSeason);
      blocks.push(
        [
          "─────────────────────",
          `## ${label} starts ${startH.full} (${startH.relative})`,
        ].join("\n"),
      );
    }
  }

  if (blocks.length > 0) return blocks.join("\n\n");

  // Pick the most-recently-ended season for "last season was…" context.
  const recentEnded = await prisma.season.findFirst({
    where: { endedAt: { not: null } },
    orderBy: { endedAt: "desc" },
    select: { id: true, number: true, subtitle: true, endedAt: true },
  });
  if (recentEnded?.endedAt) {
    const label = formatSeasonLabel(recentEnded);
    const ended = recentEnded.endedAt.toISOString().slice(0, 10);
    return [
      "─────────────────────",
      `## 🏁 ${label} ended on ${ended}`,
      `Next season's signups will be posted in this server when ready —` +
        ` opt in for a DM on <${webUrl("me")}>.`,
      `**Past standings:** <${webUrl("seasons")}>`,
    ].join("\n");
  }

  return [
    "─────────────────────",
    "## 🌱 No season running yet",
    "Sit tight — admin will open signups when the next season is ready.",
    `Opt in for a DM on <${webUrl("me")}>.`,
  ].join("\n");
}

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

const STATIC_INTRO = [
  "# 🃏 Balatro League",
  "",
  "Each season you're put in a division by skill, then play a set of opponents — **2 games each** (top divisions play everyone; the rest play 4 others). Run `/schedule` to see your matchups. Top of each division moves up next season, bottom moves down.",
  "",
  "**Scoring:** `2-0` = 3 pts · `1-1` = 1 pt each · `0-2` = 0.",
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
  const [openRound, activeSeason] = await Promise.all([
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
      select: { id: true, number: true, subtitle: true, startedAt: true },
    }),
  ]);

  const blocks: string[] = [];

  if (activeSeason) {
    const label = formatSeasonLabel(activeSeason);
    const since = activeSeason.startedAt.toISOString().slice(0, 10);
    blocks.push(
      [
        "─────────────────────",
        `## 🏆 ${label} is live!`,
        `Active since ${since}.`,
        `**Standings:** <${webUrl("standings")}>`,
        "Use `/start-match @opponent` in your division channel to play.",
      ].join("\n"),
    );
  }

  if (openRound) {
    let seasonLabel = openRound.name;
    if (openRound.resultingSeasonId) {
      const s = await prisma.season.findUnique({
        where: { id: openRound.resultingSeasonId },
        select: { number: true, subtitle: true },
      });
      if (s) seasonLabel = formatSeasonLabel(s);
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

// Web-side shell for the "auto-open signups" status line on Season Tools
// (web/app/admin/season-tools/page.tsx). Gathers the same plain inputs the
// bot's hourly tick computes from (src/auto-signups.ts) and feeds them
// through the shared pure core (web/lib/auto-signups-core.ts, synced from
// src/auto-signups-core.ts) so the two can never disagree about what state
// they're in. Read-only -- this file never opens anything itself.

import { prisma } from "@/lib/prisma";
import { decideAutoSignups, type AutoSignupDecision } from "@/lib/auto-signups-core";
import { formatSeasonLabel } from "@/lib/format-season";

const DEFAULT_AUTO_OPEN_DAYS = 7;

// Mirrors getSeasonLengthDays's read pattern (web/lib/signup-discord.ts).
export async function getSignupsAutoOpenDays(): Promise<number> {
  const row = await prisma.leagueConfig.findUnique({ where: { key: "signups_auto_open_days" } });
  if (!row) return DEFAULT_AUTO_OPEN_DAYS;
  const n = Number(row.value);
  return Number.isFinite(n) ? Math.floor(n) : DEFAULT_AUTO_OPEN_DAYS;
}

// Resolves the channel auto-open would post to: the configured default, else
// the most recently opened round's channel (same fallback the bot tick uses).
export async function getAutoSignupsChannelId(): Promise<string | null> {
  const configured = await prisma.leagueConfig.findUnique({ where: { key: "signups_channel_id" } });
  if (configured?.value) return configured.value;
  const lastRound = await prisma.signupRound.findFirst({ orderBy: { openedAt: "desc" }, select: { channelId: true } });
  return lastRound?.channelId ?? null;
}

export interface AutoSignupsStatus {
  decision: AutoSignupDecision;
  activeSeasonLabel: string | null;
  nextSeasonNumber: number | null;
  channelId: string | null;
}

// No active season at all means there's nothing to anchor a due date on --
// the checklist shows a plain "no active season" fallback instead of calling
// the core (there's no startedAt to pass it).
export async function loadAutoSignupsStatus(): Promise<AutoSignupsStatus> {
  const activeSeason = await prisma.season.findFirst({ where: { isActive: true } });
  const autoOpenDays = await getSignupsAutoOpenDays();
  const channelId = await getAutoSignupsChannelId();

  if (!activeSeason) {
    return { decision: { action: "off" }, activeSeasonLabel: null, nextSeasonNumber: null, channelId };
  }

  const nextSeasonNumberValue = activeSeason.number + 1;
  const [nextSeason, anyOpenRound] = await Promise.all([
    prisma.season.findUnique({ where: { number: nextSeasonNumberValue } }),
    prisma.signupRound.findFirst({ where: { status: "OPEN" }, select: { id: true } }),
  ]);
  const nextSeasonHadRound = nextSeason
    ? (await prisma.signupRound.count({ where: { resultingSeasonId: nextSeason.id } })) > 0
    : false;

  const decision = decideAutoSignups({
    now: new Date(),
    autoOpenDays,
    activeSeasonStartedAt: activeSeason.startedAt,
    activeSeasonScheduledEndAt: activeSeason.scheduledEndAt,
    nextSeasonExists: Boolean(nextSeason),
    nextSeasonHadRound,
    anyOpenRoundExists: Boolean(anyOpenRound),
  });

  return {
    decision,
    activeSeasonLabel: formatSeasonLabel(activeSeason),
    nextSeasonNumber: nextSeasonNumberValue,
    channelId,
  };
}

// One line for the Season Tools checklist's "Signups" step. Pure formatting
// over loadAutoSignupsStatus's result -- no I/O, kept separate so it's easy to
// eyeball against the four states the organiser actually sees.
export function formatAutoSignupsLine(status: AutoSignupsStatus): string {
  const channel = status.channelId ? `#${status.channelId}` : "no channel configured";
  switch (status.decision.action) {
    case "off":
      return status.activeSeasonLabel ? "Off." : "Off (no active season).";
    case "already-open":
      return "Already open.";
    case "needs-next-season":
      return `Season ${status.nextSeasonNumber} will be created automatically, then signups open in ${channel}.`;
    case "wait":
      return `Signups for Season ${status.nextSeasonNumber} open automatically on ${status.decision.dueAt.toISOString().slice(0, 10)} in ${channel}.`;
    case "open-now":
      return `Signups for Season ${status.nextSeasonNumber} open automatically within the hour, in ${channel}.`;
  }
}

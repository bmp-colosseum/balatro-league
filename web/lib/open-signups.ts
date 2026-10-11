// Shared "open signups for a season" effects, extracted from the
// openSignupsForSeason server action (web/app/admin/seasons/actions.ts) so
// the auto-open path (web/lib/auto-signups.ts's status line; the bot's
// src/auto-signups.ts performs its OWN version against its own Prisma/
// Discord clients -- see that file's header for why) and the admin's manual
// "Open signups" button run through identical behavior. The action stays a
// thin wrapper: auth, form parsing, redirect/revalidate.
//
// Not "use server" -- plain helpers, like web/lib/signup-discord.ts.

import { prisma } from "@/lib/prisma";
import type { AuditActor } from "@/lib/audit";
import { recordAudit } from "@/lib/audit";
import { postChannelMessage } from "@/lib/discord";
import { buildSignupPayload, getSeasonLengthDays } from "@/lib/signup-discord";
import { enqueueLeagueInfoRefresh, enqueueSignupAskKickoff } from "@/lib/queue";
import { formatSeasonLabel } from "@/lib/format-season";

export interface OpenSignupsOptions {
  closesAt?: Date | null;
  seasonStartsAt?: Date | null;
  seasonEndsAt?: Date | null;
}

export type OpenSignupsResult =
  | { ok: true; roundId: string }
  | { ok: false; error: "no-guild-id" | "season-not-found" | "signup-post-failed" };

// Opens a signup round for `seasonId` in `channelId`: closes any stale OPEN
// round, creates the new one, posts the Discord embed, records the audit
// entry, and enqueues the ask-kickoff + league-info refresh jobs. Mirrors
// openSignupsForSeason's body exactly (same order of effects) -- see that
// action in web/app/admin/seasons/actions.ts for the admin-triggered caller.
export async function openSignupsCore(
  seasonId: string,
  channelId: string,
  actor: AuditActor,
  opts: OpenSignupsOptions = {},
): Promise<OpenSignupsResult> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return { ok: false, error: "no-guild-id" };

  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) return { ok: false, error: "season-not-found" };

  const seasonLabel = formatSeasonLabel(season);

  // Only ONE round may be OPEN: the join page, the bot's league-info post and
  // every signup path pick "the open round", so a round that was built from
  // but never closed silently swallows later signups. Close any leftover
  // first. See openSignupsForSeason's identical comment.
  const stale = await prisma.signupRound.updateMany({
    where: { status: "OPEN" },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  if (stale.count > 0) console.warn(`[signups.open] closed ${stale.count} stale OPEN round(s) before opening ${seasonLabel}`);

  const round = await prisma.signupRound.create({
    data: {
      name: `${seasonLabel} Signups`,
      guildId,
      channelId,
      messageId: "pending",
      resultingSeasonId: season.id,
      status: "OPEN",
      closesAt: opts.closesAt ?? null,
      seasonStartsAt: opts.seasonStartsAt ?? null,
      seasonEndsAt: opts.seasonEndsAt ?? null,
    },
  });

  const messageId = await postChannelMessage(
    channelId,
    buildSignupPayload({ ...round, seasonScheduledStartAt: season.scheduledStartAt }, 0, await getSeasonLengthDays()),
  );
  if (!messageId) {
    await prisma.signupRound.delete({ where: { id: round.id } });
    return { ok: false, error: "signup-post-failed" };
  }
  await prisma.signupRound.update({ where: { id: round.id }, data: { messageId } });

  recordAudit({
    actor,
    action: "signup-round.open",
    targetType: "SignupRound",
    targetId: round.id,
    summary: `Opened signups for "${seasonLabel}"`,
    metadata: { seasonId: season.id, channelId },
  });

  // Kick off the interactive "are you in?" ask + refresh #league-info so the
  // "Signups open" block appears. Best-effort -- a failure here shouldn't
  // undo the round that's already live in Discord.
  await enqueueSignupAskKickoff(round.id).catch((err) =>
    console.warn("[signups.open] ask-kickoff enqueue failed:", err),
  );
  await enqueueLeagueInfoRefresh().catch((err) =>
    console.warn("[signups.open] league-info refresh enqueue failed:", err),
  );

  return { ok: true, roundId: round.id };
}

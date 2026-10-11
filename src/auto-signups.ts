// Auto-open signups for the next season -- the hands-off version of the admin
// clicking "Open signups" on /admin/seasons about a week into the current
// one. Driven by the hourly signup.auto-open-tick job (see src/queue.ts).
//
// Code-sharing note: the web side already has an identical-shape effects
// function (openSignupsCore in web/lib/open-signups.ts) that the admin
// action and this tick's web-side status line both reuse. That function
// can't be imported here -- it's written against Next.js's "@/lib/..."
// path-aliased module resolution and the web app's own REST-based Discord
// client, neither of which resolve under this workspace's plain Node/
// NodeNext module graph. So this file re-implements the same STEPS against
// the bot's own Prisma client (./db.js) and its own discord.js client
// (./discord.js), in the same order: close stale OPEN round -> create
// round (+ season, if needed) -> post the Discord embed -> record audit ->
// enqueue ask-kickoff + league-info refresh. The one thing that CAN'T drift
// between the two implementations is the decision of WHEN to act -- both
// read LeagueConfig/Season/SignupRound into the same plain shape and run it
// through decideAutoSignups (src/auto-signups-core.ts, synced to
// web/lib/auto-signups-core.ts), so "is it due yet" is tested once.

import { prisma } from "./db.js";
import { getDiscordClient } from "./discord.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";
import { activePublicSeason } from "./active-season.js";
import { recordAudit, type AuditActor } from "./audit.js";
import { formatSeasonLabel } from "./format-season.js";
import { signupEmbed, signupButtons, DEFAULT_SEASON_LENGTH_DAYS } from "./signup/signup.js";
import { enqueueSignupAskKickoff, enqueueLeagueInfoRefresh } from "./queue.js";
import { env } from "./env.js";
import { decideAutoSignups } from "./auto-signups-core.js";

const DEFAULT_AUTO_OPEN_DAYS = 7;

// Not a human -- logged distinctly from SYSTEM_ACTOR ("system") so an audit
// reader can tell an auto-opened round apart from other system-triggered rows.
const AUTO_ACTOR: AuditActor = { discordId: "system/auto-signups", displayName: "auto-signups" };

async function getSignupsAutoOpenDays(): Promise<number> {
  const raw = await getConfig(LeagueConfigKey.SignupsAutoOpenDays);
  if (raw == null) return DEFAULT_AUTO_OPEN_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : DEFAULT_AUTO_OPEN_DAYS;
}

async function seasonLengthDays(): Promise<number> {
  const raw = await getConfig(LeagueConfigKey.SeasonLengthDays);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SEASON_LENGTH_DAYS;
}

// Configured signups channel, else the most recently opened round's channel --
// mirrors web/lib/auto-signups.ts's getAutoSignupsChannelId fallback.
async function resolveSignupsChannelId(): Promise<string | null> {
  const configured = await getConfig(LeagueConfigKey.SignupsChannelId);
  if (configured) return configured;
  const lastRound = await prisma.signupRound.findFirst({ orderBy: { openedAt: "desc" }, select: { channelId: true } });
  return lastRound?.channelId ?? null;
}

// Posts a brand-new OPEN round for `season` into `channelId`. Same steps as
// openSignupsCore on the web side: close any stale OPEN round, create,
// post, record audit, enqueue follow-ups. Deletes the round again if the
// Discord post fails, so a retry next hour starts clean.
async function openSignupsFor(season: { id: string; number: number; subtitle: string | null; scheduledStartAt: Date | null }, channelId: string): Promise<void> {
  const guildId = env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.warn("[signup.auto-open-tick] DISCORD_GUILD_ID not set -- skipping");
    return;
  }
  const seasonLabel = formatSeasonLabel(season);

  const stale = await prisma.signupRound.updateMany({
    where: { status: "OPEN" },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  if (stale.count > 0) console.warn(`[signup.auto-open-tick] closed ${stale.count} stale OPEN round(s) before opening ${seasonLabel}`);

  const round = await prisma.signupRound.create({
    data: {
      name: `${seasonLabel} Signups`,
      guildId,
      channelId,
      messageId: "pending",
      resultingSeasonId: season.id,
      status: "OPEN",
    },
  });

  let messageId: string | null = null;
  try {
    const channel = await getDiscordClient().channels.fetch(channelId);
    if (channel && channel.isTextBased() && "send" in channel) {
      const lengthDays = await seasonLengthDays();
      const msg = await channel.send({
        embeds: [signupEmbed(round, [], lengthDays)],
        components: [signupButtons(round)],
      });
      messageId = msg.id;
    }
  } catch (err) {
    console.warn(`[signup.auto-open-tick] post to ${channelId} failed:`, err);
  }

  if (!messageId) {
    await prisma.signupRound.delete({ where: { id: round.id } });
    console.warn(`[signup.auto-open-tick] signup post failed for ${seasonLabel} -- round rolled back, will retry next tick`);
    return;
  }
  await prisma.signupRound.update({ where: { id: round.id }, data: { messageId } });

  await recordAudit({
    actor: AUTO_ACTOR,
    action: "signup-round.open",
    targetType: "SignupRound",
    targetId: round.id,
    summary: `Opened signups for "${seasonLabel}" (auto)`,
    metadata: { seasonId: season.id, channelId },
  });

  await enqueueSignupAskKickoff(round.id).catch((err) =>
    console.warn("[signup.auto-open-tick] ask-kickoff enqueue failed:", err),
  );
  await enqueueLeagueInfoRefresh().catch((err) =>
    console.warn("[signup.auto-open-tick] league-info refresh enqueue failed:", err),
  );
  console.log(`[signup.auto-open-tick] opened signups for ${seasonLabel} in #${channelId}`);
}

// Creates Season N+1 from Season N's shape (group sizes, scoring mode,
// tiebreak) -- same fields createSeason() on the web admin sets, minus
// subtitle (left blank, same as a manually-created season). Opponents/player
// is a global default (LeagueConfig placement_rules), not a per-season field,
// so there's nothing to copy for it.
async function createNextSeasonFrom(active: { number: number; targetGroupSize: number; minGroupSize: number; scoringMode: string; tiebreak: string }) {
  const season = await prisma.season.create({
    data: {
      number: active.number + 1,
      subtitle: null,
      isActive: false,
      targetGroupSize: active.targetGroupSize,
      minGroupSize: active.minGroupSize,
      scoringMode: active.scoringMode,
      tiebreak: active.tiebreak,
    },
  });
  await recordAudit({
    actor: AUTO_ACTOR,
    action: "season.auto-create",
    targetType: "Season",
    targetId: season.id,
    summary: `Created season "${formatSeasonLabel(season)}" (auto, ahead of signups)`,
    metadata: { targetGroupSize: season.targetGroupSize, minGroupSize: season.minGroupSize },
  });
  return season;
}

// The hourly tick body (signup.auto-open-tick in src/queue.ts). Idempotent:
// re-running it when nothing is due, or when signups are already open,
// is always a no-op -- decideAutoSignups guarantees that, not this function.
export async function runAutoOpenSignupsTick(): Promise<void> {
  const autoOpenDays = await getSignupsAutoOpenDays();
  if (autoOpenDays <= 0) return; // off -- skip the DB reads below entirely

  const active = await activePublicSeason();
  if (!active) {
    console.warn("[signup.auto-open-tick] no active season -- nothing to anchor a due date on");
    return;
  }

  const nextSeasonNumberValue = active.number + 1;
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
    activeSeasonStartedAt: active.startedAt,
    nextSeasonExists: Boolean(nextSeason),
    nextSeasonHadRound,
    anyOpenRoundExists: Boolean(anyOpenRound),
  });

  if (decision.action === "off" || decision.action === "wait" || decision.action === "already-open") return;

  const channelId = await resolveSignupsChannelId();
  if (!channelId) {
    console.warn("[signup.auto-open-tick] no signups channel configured and no prior round to fall back to -- skipping");
    return;
  }

  const season = decision.action === "needs-next-season" ? await createNextSeasonFrom(active) : nextSeason!;
  await openSignupsFor(season, channelId);
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit, type AuditActor } from "@/lib/audit";
import { runSeasonDiscordBootstrap } from "./bootstrap-actions";
import { formatSeasonLabel, nextSeasonNumber } from "@/lib/format-season";
import {
  createChannelInvite,
  editChannelMessage,
  postChannelMessage,
  type ComponentActionRow,
  type MessageEmbed,
} from "@/lib/discord";
import { enqueueDm, enqueueMmrSnapshot } from "@/lib/queue";
import { computeRatingDeltas, type DivisionForRating } from "@/lib/end-season";
import { computeStandings } from "@/lib/standings";

interface TierConfig {
  name: string;
  divisionCount: number;
}

const LAST_USED_NAME = "Last used";

function parseConfig(json: string): TierConfig[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((e) => ({
        name: String(e?.name ?? "").trim(),
        divisionCount: Math.max(1, Math.min(50, Math.floor(Number(e?.divisionCount)))) || 1,
      }))
      .filter((t) => t.name.length > 0);
  } catch {
    return [];
  }
}

function defaultDivisionNames(tier: TierConfig): string[] {
  if (tier.divisionCount === 1) return [tier.name];
  return Array.from({ length: tier.divisionCount }, (_, i) => `${tier.name} ${i + 1}`);
}

export async function createSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const subtitleRaw = String(formData.get("subtitle") ?? "").trim();
  const subtitle = subtitleRaw.length > 0 ? subtitleRaw : null;

  // Tier config is now OPTIONAL — admin can skip setup and configure tiers
  // later once they see how many players signed up.
  const configs = parseConfig(String(formData.get("config") ?? ""));

  // `datetime-local` inputs submit the value in the user's local
  // timezone WITHOUT a Z suffix. Parsing the raw value lets JS treat
  // it as local time and convert to UTC for storage. Appending "Z"
  // (as we used to) misinterpreted the input as already-UTC, shifting
  // the stored time by the user's offset.
  let deadline: Date | null = null;
  const deadlineStr = String(formData.get("deadline") ?? "");
  if (deadlineStr) {
    const d = new Date(deadlineStr);
    if (!Number.isNaN(d.getTime())) deadline = d;
  }

  const targetGroupSize = Math.max(2, parseInt(String(formData.get("targetGroupSize")), 10) || 5);
  const minGroupSize = Math.max(2, parseInt(String(formData.get("minGroupSize")), 10) || 3);

  const number = await nextSeasonNumber(prisma);
  const season = await prisma.season.create({
    data: { number, subtitle, deadline, isActive: false, targetGroupSize, minGroupSize },
  });

  if (configs.length > 0) {
    await createTiersAndDivisionsFor(season.id, configs);
    await prisma.tierTemplate.upsert({
      where: { name: LAST_USED_NAME },
      create: { name: LAST_USED_NAME, config: JSON.stringify(configs), isLastUsed: true },
      update: { config: JSON.stringify(configs), isLastUsed: true },
    });
  }
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.create",
    targetType: "Season",
    targetId: season.id,
    summary: `Created season "${formatSeasonLabel(season)}"`,
    metadata: { targetGroupSize, minGroupSize, tierCount: configs.length, deadline: deadline?.toISOString() ?? null },
  });

  revalidatePath("/admin/seasons");
}

async function createTiersAndDivisionsFor(seasonId: string, configs: TierConfig[]) {
  for (let i = 0; i < configs.length; i++) {
    const c = configs[i]!;
    const tier = await prisma.tier.create({
      data: { seasonId, position: i + 1, name: c.name },
    });
    const names = defaultDivisionNames(c);
    for (let g = 1; g <= c.divisionCount; g++) {
      await prisma.division.create({
        data: { seasonId, tierId: tier.id, groupNumber: g, name: names[g - 1]! },
      });
    }
  }
}

// Configure tiers for an existing tier-less season (e.g. one created with
// "skip tier setup" then configured after signups close so admin sees the
// player count). Refuses if tiers already exist — use delete-and-recreate
// (manual on the page) for now.
// Add a new empty division to a tier. Draft-mode only — once the
// season is active or ended, adding empty divisions risks orphaning
// pairings (Pairing.divisionId points at the source, players who
// got moved would lose their match history visibility). For active-
// season needs, admin can delete + rebuild from draft.
export async function addDivisionToTier(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  const tierId = String(formData.get("tierId") ?? "");
  if (!seasonId || !tierId) return;
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) redirect("/admin/seasons?err=season-not-found");
  if (season!.isActive || season!.endedAt) {
    redirect(`/seasons/${seasonId}?err=${encodeURIComponent("Can't add divisions to an active or ended season — only during draft.")}`);
  }
  const tier = await prisma.tier.findUnique({ where: { id: tierId } });
  if (!tier || tier.seasonId !== seasonId) {
    redirect(`/seasons/${seasonId}?err=${encodeURIComponent("That tier isn't part of this season.")}`);
  }
  // Pick the next groupNumber + auto-name. If the tier currently has
  // a single division named just the tier name (e.g. "Legendary"),
  // we still increment — the new one becomes "Legendary 2" and admin
  // can rename the first one if they want consistency.
  const existing = await prisma.division.findMany({
    where: { tierId },
    select: { groupNumber: true },
    orderBy: { groupNumber: "desc" },
    take: 1,
  });
  const nextGroup = (existing[0]?.groupNumber ?? 0) + 1;
  const created = await prisma.division.create({
    data: {
      seasonId,
      tierId,
      groupNumber: nextGroup,
      name: `${tier!.name} ${nextGroup}`,
    },
  });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "division.add",
    targetType: "Division",
    targetId: created.id,
    summary: `Added empty division "${created.name}" to "${tier!.name}" in draft season`,
    metadata: { seasonId, tierId, name: created.name, groupNumber: nextGroup },
  });
  revalidatePath(`/seasons/${seasonId}`);
}

// Remove an empty division. Draft-mode only (matches addDivisionToTier
// constraint) and refuses if the division still has members — admin
// must move them out via the drag editor first. Same audit shape as
// the add action, action="division.remove".
export async function deleteDivision(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  if (!divisionId) return;
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    include: {
      season: { select: { id: true, isActive: true, endedAt: true } },
      tier: { select: { name: true } },
      _count: { select: { members: true, pairings: true } },
    },
  });
  if (!division) {
    redirect(`/admin/seasons?err=${encodeURIComponent("Division not found.")}`);
  }
  if (division!.season.isActive || division!.season.endedAt) {
    redirect(
      `/seasons/${division!.season.id}?err=${encodeURIComponent(
        "Can't delete a division from an active or ended season — only during draft.",
      )}`,
    );
  }
  if (division!._count.members > 0) {
    redirect(
      `/seasons/${division!.season.id}?err=${encodeURIComponent(
        `"${division!.name}" still has ${division!._count.members} member(s). Move them to other divisions first, then delete.`,
      )}`,
    );
  }
  // _count.pairings should be 0 in draft mode (no matches played yet),
  // but guard anyway — if somehow a pairing exists for this division
  // we refuse rather than orphan match history.
  if (division!._count.pairings > 0) {
    redirect(
      `/seasons/${division!.season.id}?err=${encodeURIComponent(
        `"${division!.name}" has match history attached. Refusing to delete.`,
      )}`,
    );
  }
  await prisma.division.delete({ where: { id: divisionId } });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "division.remove",
    targetType: "Division",
    targetId: divisionId,
    summary: `Removed empty division "${division!.name}" from "${division!.tier.name}" in draft season`,
    metadata: { seasonId: division!.season.id, name: division!.name },
  });
  revalidatePath(`/seasons/${division!.season.id}`);
}

export async function configureTiers(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  const configs = parseConfig(String(formData.get("config") ?? ""));
  if (!seasonId || configs.length === 0) return;
  const existingTierCount = await prisma.tier.count({ where: { seasonId } });
  if (existingTierCount > 0) {
    redirect(`/admin/seasons?err=${encodeURIComponent("Tiers already configured for this season — delete the season + recreate, or edit divisions individually.")}`);
  }
  await createTiersAndDivisionsFor(seasonId, configs);
  await prisma.tierTemplate.upsert({
    where: { name: LAST_USED_NAME },
    create: { name: LAST_USED_NAME, config: JSON.stringify(configs), isLastUsed: true },
    update: { config: JSON.stringify(configs), isLastUsed: true },
  });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.configure-tiers",
    targetType: "Season",
    targetId: seasonId,
    summary: `Configured ${configs.length} tier(s) (${configs.reduce((s, c) => s + c.divisionCount, 0)} divisions)`,
    metadata: { tiers: configs.map((c) => ({ name: c.name, divisionCount: c.divisionCount })) },
  });
  revalidatePath("/admin/seasons");
}

export async function activateSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await performSeasonActivation(id, actorFromAdminUser(user), "manual");
  revalidatePath("/admin/seasons");
}

// Shared core of season activation, callable from:
//   - activateSeason (admin clicked the button — manual source)
//   - the match-sweep scheduledStartAt cron (scheduled source)
// Flips isActive, deactivates any prior active season, clears
// scheduledStartAt on the target (so the cron doesn't re-fire), posts
// to the announcements channel if configured, audits the action.
export async function performSeasonActivation(
  seasonId: string,
  actor: AuditActor,
  source: "manual" | "scheduled",
): Promise<void> {
  const target = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!target) return;
  if (target.isActive) return; // idempotent — scheduled cron may race the manual button
  const prior = await prisma.season.findFirst({
    where: { isActive: true, NOT: { id: seasonId } },
  });
  if (prior) {
    await prisma.season.update({
      where: { id: prior.id },
      data: { isActive: false, endedAt: new Date() },
    });
  }
  await prisma.season.update({
    where: { id: seasonId },
    data: { isActive: true, endedAt: null, scheduledStartAt: null },
  });
  recordAudit({
    actor,
    action: source === "scheduled" ? "season.activate-scheduled" : "season.activate",
    targetType: "Season",
    targetId: seasonId,
    summary: `Activated season "${formatSeasonLabel(target)}"${prior ? ` (deactivated "${formatSeasonLabel(prior)}")` : ""}${source === "scheduled" ? " — auto-triggered by scheduledStartAt" : ""}`,
    metadata: { previousActiveSeasonId: prior?.id ?? null, source },
  });
  // Auto-bootstrap Discord (per-division roles + channels). Idempotent —
  // skips divisions that already have role + channel IDs. Best-effort:
  // if the guild config is missing or the enqueue fails, the activation
  // still succeeds and admin can re-run via the season detail page.
  await runSeasonDiscordBootstrap(seasonId).catch((err) =>
    console.warn("[season.activate] Discord bootstrap enqueue failed:", err),
  );

  // Best-effort announcement. Fire even when no channel is configured —
  // the call short-circuits cleanly without failing activation.
  await postSeasonStartAnnouncement(target.id, formatSeasonLabel(target)).catch((err) =>
    console.warn("[season.activate] announcement post failed:", err),
  );
}

// Post a "season is now live" message to the configured announcements
// channel. No-op when the LeagueConfig key isn't set — the admin can
// post manually in that case.
async function postSeasonStartAnnouncement(seasonId: string, seasonLabel: string): Promise<void> {
  void seasonId;
  const row = await prisma.leagueConfig.findUnique({
    where: { key: "announcements_channel_id" },
    select: { value: true },
  });
  const channelId = row?.value ?? null;
  if (!channelId) return;
  const content = `🃏 **${seasonLabel}** is now live! Standings, /start-match, and /report are all active. Good luck.`;
  await postChannelMessage(channelId, { content });
}

// Schedule an automatic activation at the given timestamp. Admin can
// edit or clear this any time before it fires (the worker just polls
// scheduledStartAt). Refuses on already-active or already-ended
// seasons since the field is meaningless once activation has happened.
export async function setSeasonScheduledStart(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const whenStr = String(formData.get("scheduledStartAt") ?? "").trim();
  if (!id || !whenStr) return;
  const target = await prisma.season.findUnique({ where: { id } });
  if (!target) return;
  if (target.isActive || target.endedAt) {
    redirect(
      `/seasons/${id}?err=${encodeURIComponent(
        "Can't schedule a start for an already-active or ended season.",
      )}`,
    );
  }
  // datetime-local input — parse as local time (no Z suffix).
  const when = new Date(whenStr);
  if (Number.isNaN(when.getTime())) {
    redirect(`/seasons/${id}?err=${encodeURIComponent("Invalid date/time.")}`);
  }
  await prisma.season.update({ where: { id }, data: { scheduledStartAt: when } });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.schedule-start",
    targetType: "Season",
    targetId: id,
    summary: `Scheduled "${formatSeasonLabel(target)}" to auto-start ${when.toISOString()}`,
    metadata: { scheduledStartAt: when.toISOString() },
  });
  revalidatePath(`/seasons/${id}`);
  revalidatePath("/admin/seasons");
}

export async function clearSeasonScheduledStart(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const target = await prisma.season.findUnique({ where: { id } });
  if (!target || !target.scheduledStartAt) return;
  await prisma.season.update({ where: { id }, data: { scheduledStartAt: null } });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.clear-scheduled-start",
    targetType: "Season",
    targetId: id,
    summary: `Cleared scheduled start for "${formatSeasonLabel(target)}"`,
    metadata: { previousScheduledStartAt: target.scheduledStartAt.toISOString() },
  });
  revalidatePath(`/seasons/${id}`);
  revalidatePath("/admin/seasons");
}

export async function saveTemplate(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("templateName") ?? "").trim();
  const configJson = String(formData.get("config") ?? "");
  // When `id` is present we're editing an existing template — let
  // admin rename in place by updating both name and config. When
  // absent we treat it as create-or-update-by-name (upsert).
  const id = String(formData.get("id") ?? "").trim();
  if (!name) return;
  const configs = parseConfig(configJson);
  if (configs.length === 0) return;
  if (id) {
    await prisma.tierTemplate.update({
      where: { id },
      data: { name, config: JSON.stringify(configs) },
    });
  } else {
    await prisma.tierTemplate.upsert({
      where: { name },
      create: { name, config: JSON.stringify(configs), isLastUsed: false },
      update: { config: JSON.stringify(configs) },
    });
  }
  revalidatePath("/admin/seasons");
  revalidatePath("/admin/seasons/templates");
}

export async function deleteTemplate(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await prisma.tierTemplate.delete({ where: { id } });
  revalidatePath("/admin/seasons/templates");
}

// End a season: compute new ratings from final standings, write them back
// to Players, snapshot each member's final global rank onto their
// DivisionMember row, mark Season inactive + endedAt now.
//
// Refuses to run if endedAt is already set — re-running endSeason on an
// old season would rewrite every player's Player.rating from that older
// snapshot, which is almost never what the admin wants. Use
// unendSeason() to clear endedAt explicitly first if you really need to
// recompute (e.g., a result was corrected post-end and you want to redo).
export async function endSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const season = await prisma.season.findUnique({
    where: { id },
    include: {
      tiers: { orderBy: { position: "asc" } },
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        include: {
          tier: true,
          members: {
            include: { player: true },
          },
          pairings: { where: { status: "CONFIRMED" } },
        },
      },
    },
  });
  if (!season) return;

  // Double-end guard. If you genuinely need to recompute, hit unend
  // first — that gives you an explicit audit trail of the intent.
  if (season.endedAt) {
    const dateStr = season.endedAt.toISOString().slice(0, 10);
    redirect(
      `/admin/seasons?err=${encodeURIComponent(
        `${formatSeasonLabel(season)} already ended on ${dateStr}. Unend it first if you really mean to recompute ratings.`,
      )}`,
    );
  }

  const divisionsForRating: DivisionForRating[] = season.divisions.map((d) => {
    const players = d.members.map((m) => m.player);
    return {
      tierPosition: d.tier.position,
      divisionGroupNumber: d.groupNumber,
      members: d.members.map((m) => ({
        playerId: m.playerId,
        status: m.status,
        currentRating: m.player.rating,
      })),
      standings: computeStandings(players, d.pairings),
    };
  });

  const numTiers = season.tiers.length;
  const deltas = computeRatingDeltas(numTiers, divisionsForRating);

  // Build a lookup from playerId → newRating so we can snapshot each
  // ACTIVE member's finalGlobalRank in the same transaction as the
  // Player.rating updates. DROPPED members are not in the deltas list
  // (computeRatingDeltas skips them), so they get null finalGlobalRank
  // — accurate, since they didn't actually finish the season.
  const newRatingByPlayer = new Map(deltas.map((d) => [d.playerId, d.newRating]));

  // Apply rating updates in a single transaction so partial failure doesn't
  // leave the league half-rated.
  await prisma.$transaction([
    ...deltas.map((d) =>
      prisma.player.update({
        where: { id: d.playerId },
        data: { rating: d.newRating },
      }),
    ),
    ...Array.from(newRatingByPlayer.entries()).map(([playerId, rank]) =>
      prisma.divisionMember.updateMany({
        where: { seasonId: season.id, playerId, status: "ACTIVE" },
        data: { finalGlobalRank: rank },
      }),
    ),
    prisma.season.update({
      where: { id: season.id },
      data: { isActive: false, endedAt: new Date() },
    }),
  ]);
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.end",
    targetType: "Season",
    targetId: season.id,
    summary: `Ended season "${formatSeasonLabel(season)}" (${season.divisions.length} divisions, ${deltas.length} rating updates)`,
    metadata: { divisionCount: season.divisions.length, ratingUpdateCount: deltas.length },
  });

  revalidatePath("/admin/seasons");
  revalidatePath("/admin/players");
  redirect("/admin/seasons");
}

// Clear endedAt on a season so endSeason can be re-run. Does NOT touch
// Player.rating or DivisionMember.finalGlobalRank — those stay until
// the next endSeason rewrites them. Audit-logged so you can always
// trace why a season got reopened.
export async function unendSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const season = await prisma.season.findUnique({ where: { id } });
  if (!season || !season.endedAt) return;
  await prisma.season.update({ where: { id }, data: { endedAt: null } });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.unend",
    targetType: "Season",
    targetId: id,
    summary: `Unended season "${formatSeasonLabel(season)}" (cleared endedAt; ratings/finalGlobalRank untouched)`,
    metadata: { previousEndedAt: season.endedAt.toISOString() },
  });
  revalidatePath("/admin/seasons");
}

function buildSignupPayload(round: { id: string; name: string }): {
  embeds: MessageEmbed[];
  components: ComponentActionRow[];
} {
  // Public embed surfaces COUNT only — roster lives behind admin auth
  // on /admin/signups/[id]/build. See signupEmbed() on the bot side
  // for the matching live-update format.
  const embed: MessageEmbed = {
    title: `🃏  ${round.name}`,
    description: "Click below to register. Withdraw anytime before sign-ups close.",
    fields: [{ name: "Status", value: "**0 signed up**", inline: false }],
    color: 0x5865f2,
    footer: { text: `Round ${round.id}` },
  };
  const row: ComponentActionRow = {
    type: 1,
    components: [
      { type: 2, custom_id: `signup:join:${round.id}`, style: 3, label: "Sign Up" },
      { type: 2, custom_id: `signup:withdraw:${round.id}`, style: 2, label: "Withdraw" },
    ],
  };
  return { embeds: [embed], components: [row] };
}

// Mirrors the bot's signup-embed for the CLOSED state — buttons disabled,
// status text updated, embed color grey.
function buildClosedSignupPayload(
  round: { id: string; name: string },
  signups: Array<{ discordId: string }>,
): { embeds: MessageEmbed[]; components: ComponentActionRow[] } {
  const embed: MessageEmbed = {
    title: `🃏  ${round.name}`,
    description: "Sign-ups are closed.",
    fields: [
      { name: "Status", value: `**${signups.length} signed up — sign-ups closed**`, inline: false },
    ],
    color: 0x99aab5,
    footer: { text: `Round ${round.id}` },
  };
  const row: ComponentActionRow = {
    type: 1,
    components: [
      { type: 2, custom_id: `signup:join:${round.id}`, style: 3, label: "Sign Up", disabled: true },
      { type: 2, custom_id: `signup:withdraw:${round.id}`, style: 2, label: "Withdraw", disabled: true },
    ],
  };
  return { embeds: [embed], components: [row] };
}

// Open a signup round bound to a specific season. The round's
// resultingSeasonId is set immediately so the build step (later) populates
// THIS season's existing divisions instead of creating a new one.
export async function openSignupsForSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  const channelId = String(formData.get("channelId") ?? "").trim();
  if (!seasonId || !channelId) redirect("/admin/seasons?err=missing-fields");

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) redirect("/admin/seasons?err=no-guild-id");

  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) redirect("/admin/seasons?err=season-not-found");

  const seasonLabel = formatSeasonLabel(season!);
  const round = await prisma.signupRound.create({
    data: {
      name: `${seasonLabel} Signups`,
      guildId,
      channelId,
      messageId: "pending",
      resultingSeasonId: season!.id,
      status: "OPEN",
    },
  });

  const messageId = await postChannelMessage(channelId, buildSignupPayload(round));
  if (!messageId) {
    await prisma.signupRound.delete({ where: { id: round.id } });
    redirect("/admin/seasons?err=signup-post-failed");
  }
  await prisma.signupRound.update({ where: { id: round.id }, data: { messageId } });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "signup-round.open",
    targetType: "SignupRound",
    targetId: round.id,
    summary: `Opened signups for "${seasonLabel}"`,
    metadata: { seasonId: season!.id, channelId },
  });

  // Fire-and-forget: DM everyone on the next-season interest list so they
  // know signups just opened. Don't block the admin form on this.
  notifyNextSeasonSubscribers(seasonLabel, channelId).catch((err) =>
    console.warn("notifyNextSeasonSubscribers failed:", err),
  );

  revalidatePath("/admin/seasons");
}

// Enqueue one DM per subscriber. The bot's pg-boss worker drains them
// asynchronously, retrying failures and surviving crashes — so opening
// signups never blocks on N round-trips to Discord and we don't lose
// the blast mid-flight if the web service restarts.
async function notifyNextSeasonSubscribers(seasonName: string, signupChannelId: string) {
  const subscribers = await prisma.seasonInterest.findMany();
  if (subscribers.length === 0) return;
  const invite = await createChannelInvite(signupChannelId, { maxAge: 0, maxUses: 0 });
  const inviteLine = invite ? `\nJoin the server here if you're not already: ${invite}` : "";
  const content =
    `🃏 **${seasonName}** signups just opened! Head to the signups channel and hit Sign Up to lock your spot.${inviteLine}\n\n` +
    `_You're getting this because you opted in to next-season notifications. Turn it off on your /me page anytime._`;
  await Promise.all(
    subscribers.map((s) =>
      enqueueDm({ discordId: s.discordId, content }).catch((err) =>
        console.warn(`[next-season-dm] enqueue failed for ${s.discordId}:`, err),
      ),
    ),
  );
  console.log(`[next-season-dm] queued ${subscribers.length} DMs`);
}

// Close (finalize) the signup round linked to a season AND update the
// Discord message so players see the closed-state embed (buttons disabled,
// status updated). Previously only the DB was updated.
export async function finalizeSignupsForSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  if (!seasonId) return;
  const round = await prisma.signupRound.findFirst({
    where: { resultingSeasonId: seasonId, status: "OPEN" },
    include: { signups: { where: { withdrawn: false }, orderBy: { signedUpAt: "asc" } } },
  });
  if (!round) return;
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { number: true, subtitle: true },
  });
  await prisma.signupRound.update({
    where: { id: round.id },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  // Update the Discord message in place
  if (round.messageId && round.messageId !== "pending") {
    const payload = buildClosedSignupPayload(round, round.signups);
    await editChannelMessage(round.channelId, round.messageId, payload);
  }
  // Capture each signed-up player's current balatromp.com MMR for seeding.
  // Tied to the season so admin can compare snapshot-at-signup vs current
  // when promo/relegation runs at end of season.
  await Promise.all(
    round.signups.map((s) =>
      enqueueMmrSnapshot({ discordId: s.discordId, seasonId }).catch((err) =>
        console.warn(`[mmr-snapshot] enqueue failed for ${s.discordId}:`, err),
      ),
    ),
  );
  console.log(`[mmr-snapshot] queued ${round.signups.length} snapshots for season ${seasonId}`);

  // Confirmation DMs: every signed-up player gets a "you're locked in"
  // ping so they don't have to refresh the channel to see they made it.
  // Tells them the next thing they're waiting for (division assignment).
  // Fire via enqueueDm so pg-boss retries failures + survives crashes.
  if (season) {
    const seasonLabel = formatSeasonLabel(season);
    const content =
      `🃏 **${seasonLabel}** signups are now closed — you're locked in!\n\n` +
      `Next up: the league admin will sort everyone into divisions based on rating + signup count. ` +
      `You'll get a Discord role + a private channel for your division once that's done.\n\n` +
      `Match the players in the channel best-of-2 sets at your own pace. ` +
      `_Withdraw later_? Talk to a league helper in your division channel after divisions are built.`;
    await Promise.all(
      round.signups.map((s) =>
        enqueueDm({ discordId: s.discordId, content }).catch((err) =>
          console.warn(`[signup-confirm-dm] enqueue failed for ${s.discordId}:`, err),
        ),
      ),
    );
    console.log(`[signup-confirm-dm] queued ${round.signups.length} confirmations for season ${seasonId}`);
  }

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "signup-round.close",
    targetType: "SignupRound",
    targetId: round.id,
    summary: `Closed signups for season (${round.signups.length} signed up)`,
    metadata: { seasonId, signupCount: round.signups.length },
  });
  revalidatePath("/admin/seasons");
  revalidatePath("/admin/signups");
}

export async function archiveSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const season = await prisma.season.findUnique({ where: { id } });
  await prisma.season.update({ where: { id }, data: { archivedAt: new Date() } });
  if (season) {
    recordAudit({
      actor: actorFromAdminUser(user),
      action: "season.archive",
      targetType: "Season",
      targetId: id,
      summary: `Archived season "${formatSeasonLabel(season)}"`,
    });
  }
  revalidatePath("/admin/seasons");
  revalidatePath("/seasons");
}

export async function unarchiveSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const season = await prisma.season.findUnique({ where: { id } });
  await prisma.season.update({ where: { id }, data: { archivedAt: null } });
  if (season) {
    recordAudit({
      actor: actorFromAdminUser(user),
      action: "season.unarchive",
      targetType: "Season",
      targetId: id,
      summary: `Unarchived season "${formatSeasonLabel(season)}"`,
    });
  }
  revalidatePath("/admin/seasons");
  revalidatePath("/seasons");
}

export async function renameSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  // Renaming a season now means editing the optional subtitle — the
  // sequential `Season {number}` prefix is immutable.
  const subtitleRaw = String(formData.get("subtitle") ?? "").trim();
  const subtitle = subtitleRaw.length > 0 ? subtitleRaw : null;
  if (!id) return;
  const prev = await prisma.season.findUnique({ where: { id } });
  await prisma.season.update({ where: { id }, data: { subtitle } });
  if (prev) {
    const next = { number: prev.number, subtitle };
    recordAudit({
      actor: actorFromAdminUser(user),
      action: "season.rename",
      targetType: "Season",
      targetId: id,
      summary: `Renamed "${formatSeasonLabel(prev)}" → "${formatSeasonLabel(next)}"`,
      metadata: { previousSubtitle: prev.subtitle, newSubtitle: subtitle },
    });
  }
  revalidatePath("/admin/seasons");
}

// Delete a season entirely. Cascade handles Tier/Division/DivisionMember/
// Pairing via the schema relations. SignupRound.resultingSeasonId is a bare
// string (not a relation), so we manually clear any rounds pointing here
// before deleting so they don't end up referencing a non-existent season.
export async function deleteSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (!id) return;
  const season = await prisma.season.findUnique({ where: { id } });
  if (!season) return;
  // Require typing the season label (e.g. "Season 4") to confirm — protects
  // against fat-fingering.
  const seasonLabel = formatSeasonLabel(season);
  if (confirm.trim() !== seasonLabel.trim()) {
    redirect(`/admin/seasons?err=${encodeURIComponent("Confirmation didn't match — season not deleted.")}`);
  }
  await prisma.signupRound.updateMany({
    where: { resultingSeasonId: id },
    data: { resultingSeasonId: null },
  });
  await prisma.season.delete({ where: { id } });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.delete",
    targetType: "Season",
    targetId: id,
    summary: `Deleted season "${seasonLabel}"`,
    metadata: { number: season.number, subtitle: season.subtitle, wasActive: season.isActive, endedAt: season.endedAt?.toISOString() ?? null },
  });
  revalidatePath("/admin/seasons");
  redirect("/admin/seasons");
}

// Move one player from their current division (in this season) to a target
// division. Wraps placePlayerInDivision so the transfer semantics + Discord
// role bookkeeping are handled the same way as the bulk-import / add-by-id
// flows. Used by the draft review UI on the season detail page.
// Late add: resolve a Discord ID to a Player (upserting if needed) and
// drop them into a specific division. Used by the per-division
// "+ Add player" form in draft mode so admin can pull in late signups
// without leaving the season detail page. Idempotent — re-adding a
// player who's already in the division is a no-op (moves them within
// the season otherwise).
export async function addLatePlayerToDivision(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "").trim();
  const discordIdRaw = String(formData.get("discordId") ?? "").trim();
  if (!divisionId || !discordIdRaw) return;

  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    select: { id: true, name: true, seasonId: true },
  });
  if (!division) {
    redirect(`/admin/seasons?err=${encodeURIComponent("Division not found")}`);
  }

  const guildId = process.env.DISCORD_GUILD_ID;
  let displayName = discordIdRaw;
  if (guildId) {
    const { resolveDiscordIdToDisplayName } = await import("@/lib/add-player");
    const resolved = await resolveDiscordIdToDisplayName(guildId, discordIdRaw);
    if ("error" in resolved) {
      redirect(`/seasons/${division!.seasonId}?err=${encodeURIComponent(resolved.error)}`);
    }
    displayName = resolved.displayName;
  }

  const player = await prisma.player.upsert({
    where: { discordId: discordIdRaw },
    create: { discordId: discordIdRaw, displayName },
    update: { displayName },
  });
  const { placePlayerInDivision } = await import("@/lib/division-membership");
  await placePlayerInDivision(division!.id, player.id);
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "division.add-late-player",
    targetType: "DivisionMember",
    targetId: player.id,
    summary: `Added ${displayName} to ${division!.name} (late signup)`,
    metadata: { seasonId: division!.seasonId, divisionId: division!.id, discordId: discordIdRaw },
  });
  revalidatePath(`/seasons/${division!.seasonId}`);
}

// Drop-anywhere positional move: dragged a player to a specific row
// index in a target division (cross-division OR within-division
// reorder). The simpler moveDivisionMember just appends to the end —
// this one rewrites every member's draftOrder in the target division
// to reflect the new sequence.
//
// Refuses on active/ended seasons — draft ordering doesn't matter
// once play has started, and we don't want to surprise admins by
// accepting moves whose effect would be silently invisible.
export async function moveDivisionMemberToPosition(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  const targetDivisionId = String(formData.get("targetDivisionId") ?? "");
  const targetIndexRaw = parseInt(String(formData.get("targetIndex") ?? ""), 10);
  if (!seasonId || !playerId || !targetDivisionId || Number.isNaN(targetIndexRaw)) return;

  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { id: true, isActive: true, endedAt: true },
  });
  if (!season) redirect("/admin/seasons?err=season-not-found");
  if (season!.isActive || season!.endedAt) {
    redirect(`/seasons/${seasonId}?err=${encodeURIComponent("Can't reorder players in an active or ended season — only during draft.")}`);
  }

  const targetDivision = await prisma.division.findUnique({
    where: { id: targetDivisionId },
    select: { id: true, seasonId: true, name: true, discordRoleId: true },
  });
  if (!targetDivision || targetDivision.seasonId !== seasonId) return;

  const moving = await prisma.divisionMember.findFirst({
    where: { playerId, division: { seasonId } },
    include: {
      division: { select: { id: true, name: true, discordRoleId: true } },
      player: { select: { id: true, discordId: true, displayName: true } },
    },
  });
  if (!moving) return;

  const isCrossDivision = moving.divisionId !== targetDivision.id;

  // Snapshot current target-division order (excluding the moving
  // member if it lives here today) so we can splice cleanly.
  const targetMembers = await prisma.divisionMember.findMany({
    where: { divisionId: targetDivision.id },
    orderBy: [{ draftOrder: "asc" }, { joinedAt: "asc" }],
    select: { id: true, playerId: true },
  });
  const filtered = targetMembers.filter((m) => m.playerId !== playerId);
  const insertAt = Math.max(0, Math.min(targetIndexRaw, filtered.length));

  // Rebuild the new order as a list of memberIds. If cross-division,
  // we don't have a target-member id for the moving player yet —
  // upsert below will resolve that. Track it by playerId for the
  // post-upsert pass that writes draftOrder.
  const newOrderPlayerIds = [
    ...filtered.slice(0, insertAt).map((m) => m.playerId),
    playerId,
    ...filtered.slice(insertAt).map((m) => m.playerId),
  ];

  // Cross-division Discord role bookkeeping (only when actually
  // changing divisions). Same shape as placePlayerInDivision but
  // inlined so the entire move runs in one transaction below.
  let previousRoleRemoved = false;
  if (isCrossDivision) {
    const guildId = process.env.DISCORD_GUILD_ID;
    if (guildId && moving.division.discordRoleId) {
      const { removeGuildMemberRole } = await import("@/lib/discord");
      previousRoleRemoved = await removeGuildMemberRole(
        guildId,
        moving.player.discordId,
        moving.division.discordRoleId,
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    if (isCrossDivision) {
      // Move the membership row across divisions. We can't simply
      // update divisionId because of the (divisionId, playerId)
      // unique constraint colliding if a stale row exists — defensively
      // delete+create-or-update to match placePlayerInDivision semantics.
      await tx.divisionMember.delete({ where: { id: moving.id } });
      await tx.divisionMember.upsert({
        where: { divisionId_playerId: { divisionId: targetDivision.id, playerId } },
        create: {
          divisionId: targetDivision.id,
          seasonId,
          playerId,
          status: "ACTIVE",
          draftOrder: insertAt,
        },
        update: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
      });
    }
    // Rewrite draftOrder for every member of the target division so
    // the resulting sequence matches newOrderPlayerIds exactly.
    for (let i = 0; i < newOrderPlayerIds.length; i++) {
      const pid = newOrderPlayerIds[i]!;
      await tx.divisionMember.updateMany({
        where: { divisionId: targetDivision.id, playerId: pid },
        data: { draftOrder: i },
      });
    }
  });

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "division.move-to-position",
    targetType: "DivisionMember",
    targetId: playerId,
    summary: isCrossDivision
      ? `Moved ${moving.player.displayName} → ${targetDivision.name} @ #${insertAt + 1} (from ${moving.division.name})`
      : `Reordered ${moving.player.displayName} within ${targetDivision.name} → #${insertAt + 1}`,
    metadata: {
      seasonId,
      playerId,
      fromDivisionId: moving.division.id,
      toDivisionId: targetDivision.id,
      targetIndex: insertAt,
      crossDivision: isCrossDivision,
      previousRoleRemoved,
    },
  });

  revalidatePath(`/seasons/${seasonId}`);
}

export async function moveDivisionMember(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  const targetDivisionId = String(formData.get("targetDivisionId") ?? "");
  if (!seasonId || !playerId || !targetDivisionId) return;
  // Belt-and-suspenders: confirm the target division actually belongs to
  // this season. Prevents accidental cross-season transfers via crafted
  // form posts.
  const target = await prisma.division.findUnique({
    where: { id: targetDivisionId },
    select: { seasonId: true, name: true },
  });
  if (!target || target.seasonId !== seasonId) return;
  const fromMember = await prisma.divisionMember.findFirst({
    where: { playerId, division: { seasonId } },
    include: { division: { select: { id: true, name: true } }, player: { select: { displayName: true } } },
  });
  const { placePlayerInDivision } = await import("@/lib/division-membership");
  await placePlayerInDivision(targetDivisionId, playerId);
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "division.move-member",
    targetType: "DivisionMember",
    targetId: playerId,
    summary: `Moved ${fromMember?.player.displayName ?? "player"} → ${target.name}${fromMember ? ` (from ${fromMember.division.name})` : ""}`,
    metadata: { seasonId, playerId, fromDivisionId: fromMember?.division.id ?? null, toDivisionId: targetDivisionId },
  });
  revalidatePath(`/seasons/${seasonId}`);
}

export async function setSeasonPreset(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const presetIdRaw = String(formData.get("presetId") ?? "");
  if (!id) return;
  // Empty string from the "— Use Default —" option means clear the FK.
  const matchConfigPresetId = presetIdRaw === "" ? null : presetIdRaw;
  const prev = await prisma.season.findUnique({
    where: { id },
    select: { number: true, subtitle: true, matchConfigPresetId: true, matchConfigPreset: { select: { name: true } } },
  });
  await prisma.season.update({ where: { id }, data: { matchConfigPresetId } });
  if (prev) {
    let nextName = "Default";
    if (matchConfigPresetId) {
      const next = await prisma.matchConfigPreset.findUnique({ where: { id: matchConfigPresetId }, select: { name: true } });
      nextName = next?.name ?? matchConfigPresetId;
    }
    recordAudit({
      actor: actorFromAdminUser(user),
      action: "season.set-preset",
      targetType: "Season",
      targetId: id,
      summary: `"${formatSeasonLabel(prev)}" preset: ${prev.matchConfigPreset?.name ?? "Default"} → ${nextName}`,
      metadata: { previousPresetId: prev.matchConfigPresetId, nextPresetId: matchConfigPresetId },
    });
  }
  revalidatePath("/admin/seasons");
}

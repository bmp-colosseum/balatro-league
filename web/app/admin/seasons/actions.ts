"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
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
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  // Tier config is now OPTIONAL — admin can skip setup and configure tiers
  // later once they see how many players signed up.
  const configs = parseConfig(String(formData.get("config") ?? ""));

  let deadline: Date | null = null;
  const deadlineStr = String(formData.get("deadline") ?? "");
  if (deadlineStr) {
    const d = new Date(deadlineStr + "Z");
    if (!Number.isNaN(d.getTime())) deadline = d;
  }

  const targetGroupSize = Math.max(2, parseInt(String(formData.get("targetGroupSize")), 10) || 5);
  const minGroupSize = Math.max(2, parseInt(String(formData.get("minGroupSize")), 10) || 3);
  const visibility = formData.get("visibility") === "INTERNAL" ? "INTERNAL" : "PUBLIC";

  const season = await prisma.season.create({
    data: { name, deadline, isActive: false, targetGroupSize, minGroupSize, visibility },
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
    summary: `Created season "${season.name}"`,
    metadata: { visibility, targetGroupSize, minGroupSize, tierCount: configs.length, deadline: deadline?.toISOString() ?? null },
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
    redirect(`/admin/seasons/${seasonId}?err=${encodeURIComponent("Can't add divisions to an active or ended season — only during draft.")}`);
  }
  const tier = await prisma.tier.findUnique({ where: { id: tierId } });
  if (!tier || tier.seasonId !== seasonId) {
    redirect(`/admin/seasons/${seasonId}?err=${encodeURIComponent("That tier isn't part of this season.")}`);
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
  revalidatePath(`/admin/seasons/${seasonId}`);
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
  const target = await prisma.season.findUnique({ where: { id } });
  if (!target) return;
  const prior = await prisma.season.findFirst({
    where: { isActive: true, visibility: target.visibility, NOT: { id } },
  });
  if (prior) {
    await prisma.season.update({
      where: { id: prior.id },
      data: { isActive: false, endedAt: new Date() },
    });
  }
  await prisma.season.update({ where: { id }, data: { isActive: true, endedAt: null } });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.activate",
    targetType: "Season",
    targetId: id,
    summary: `Activated season "${target.name}"${prior ? ` (deactivated "${prior.name}")` : ""}`,
    metadata: { previousActiveSeasonId: prior?.id ?? null, visibility: target.visibility },
  });
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

// End a season: compute new ratings from final standings, write them back to
// Players, mark Season inactive + endedAt now. Idempotent on the inactive
// flag — clicking on an already-inactive season is a no-op for the season
// state but still recomputes ratings.
export async function endSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const season = await prisma.season.findUnique({
    where: { id },
    include: {
      tiers: { orderBy: { position: "asc" } },
      divisions: {
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

  const divisionsForRating: DivisionForRating[] = season.divisions.map((d) => {
    const players = d.members.map((m) => m.player);
    return {
      tierPosition: d.tier.position,
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

  // Apply rating updates in a single transaction so partial failure doesn't
  // leave the league half-rated.
  await prisma.$transaction([
    ...deltas.map((d) =>
      prisma.player.update({
        where: { id: d.playerId },
        data: { rating: d.newRating },
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
    summary: `Ended season "${season.name}" (${season.divisions.length} divisions, ${deltas.length} rating updates)`,
    metadata: { divisionCount: season.divisions.length, ratingUpdateCount: deltas.length },
  });

  revalidatePath("/admin/seasons");
  revalidatePath("/admin/rankings");
  redirect("/admin/seasons");
}

function buildSignupPayload(round: { id: string; name: string }): {
  embeds: MessageEmbed[];
  components: ComponentActionRow[];
} {
  const embed: MessageEmbed = {
    title: `🃏  ${round.name}`,
    description: "Click below to register. Withdraw anytime before sign-ups close.",
    fields: [
      { name: "Status", value: "**0 signed up**", inline: false },
      { name: "Players", value: "_No one yet — be the first!_", inline: false },
    ],
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
  const playerList = signups.length
    ? signups.map((s, i) => `${i + 1}. <@${s.discordId}>`).join("\n")
    : "_No one signed up._";
  const embed: MessageEmbed = {
    title: `🃏  ${round.name}`,
    description: "Sign-ups are closed.",
    fields: [
      { name: "Status", value: `**${signups.length} signed up — sign-ups closed**`, inline: false },
      { name: "Players", value: playerList, inline: false },
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

  const round = await prisma.signupRound.create({
    data: {
      name: `${season!.name} Signups`,
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
    summary: `Opened signups for "${season!.name}"`,
    metadata: { seasonId: season!.id, channelId },
  });

  // Fire-and-forget: DM everyone on the next-season interest list so they
  // know signups just opened. Don't block the admin form on this.
  notifyNextSeasonSubscribers(season!.name, channelId).catch((err) =>
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
      summary: `Archived season "${season.name}"`,
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
      summary: `Unarchived season "${season.name}"`,
    });
  }
  revalidatePath("/admin/seasons");
  revalidatePath("/seasons");
}

export async function renameSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  const prev = await prisma.season.findUnique({ where: { id } });
  await prisma.season.update({ where: { id }, data: { name } });
  if (prev) {
    recordAudit({
      actor: actorFromAdminUser(user),
      action: "season.rename",
      targetType: "Season",
      targetId: id,
      summary: `Renamed "${prev.name}" → "${name}"`,
      metadata: { previousName: prev.name, newName: name },
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
  // Require typing the season name to confirm — protects against fat-fingering
  if (confirm.trim() !== season.name.trim()) {
    redirect(`/admin/seasons?err=${encodeURIComponent("Confirmation name didn't match — season not deleted.")}`);
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
    summary: `Deleted season "${season.name}"`,
    metadata: { name: season.name, visibility: season.visibility, wasActive: season.isActive, endedAt: season.endedAt?.toISOString() ?? null },
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
      redirect(`/admin/seasons/${division!.seasonId}?err=${encodeURIComponent(resolved.error)}`);
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
  revalidatePath(`/admin/seasons/${division!.seasonId}`);
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
  revalidatePath(`/admin/seasons/${seasonId}`);
}

export async function setSeasonVisibility(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const visibilityRaw = String(formData.get("visibility") ?? "");
  if (!id) return;
  const visibility = visibilityRaw === "INTERNAL" ? "INTERNAL" : "PUBLIC";
  const prev = await prisma.season.findUnique({ where: { id }, select: { name: true, visibility: true } });
  await prisma.season.update({ where: { id }, data: { visibility } });
  if (prev) {
    recordAudit({
      actor: actorFromAdminUser(user),
      action: "season.set-visibility",
      targetType: "Season",
      targetId: id,
      summary: `"${prev.name}" visibility: ${prev.visibility} → ${visibility}`,
      metadata: { previous: prev.visibility, next: visibility },
    });
  }
  revalidatePath("/admin/seasons");
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
    select: { name: true, matchConfigPresetId: true, matchConfigPreset: { select: { name: true } } },
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
      summary: `"${prev.name}" preset: ${prev.matchConfigPreset?.name ?? "Default"} → ${nextName}`,
      metadata: { previousPresetId: prev.matchConfigPresetId, nextPresetId: matchConfigPresetId },
    });
  }
  revalidatePath("/admin/seasons");
}

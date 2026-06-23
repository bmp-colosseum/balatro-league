"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { performSeasonActivation } from "@/lib/season-activation";
import { resyncSeasonSchedules } from "@/lib/schedule-sync";
import { lockDivisionSchedules, lockOneDivision } from "@/lib/lock-schedule";
import { getPlacementRules, setPlacementRules } from "@/lib/placement-rules";
import { formatSeasonLabel, formatDivisionName, nextSeasonNumber } from "@/lib/format-season";
import {
  editChannelMessage,
  fetchDiscordUser,
  fetchGuildMember,
  postChannelMessage,
} from "@/lib/discord";
import { enqueueLeagueInfoRefresh, enqueueMmrSnapshot, enqueueSignupAskKickoff, enqueueWelcomeRefresh } from "@/lib/queue";
import { buildSignupPayload, buildClosedSignupPayload, getSeasonLengthDays } from "@/lib/signup-discord";
import { endSeasonCore } from "@/lib/end-season";

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
  // Numbered: "<Tier> 1", "<Tier> 2", …
  return Array.from({ length: tier.divisionCount }, (_, i) => `${tier.name} ${i + 1}`);
}

export async function createSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const subtitleRaw = String(formData.get("subtitle") ?? "").trim();
  const subtitle = subtitleRaw.length > 0 ? subtitleRaw : null;

  const targetGroupSize = Math.max(2, parseInt(String(formData.get("targetGroupSize")), 10) || 5);
  const minGroupSize = Math.max(2, parseInt(String(formData.get("minGroupSize")), 10) || 3);

  // A season is created EMPTY — no tiers, no divisions. Tiers/divisions are
  // only built later, from the actual signups, after signups close. Keeping
  // tier setup out of creation avoids accidentally creating divisions
  // before anyone's signed up.
  const number = await nextSeasonNumber(prisma);
  const season = await prisma.season.create({
    data: { number, subtitle, isActive: false, targetGroupSize, minGroupSize },
  });

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.create",
    targetType: "Season",
    targetId: season.id,
    summary: `Created season "${formatSeasonLabel(season)}"`,
    metadata: { targetGroupSize, minGroupSize },
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
      _count: { select: { members: true, matches: true } },
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
        `"${division!.name}" still has ${division!._count.members} ${division!._count.members === 1 ? "member" : "members"}. Move them to other divisions first, then delete.`,
      )}`,
    );
  }
  // _count.pairings should be 0 in draft mode (no matches played yet),
  // but guard anyway — if somehow a pairing exists for this division
  // we refuse rather than orphan match history.
  if (division!._count.matches > 0) {
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

  const result = await endSeasonCore(id, actorFromAdminUser(user));

  // Double-end guard. If you genuinely need to recompute, hit unend
  // first — that gives you an explicit audit trail of the intent.
  if (result.status === "already-ended") {
    redirect(
      `/admin/seasons?err=${encodeURIComponent(
        `${result.seasonLabel} already ended. Use "Undo end" first if you really mean to recompute ratings.`,
      )}`,
    );
  }

  revalidatePath("/admin/seasons");
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

// Regenerate every division's display name in a season to the canonical
// "<Tier> A (1)" / "<Tier> 2" / "<Tier>" format (formatDivisionName). For
// seasons built before that format existed (or hand-renamed) — leaves the
// tiers + placements untouched, only rewrites Division.name.
export async function relabelDivisions(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  if (!seasonId) redirect("/admin/seasons?err=missing-fields");

  const tiers = await prisma.tier.findMany({
    where: { seasonId },
    select: { name: true, divisions: { select: { id: true, groupNumber: true, name: true } } },
  });

  let renamed = 0;
  for (const tier of tiers) {
    const count = tier.divisions.length;
    for (const d of tier.divisions) {
      const next = formatDivisionName(tier.name, d.groupNumber, count);
      if (next !== d.name) {
        await prisma.division.update({ where: { id: d.id }, data: { name: next } });
        renamed++;
      }
    }
  }

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.relabel-divisions",
    targetType: "Season",
    targetId: seasonId,
    summary: `Relabeled ${renamed} division(s) to canonical names`,
    metadata: { seasonId, renamed },
  });

  revalidatePath("/admin/seasons");
  revalidatePath(`/seasons/${seasonId}`);
  redirect(`/seasons/${seasonId}?ok=relabeled-${renamed}`);
}

// Manual escape hatch for the auto-repair: rebuild a locked season's pre-created
// schedule to match the current roster (prune matches orphaned by departed
// players, give everyone their target opponents). Roster actions already call
// this automatically; the button covers any path that didn't (e.g. a bot-side
// edit). No-op on unlocked seasons.
export async function resyncSchedules(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  if (!seasonId) redirect("/admin/divisions?err=missing-fields");

  const { pruned, created } = await resyncSeasonSchedules(seasonId);

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.resync-schedules",
    targetType: "Season",
    targetId: seasonId,
    summary: `Re-synced schedules: pruned ${pruned}, created ${created} match(es)`,
    metadata: { seasonId, pruned, created },
  });

  revalidatePath("/admin/divisions");
  redirect(`/admin/divisions?ok=resynced-${pruned}-${created}`);
}

// Wipe the pre-created schedule and rebuild it from scratch with the CURRENT
// placement rules + roster (e.g. after changing roundRobinTopDivisions, or adding
// players). Only safe BEFORE any games are played/reported — guarded so it refuses
// once a single LEAGUE_BO2 match has a result. Unlike resync (which patches), this
// regenerates the SoS-balanced graph cleanly, so everyone gets an even slate.
export async function regenerateSchedules(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  if (!seasonId) redirect("/admin/divisions?err=missing-fields");

  const touched = await prisma.match.count({
    where: {
      division: { seasonId },
      format: "LEAGUE_BO2",
      OR: [{ status: { not: "PENDING" } }, { gamesWonA: { gt: 0 } }, { gamesWonB: { gt: 0 } }],
    },
  });
  if (touched > 0) {
    redirect("/admin/divisions?err=games-already-played");
  }

  const deleted = await prisma.match.deleteMany({ where: { division: { seasonId }, format: "LEAGUE_BO2" } });
  const { created, divisions } = await lockDivisionSchedules(seasonId);
  // Refresh the division welcome messages (rosters/formats updated) — silent.
  await enqueueWelcomeRefresh(seasonId).catch(() => {});

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.regenerate-schedules",
    targetType: "Season",
    targetId: seasonId,
    summary: `Regenerated schedules: cleared ${deleted.count}, created ${created} match(es) across ${divisions} division(s)`,
    metadata: { seasonId, cleared: deleted.count, created, divisions },
  });

  revalidatePath("/admin/divisions");
  redirect(`/admin/divisions?ok=regenerated-${created}`);
}

// Regenerate ONE division's schedule with the current rules + roster, leaving
// every other division untouched. Same no-games guard, scoped to this division.
export async function regenerateDivisionSchedule(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  if (!divisionId) redirect("/admin/divisions?err=missing-fields");

  const touched = await prisma.match.count({
    where: {
      divisionId,
      format: "LEAGUE_BO2",
      OR: [{ status: { not: "PENDING" } }, { gamesWonA: { gt: 0 } }, { gamesWonB: { gt: 0 } }],
    },
  });
  if (touched > 0) {
    redirect("/admin/divisions?err=games-already-played");
  }

  const deleted = await prisma.match.deleteMany({ where: { divisionId, format: "LEAGUE_BO2" } });
  const created = await lockOneDivision(divisionId);
  // Refresh the division welcome messages (rosters/formats updated) — silent.
  const div = await prisma.division.findUnique({ where: { id: divisionId }, select: { seasonId: true } });
  if (div) await enqueueWelcomeRefresh(div.seasonId).catch(() => {});

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "division.regenerate-schedule",
    targetType: "Division",
    targetId: divisionId,
    summary: `Regenerated one division's schedule: cleared ${deleted.count}, created ${created} match(es)`,
    metadata: { divisionId, cleared: deleted.count, created },
  });

  revalidatePath("/admin/divisions");
  redirect(`/admin/divisions?ok=regenerated-${created}`);
}

// Set ONE division's schedule format directly: round-robin (play everyone),
// 4-opponent graph, or default (fall back to the season's top-N rule). Pair with
// the per-division Regenerate to apply.
export async function setDivisionFormat(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const value = String(formData.get("roundRobin") ?? "");
  if (!divisionId) redirect("/admin/divisions?err=missing-fields");
  const roundRobin = value === "rr" ? true : value === "graph" ? false : null;

  const div = await prisma.division.findUnique({ where: { id: divisionId }, select: { name: true } });
  await prisma.division.update({ where: { id: divisionId }, data: { roundRobin } });

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "division.set-format",
    targetType: "Division",
    targetId: divisionId,
    summary: `Set ${div?.name ?? divisionId} format: ${roundRobin === null ? "default" : roundRobin ? "round-robin" : "4-opponent graph"}`,
    metadata: { divisionId, roundRobin },
  });

  revalidatePath("/admin/divisions");
  redirect("/admin/divisions?ok=format-saved");
}

// Set a division's promote + relegate counts INDEPENDENTLY: how many of its top
// finishers move up a division and how many of its bottom move down. These drive BOTH
// the /standings ↑/↓ zones AND the end-season rating reorder, so the zones are exactly
// who moves. (Top division's promote + bottom division's relegate are ignored.)
export async function setDivisionPromoteRelegate(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const clamp = (v: string) => Math.max(0, Math.min(20, Number.parseInt(v, 10) || 0));
  const promoteCount = clamp(String(formData.get("promote")));
  const relegateCount = clamp(String(formData.get("relegate")));
  if (!divisionId) redirect("/admin/divisions?err=missing-fields");

  const div = await prisma.division.findUnique({ where: { id: divisionId }, select: { name: true, promoteCount: true, relegateCount: true } });
  await prisma.division.update({ where: { id: divisionId }, data: { promoteCount, relegateCount } });

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "division.set-promote-relegate",
    targetType: "Division",
    targetId: divisionId,
    summary: `Set ${div?.name ?? divisionId} promote/relegate: ↑${div?.promoteCount ?? "?"}→${promoteCount} · ↓${div?.relegateCount ?? "?"}→${relegateCount}`,
    metadata: { divisionId, promoteCount, relegateCount },
  });

  revalidatePath("/admin/divisions");
  revalidatePath("/standings");
  redirect("/admin/divisions?ok=rules-saved");
}

// Set how many TOP divisions play a full round-robin (e.g. 1 = only Legendary;
// Rare 1 and below become 4-opponent graphs). Editable from /admin/divisions so
// it can be changed for a live (pre-kickoff) season; pair it with Regenerate.
export async function setRoundRobinTopDivisions(formData: FormData) {
  const { user } = await requireAdmin();
  const n = Number.parseInt(String(formData.get("roundRobinTopDivisions")), 10);
  if (!Number.isFinite(n) || n < 0) redirect("/admin/divisions?err=missing-fields");

  const current = await getPlacementRules();
  await setPlacementRules({ ...current, roundRobinTopDivisions: Math.max(0, n) }, user.discordId);

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "placement-rules.set-round-robin-top",
    targetType: "LeagueConfig",
    targetId: "placement_rules",
    summary: `Set round-robin top divisions: ${current.roundRobinTopDivisions} → ${Math.max(0, n)}`,
    metadata: { previous: current.roundRobinTopDivisions, next: Math.max(0, n) },
  });

  revalidatePath("/admin/divisions");
  redirect("/admin/divisions?ok=rules-saved");
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

  // Optional scheduled close time (datetime-local, interpreted as UTC on the
  // server). Stored + shown as a Discord timestamp; it's the withdraw deadline.
  const closesAtStr = String(formData.get("closesAt") ?? "").trim();
  const closesAtDate = closesAtStr ? new Date(closesAtStr) : null;
  const closesAt = closesAtDate && !Number.isNaN(closesAtDate.getTime()) ? closesAtDate : null;

  // Optional planned season window — display-only, shown in the signup post so
  // players know how long the season runs before committing.
  const parseDate = (key: string): Date | null => {
    const raw = String(formData.get(key) ?? "").trim();
    const d = raw ? new Date(raw) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  const seasonStartsAt = parseDate("seasonStartsAt");
  const seasonEndsAt = parseDate("seasonEndsAt");

  const seasonLabel = formatSeasonLabel(season!);
  const round = await prisma.signupRound.create({
    data: {
      name: `${seasonLabel} Signups`,
      guildId,
      channelId,
      messageId: "pending",
      resultingSeasonId: season!.id,
      status: "OPEN",
      closesAt,
      seasonStartsAt,
      seasonEndsAt,
    },
  });

  const messageId = await postChannelMessage(channelId, buildSignupPayload(round, 0, await getSeasonLengthDays()));
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

  // Kick off the interactive "are you in?" ask — DMs every past player (minus
  // opt-outs) + the 🔔 opt-in list with in/out buttons, then auto-reminds the
  // no-answers on a cadence until the round closes. The bot owns the fan-out.
  await enqueueSignupAskKickoff(round.id).catch((err) =>
    console.warn("[signups.open] ask-kickoff enqueue failed:", err),
  );

  // Refresh #league-info so the "Signups open" block appears.
  await enqueueLeagueInfoRefresh().catch((err) =>
    console.warn("[signups.open] league-info refresh enqueue failed:", err),
  );

  revalidatePath("/admin/seasons");
}

// Update the close time on an already-open signup round, and re-render the
// Discord signup post so the new deadline shows. Pass an empty value to clear
// the deadline (round stays open until manually finalized).
export async function updateSignupCloseDate(formData: FormData) {
  const { user } = await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) redirect("/admin/seasons?err=missing-fields");

  const closesAtStr = String(formData.get("closesAt") ?? "").trim();
  const closesAtDate = closesAtStr ? new Date(closesAtStr) : null;
  const closesAt = closesAtDate && !Number.isNaN(closesAtDate.getTime()) ? closesAtDate : null;

  const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
  if (!round) redirect("/admin/seasons?err=round-not-found");
  if (round!.status !== "OPEN") redirect("/admin/seasons?err=round-not-open");

  const updated = await prisma.signupRound.update({ where: { id: roundId }, data: { closesAt } });

  if (updated.messageId && updated.messageId !== "pending") {
    const signupCount = await prisma.signup.count({ where: { roundId } });
    await editChannelMessage(updated.channelId, updated.messageId, buildSignupPayload(updated, signupCount, await getSeasonLengthDays())).catch(
      (err) => console.warn("[signups.update-close] message edit failed:", err),
    );
  }

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "signup-round.update-close",
    targetType: "SignupRound",
    targetId: roundId,
    summary: closesAt ? `Updated signup close to ${closesAt.toISOString()}` : "Cleared signup close time",
    metadata: { roundId, closesAt: closesAt?.toISOString() ?? null },
  });

  await enqueueLeagueInfoRefresh().catch((err) =>
    console.warn("[signups.update-close] league-info refresh enqueue failed:", err),
  );
  revalidatePath("/admin/seasons");
  redirect("/admin/seasons?ok=close-updated");
}

// Set (or clear) the planned season window on an already-open round and
// re-render the Discord signup post so the "Season" line updates. Blank both
// fields to remove the window. Display-only — doesn't affect any scheduling.
export async function updateSeasonWindow(formData: FormData) {
  const { user } = await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) redirect("/admin/seasons?err=missing-fields");

  const parseDate = (key: string): Date | null => {
    const raw = String(formData.get(key) ?? "").trim();
    const d = raw ? new Date(raw) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  const seasonStartsAt = parseDate("seasonStartsAt");
  const seasonEndsAt = parseDate("seasonEndsAt");

  const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
  if (!round) redirect("/admin/seasons?err=round-not-found");
  if (round!.status !== "OPEN") redirect("/admin/seasons?err=round-not-open");

  const updated = await prisma.signupRound.update({
    where: { id: roundId },
    data: { seasonStartsAt, seasonEndsAt },
  });

  if (updated.messageId && updated.messageId !== "pending") {
    const signupCount = await prisma.signup.count({ where: { roundId } });
    await editChannelMessage(updated.channelId, updated.messageId, buildSignupPayload(updated, signupCount, await getSeasonLengthDays())).catch(
      (err) => console.warn("[signups.update-window] message edit failed:", err),
    );
  }

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "signup-round.update-window",
    targetType: "SignupRound",
    targetId: roundId,
    summary:
      seasonStartsAt && seasonEndsAt
        ? `Set season window ${seasonStartsAt.toISOString()} → ${seasonEndsAt.toISOString()}`
        : "Cleared season window",
    metadata: {
      roundId,
      seasonStartsAt: seasonStartsAt?.toISOString() ?? null,
      seasonEndsAt: seasonEndsAt?.toISOString() ?? null,
    },
  });

  revalidatePath("/admin/seasons");
  redirect("/admin/seasons?ok=window-updated");
}

// Re-pull each active signup's current Discord @username + global display name
// from the API and store them, so the admin roster reflects renames (and
// backfills global names captured before that column existed). Also re-checks
// Discord-server membership so the roster can flag anyone who left. REST
// throttling is handled by @discordjs/rest, so firing them together is safe.
export async function refreshSignupNames(formData: FormData) {
  const { user } = await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) redirect("/admin/seasons?err=missing-fields");

  const guildId = process.env.DISCORD_GUILD_ID;
  const signups = await prisma.signup.findMany({
    where: { roundId, withdrawn: false },
    select: { id: true, discordId: true },
  });

  const results = await Promise.all(
    signups.map(async (s) => {
      const u = await fetchDiscordUser(s.discordId);
      if (!u) return false;
      // Membership re-check. Leave inGuild unchanged when we have no guild id
      // rather than wrongly flag everyone as gone.
      const inGuild = guildId ? (await fetchGuildMember(guildId, s.discordId)) !== null : undefined;
      await prisma.signup.update({
        where: { id: s.id },
        data: {
          displayName: u.username,
          globalName: u.global_name ?? null,
          ...(inGuild === undefined ? {} : { inGuild }),
        },
      });
      return true;
    }),
  );
  const updated = results.filter(Boolean).length;

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "signup-round.refresh-names",
    targetType: "SignupRound",
    targetId: roundId,
    summary: `Refreshed ${updated}/${signups.length} signup names from Discord`,
    metadata: { roundId, total: signups.length, updated },
  });

  revalidatePath("/admin/seasons");
  redirect(`/admin/seasons?ok=names-refreshed-${updated}`);
}

// Close (finalize) the signup round linked to a season AND update the
// Discord message so players see the closed-state embed (buttons disabled,
// status updated). Previously only the DB was updated.
export async function finalizeSignupsForSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  if (!seasonId) return;
  // Close signups for whichever round is still accepting them — OPEN, or BUILT
  // (we deliberately keep accepting after a build). closedAt is the close signal;
  // we only flip status to CLOSED for an as-yet-unbuilt round so a BUILT season
  // keeps its build state.
  const round = await prisma.signupRound.findFirst({
    where: { resultingSeasonId: seasonId, closedAt: null, status: { in: ["OPEN", "BUILT"] } },
    include: { signups: { where: { withdrawn: false }, orderBy: { signedUpAt: "asc" } } },
  });
  if (!round) return;
  await prisma.signupRound.update({
    where: { id: round.id },
    data: { closedAt: new Date(), ...(round.status === "OPEN" ? { status: "CLOSED" as const } : {}) },
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

  // Refresh #league-info so the "Signups open" block disappears and
  // (if no other season is active) the "no season running" block returns.
  await enqueueLeagueInfoRefresh().catch((err) =>
    console.warn("[signups.close] league-info refresh enqueue failed:", err),
  );

  revalidatePath("/admin/seasons");
  revalidatePath("/admin/signups");
}

// Re-open signups closed via finalizeSignupsForSeason. Clears closedAt; only
// flips an unbuilt CLOSED round back to OPEN (a BUILT round keeps its build state
// — we just resume accepting signups).
export async function reopenSignupsForSeason(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  if (!seasonId) return;
  const round = await prisma.signupRound.findFirst({
    where: { resultingSeasonId: seasonId, closedAt: { not: null } },
    include: { signups: { where: { withdrawn: false } } },
  });
  if (!round) return;
  await prisma.signupRound.update({
    where: { id: round.id },
    data: { closedAt: null, ...(round.status === "CLOSED" ? { status: "OPEN" as const } : {}) },
  });
  if (round.messageId && round.messageId !== "pending") {
    await editChannelMessage(round.channelId, round.messageId, buildSignupPayload(round, round.signups.length, await getSeasonLengthDays())).catch(
      (err) => console.warn("[signups.reopen] Discord re-render failed:", err),
    );
  }
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "signup-round.reopen",
    targetType: "SignupRound",
    targetId: round.id,
    summary: `Reopened signups for season (${round.signups.length} signed up)`,
    metadata: { seasonId },
  });
  await enqueueLeagueInfoRefresh().catch((err) =>
    console.warn("[signups.reopen] league-info refresh enqueue failed:", err),
  );
  revalidatePath("/admin/seasons");
  revalidatePath(`/seasons/${seasonId}`);
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

// Add an EXISTING player (picked from the player list via search) to a
// division — no Discord-ID resolution, just place them by player id.
export async function addExistingPlayerToDivision(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "").trim();
  const playerId = String(formData.get("playerId") ?? "").trim();
  if (!divisionId || !playerId) return;

  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    select: { id: true, name: true, seasonId: true },
  });
  if (!division) redirect(`/admin/seasons?err=${encodeURIComponent("Division not found")}`);
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, displayName: true },
  });
  if (!player) redirect(`/seasons/${division!.seasonId}?err=${encodeURIComponent("Player not found")}`);

  const { placePlayerInDivision } = await import("@/lib/division-membership");
  await placePlayerInDivision(division!.id, player!.id);
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "division.add-existing-player",
    targetType: "DivisionMember",
    targetId: player!.id,
    summary: `Added existing player ${player!.displayName} to ${division!.name}`,
    metadata: { seasonId: division!.seasonId, divisionId: division!.id, playerId: player!.id },
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

// Set the symmetric promote/relegate count for a single tier. Drives
// the ↑/↓ markers on /standings only — end-season recompute is
// unaffected. Clamps the value to [0, 10] as a sanity guard.
export async function setTierPromoteRelegateCount(formData: FormData) {
  const { user } = await requireAdmin();
  const tierId = String(formData.get("tierId") ?? "");
  const raw = parseInt(String(formData.get("count") ?? ""), 10);
  if (!tierId || !Number.isFinite(raw)) return;
  const count = Math.min(10, Math.max(0, raw));
  const tier = await prisma.tier.findUnique({
    where: { id: tierId },
    select: { id: true, name: true, promoteRelegateCount: true, seasonId: true },
  });
  if (!tier) return;
  await prisma.tier.update({ where: { id: tierId }, data: { promoteRelegateCount: count } });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "tier.set-promote-relegate-count",
    targetType: "Tier",
    targetId: tierId,
    summary: `Set ${tier.name} promote/relegate count: ${tier.promoteRelegateCount} → ${count}`,
    metadata: { previous: tier.promoteRelegateCount, next: count },
  });
  revalidatePath(`/seasons/${tier.seasonId}`);
  revalidatePath("/standings");
}

// Set a player's hidden league MMR directly from the divisions editor, so an
// arranger can fix it in place without going to /admin/mmr. Blank clears it.
export async function setPlayerHiddenMmr(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  if (!playerId) return;
  const raw = String(formData.get("mmr") ?? "").trim();
  const value = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
  if (raw !== "" && !Number.isFinite(value)) return;
  await prisma.player.update({ where: { id: playerId }, data: { hiddenMmr: value } });
  revalidatePath("/admin/mmr");
}

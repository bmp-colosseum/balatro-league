// Award write service (TO only; callers gate). An award is a shell (preset kind OR custom title +
// optional description) plus one or more recipient slots added/removed individually - the same
// per-row shape the roster + trade UIs use. Reads + the pure fold live in lib/awards.ts.
import { prisma } from "../db";
import { AWARD_KINDS, type AwardKind } from "../awards";

async function seasonIdByName(seasonName: string): Promise<string> {
  const s = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!s) throw new Error(`No season "${seasonName}"`);
  return s.id;
}

// Create an empty award. Give it a preset kind (one of the 7) or a custom title (or both - a title
// overrides the preset label). Recipients are added afterwards via addAwardRecipient.
export async function createAward(seasonName: string, input: { kind?: string | null; title?: string | null; description?: string | null }) {
  const seasonId = await seasonIdByName(seasonName);
  const kind = input.kind && input.kind.trim() ? input.kind.trim() : null;
  const title = input.title?.trim() || null;
  if (kind && !AWARD_KINDS.includes(kind as AwardKind)) throw new Error("Unknown award kind.");
  if (!kind && !title) throw new Error("Give the award a preset kind or a custom title.");
  const max = await prisma.award.aggregate({ where: { seasonId }, _max: { sortIndex: true } });
  const award = await prisma.award.create({
    data: {
      seasonId,
      kind: kind as AwardKind | null,
      title,
      description: input.description?.trim() || null,
      sortIndex: (max._max.sortIndex ?? -1) + 1,
    },
    select: { id: true },
  });
  return { awardId: award.id };
}

// Edit an award's title/description (undefined = leave unchanged; empty string = clear).
export async function updateAward(awardId: string, input: { title?: string | null; description?: string | null }) {
  const award = await prisma.award.findUnique({ where: { id: awardId }, select: { id: true } });
  if (!award) throw new Error("Award not found.");
  await prisma.award.update({
    where: { id: awardId },
    data: {
      ...(input.title !== undefined ? { title: input.title?.trim() || null } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
    },
  });
}

// An imported award carries its single winner in the LEGACY Award.playerId/teamId/meta.team
// columns with zero AwardRecipient rows. Before adding a SECOND slot we must promote that legacy
// winner into a real recipient row - otherwise foldAward (recipients-else-legacy) would drop it the
// moment a recipient row exists, silently turning "add a co-winner" into "replace the winner".
async function promoteLegacyRecipient(awardId: string): Promise<void> {
  const a = await prisma.award.findUnique({
    where: { id: awardId },
    select: { playerId: true, teamId: true, meta: true, _count: { select: { recipients: true } } },
  });
  if (!a || a._count.recipients > 0) return; // already materialized (or gone)
  let teamId = a.teamId;
  if (!a.playerId && !teamId) {
    const metaTeam = (a.meta as { team?: string } | null)?.team ?? null;
    if (metaTeam) teamId = (await prisma.team.findFirst({ where: { name: metaTeam }, select: { id: true } }))?.id ?? null;
  }
  if (!a.playerId && !teamId) return; // nothing resolvable to preserve
  await prisma.awardRecipient.create({ data: { awardId, playerId: a.playerId, teamId, note: null, sortIndex: 0 } });
  await prisma.award.update({ where: { id: awardId }, data: { playerId: null, teamId: null } });
}

export async function addAwardRecipient(awardId: string, input: { playerId?: string | null; teamId?: string | null; note?: string | null }) {
  const award = await prisma.award.findUnique({ where: { id: awardId }, select: { id: true } });
  if (!award) throw new Error("Award not found.");
  const playerId = input.playerId?.trim() || null;
  const teamId = input.teamId?.trim() || null;
  if (!playerId && !teamId) throw new Error("Pick a player or a team for the slot.");
  if (playerId && teamId) throw new Error("A slot is one player or one team, not both.");
  if (playerId) {
    const p = await prisma.player.findUnique({ where: { id: playerId }, select: { id: true } });
    if (!p) throw new Error("No such player.");
  }
  if (teamId) {
    const t = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true } });
    if (!t) throw new Error("No such team.");
  }
  // Materialize the legacy winner first, so a new slot is additive not a silent replace.
  await promoteLegacyRecipient(awardId);
  // No duplicate slots for the same player/team on one award.
  const dupe = await prisma.awardRecipient.findFirst({ where: { awardId, ...(playerId ? { playerId } : { teamId }) }, select: { id: true } });
  if (dupe) throw new Error(playerId ? "That player is already a recipient of this award." : "That team is already a recipient of this award.");
  const max = await prisma.awardRecipient.aggregate({ where: { awardId }, _max: { sortIndex: true } });
  await prisma.awardRecipient.create({
    data: { awardId, playerId, teamId, note: input.note?.trim() || null, sortIndex: (max._max.sortIndex ?? -1) + 1 },
  });
}

export async function removeAwardRecipient(recipientId: string) {
  await prisma.awardRecipient.delete({ where: { id: recipientId } });
}

// Delete an award and (via cascade) its recipient slots.
export async function removeAward(awardId: string) {
  await prisma.award.delete({ where: { id: awardId } });
}

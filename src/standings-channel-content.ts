// Builds the live-standings embeds for the active season — one embed per
// division, in tier order (top tier first). Consumed by the standings.refresh
// worker, which posts/edits a read-only #league-standings channel. Returns []
// when there's no active season or it has no divisions yet.

import { EmbedBuilder } from "discord.js";
import { prisma } from "./db.js";
import { loadDivisionStandings } from "./standings-cache.js";
import { formatSeasonLabel } from "./format-season.js";

// Medal for the top 3, otherwise the numeric position.
function place(i: number): string {
  return ["🥇", "🥈", "🥉"][i] ?? `**${i + 1}.**`;
}

// Embed side-color by tier position (1 = top). Cycles for deep pyramids.
const TIER_COLORS = [0xf1c40f, 0xe74c3c, 0x9b59b6, 0x3498db, 0x2ecc71, 0x95a5a6];
function tierColor(position: number): number {
  return TIER_COLORS[(position - 1) % TIER_COLORS.length] ?? 0x95a5a6;
}

export async function composeStandingsEmbeds(): Promise<EmbedBuilder[]> {
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true, number: true, subtitle: true },
  });
  if (!season) return [];

  const divisions = await prisma.division.findMany({
    where: { seasonId: season.id },
    select: { id: true, name: true, tier: { select: { position: true } } },
    orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" } ],
  });
  if (divisions.length === 0) return [];

  const header = new EmbedBuilder()
    .setTitle(`🏆 ${formatSeasonLabel(season)} — Live Standings`)
    .setDescription("Updated automatically as results come in. Full details on the website.")
    .setColor(0xf1c40f)
    .setTimestamp(new Date());

  const divisionEmbeds: EmbedBuilder[] = [];
  for (const div of divisions) {
    const rows = await loadDivisionStandings(div.id);
    const lines = rows.map(
      (r, i) => `${place(i)} ${r.player.displayName} — **${r.points}** pts · ${r.wins}-${r.draws}-${r.losses}`,
    );
    divisionEmbeds.push(
      new EmbedBuilder()
        .setTitle(div.name)
        .setDescription(lines.length > 0 ? lines.join("\n") : "_No results yet._")
        .setColor(tierColor(div.tier.position)),
    );
  }

  return [header, ...divisionEmbeds];
}

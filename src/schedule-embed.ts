// Builds the "Your schedule — <division>" embed for a player in the active
// season. Extracted from the /schedule command so the same rendering is reused
// for DM notifications (e.g. a roster replacement) — one builder, identical UX
// everywhere. Returns null when there's no active season or the player isn't in
// a division this season.

import { EmbedBuilder } from "discord.js";
import { activePublicSeason } from "./active-season.js";
import { prisma } from "./db.js";
import { formatSeasonLabel } from "./format-season.js";
import { formatZone } from "./timezones.js";
import { sanitizeName } from "./sanitize.js";

export async function buildScheduleEmbed(playerId: string): Promise<EmbedBuilder | null> {
  const activeSeason = await activePublicSeason();
  if (!activeSeason) return null;

  const membership = await prisma.divisionMember.findFirst({
    where: { playerId, division: { seasonId: activeSeason.id } },
    include: {
      division: {
        include: {
          members: { include: { player: true } },
          matches: {
            where: { format: "LEAGUE_BO2" },
            include: { playerA: true, playerB: true },
          },
        },
      },
    },
  });
  if (!membership) return null;

  const div = membership.division;
  // Opponents = whoever you have an assigned match against (the graph schedule).
  // Legacy fallback (no pre-created matches): every other ACTIVE member.
  const myMatches = div.matches.filter((m) => m.playerAId === playerId || m.playerBId === playerId);
  const opponents =
    myMatches.length > 0
      ? myMatches.map((m) => (m.playerAId === playerId ? m.playerB : m.playerA))
      : div.members.filter((m) => m.playerId !== playerId && m.status === "ACTIVE").map((m) => m.player);

  interface Item { name: string; status: string; tz?: string | null }
  const remaining: Item[] = [];
  const youReported: Item[] = [];
  const theyReported: Item[] = [];
  const disputed: Item[] = [];
  const done: Item[] = [];

  for (const opp of opponents) {
    // Show the display name people recognize (bold) plus their @username, so
    // opponents can actually find + DM each other on Discord.
    const label = opp.username ? `**${sanitizeName(opp.displayName)}** (@${opp.username})` : `**${sanitizeName(opp.displayName)}**`;
    const p = div.matches.find(
      (pr) =>
        (pr.playerAId === playerId && pr.playerBId === opp.id) ||
        (pr.playerAId === opp.id && pr.playerBId === playerId),
    );
    if (!p) {
      remaining.push({ name: label, status: "", tz: opp.timezone });
    } else if (p.status === "CONFIRMED") {
      const myGames = p.playerAId === playerId ? p.gamesWonA : p.gamesWonB;
      const oppGames = p.playerAId === playerId ? p.gamesWonB : p.gamesWonA;
      done.push({ name: label, status: `${myGames}-${oppGames}` });
    } else if (p.status === "DISPUTED") {
      disputed.push({ name: label, status: "" });
    } else if (p.status === "PENDING") {
      if (p.gamesWonA === 0 && p.gamesWonB === 0) {
        remaining.push({ name: label, status: "", tz: opp.timezone });
      } else if (p.reporterId === playerId) {
        const myGames = p.playerAId === playerId ? p.gamesWonA : p.gamesWonB;
        const oppGames = p.playerAId === playerId ? p.gamesWonB : p.gamesWonA;
        youReported.push({ name: label, status: `${myGames}-${oppGames} (you reported)` });
      } else {
        const myGames = p.playerAId === playerId ? p.gamesWonA : p.gamesWonB;
        const oppGames = p.playerAId === playerId ? p.gamesWonB : p.gamesWonA;
        theyReported.push({ name: label, status: `${myGames}-${oppGames} (they reported — confirm/dispute)` });
      }
    }
  }

  function fmt(items: Item[]): string {
    if (items.length === 0) return "_(none)_";
    return items
      .map((i) => {
        const base = i.status ? `• ${i.name} — ${i.status}` : `• ${i.name}`;
        return i.tz ? `${base}  ·  🕐 ${formatZone(i.tz)}` : base;
      })
      .join("\n");
  }

  const settled = done.length + youReported.length + theyReported.length + disputed.length;
  const totalMatches = settled + remaining.length;
  const pct = totalMatches === 0 ? 0 : Math.round((settled / totalMatches) * 100);
  const barWidth = 20;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const progressLine = `\`${bar}\` **${settled}/${totalMatches}** matches (${pct}%)`;

  const embed = new EmbedBuilder()
    .setTitle(`Your schedule — ${div.name}`)
    .setColor(0x5865f2)
    .setDescription(`Season: **${formatSeasonLabel(activeSeason)}**\n${progressLine}`)
    .addFields(
      ...(theyReported.length ? [{ name: `⚠️ Awaiting your confirmation (${theyReported.length})`, value: fmt(theyReported) }] : []),
      ...(remaining.length ? [{ name: `🎮 Still to play (${remaining.length})`, value: fmt(remaining) }] : []),
      ...(youReported.length ? [{ name: `⏳ Waiting on opponent (${youReported.length})`, value: fmt(youReported) }] : []),
      ...(disputed.length ? [{ name: `🔴 Disputed (${disputed.length})`, value: fmt(disputed) }] : []),
      ...(done.length ? [{ name: `✅ Done (${done.length})`, value: fmt(done) }] : []),
      ...(remaining.length
        ? [{
            name: "📅 Need to set a time?",
            value:
              "Make a timestamp everyone sees in their **own** timezone → **[hammertime.cyou](https://hammertime.cyou)** — then paste the code it gives you into your match chat.",
          }]
        : []),
    );

  if (theyReported.length === 0 && remaining.length === 0 && youReported.length === 0 && disputed.length === 0) {
    embed.setDescription(`Season: **${formatSeasonLabel(activeSeason)}**\n\n🎉 You're done — all your matches are recorded!`);
  }

  return embed;
}

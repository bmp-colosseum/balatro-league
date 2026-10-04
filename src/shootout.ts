// End-of-division shootout handling: detect boundary ties that owe a single-game
// tiebreaker, then notify the two players (DM both + an @-ping in their division
// channel). Detection is the pure `shootoutsNeeded` in standings.ts; this module
// is the impure shell (DB reads, DMs, channel posts) around it.
//
// Idempotency: once a shootout is PLAYED its result re-ranks the pair, so they're
// no longer tied and `shootoutsNeeded` stops returning them. The only double-fire
// window is BEFORE they play it (e.g. a dispute re-completes the division), which
// we guard with a LeagueConfig marker keyed by division + player pair.

import { ChannelType, type TextChannel } from "discord.js";
import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { loadDivisionStandings } from "./standings-cache.js";
import { shootoutsNeeded, type ShootoutNeed } from "./standings.js";
import { enqueueDm } from "./queue.js";
import { sanitizeName } from "./sanitize.js";

// A stable id for a player pair, order-independent, so (a,b) and (b,a) collide.
export function pairKey(aId: string, bId: string): string {
  return [aId, bId].sort().join("~");
}

const noticeKey = (divisionId: string, aId: string, bId: string) =>
  `shootout_notified:${divisionId}:${pairKey(aId, bId)}`;

// A division is done once every scheduled LEAGUE_BO2 match is CONFIRMED (a
// PENDING/DISPUTED match could still change the final order). Shootouts
// (SHOOTOUT_BO1) don't count -- they're the tiebreaker layered on top.
export async function isDivisionComplete(divisionId: string): Promise<boolean> {
  const unfinished = await prisma.match.count({
    where: { divisionId, format: "LEAGUE_BO2", status: { not: "CONFIRMED" } },
  });
  return unfinished === 0;
}

export interface ResolvedShootoutNeed extends ShootoutNeed {
  a: { id: string; discordId: string; displayName: string };
  b: { id: string; discordId: string; displayName: string };
}

interface DivisionShootouts {
  division: { id: string; name: string; discordChannelId: string | null };
  needs: ResolvedShootoutNeed[];
}

// Compute the shootouts a complete division owes right now (empty if incomplete
// or no boundary ties). Reuses the cached standings + per-division movement counts.
export async function computeDivisionShootoutNeeds(divisionId: string): Promise<DivisionShootouts | null> {
  const div = await prisma.division.findUnique({
    where: { id: divisionId },
    select: { id: true, name: true, discordChannelId: true, promoteCount: true, relegateCount: true },
  });
  if (!div) return null;
  const rows = await loadDivisionStandings(divisionId);
  const bare = shootoutsNeeded(rows, div.promoteCount ?? 0, div.relegateCount ?? 0);
  const byId = new Map(rows.map((r) => [r.player.id, r.player]));
  const resolve = (id: string) => {
    const p = byId.get(id);
    return p ? { id: p.id, discordId: p.discordId, displayName: p.displayName } : null;
  };
  const needs: ResolvedShootoutNeed[] = [];
  for (const n of bare) {
    const a = resolve(n.aId);
    const b = resolve(n.bId);
    if (a && b) needs.push({ ...n, a, b });
  }
  return { division: { id: div.id, name: div.name, discordChannelId: div.discordChannelId }, needs };
}

// legacy:<slug> ids are unlinked players who can't be @-mentioned / DM'd.
const isRealDiscordId = (id: string) => /^\d{5,}$/.test(id);

function boundaryPhrase(boundary: "promotion" | "relegation"): string {
  return boundary === "promotion" ? "the last promotion spot" : "the relegation line";
}

// Worker body: for each owed shootout in a completed division, DM both players
// and @-ping them in the division channel. Idempotent via the LeagueConfig marker.
// Returns how many new notifications were sent.
export async function runShootoutCheck(divisionId: string): Promise<number> {
  if (!(await isDivisionComplete(divisionId))) return 0;
  const result = await computeDivisionShootoutNeeds(divisionId);
  if (!result || result.needs.length === 0) return 0;
  const { division, needs } = result;

  const client = tryGetDiscordClient();
  let sent = 0;
  for (const need of needs) {
    const key = noticeKey(division.id, need.a.id, need.b.id);
    const already = await prisma.leagueConfig.findUnique({ where: { key } });
    if (already) continue;

    const where = boundaryPhrase(need.boundary);
    // DM each player (framed from their side).
    const dm = (me: typeof need.a, opp: typeof need.b) =>
      `🎯 **Shootout needed** — you and **${sanitizeName(opp.displayName)}** are tied for ${where} in ` +
      `**${division.name}**, and your head-to-head didn't settle it. Play **one game** to decide it: open ` +
      `**#league-matches** and hit **Start shootout**, or run \`/start-match mode:shootout\`.`;
    if (isRealDiscordId(need.a.discordId))
      await enqueueDm({ discordId: need.a.discordId, content: dm(need.a, need.b), kind: "shootout" });
    if (isRealDiscordId(need.b.discordId))
      await enqueueDm({ discordId: need.b.discordId, content: dm(need.b, need.a), kind: "shootout" });

    // Public @-ping in the division channel (posted directly so the two user
    // mentions actually notify -- postChannelMessage suppresses user pings).
    if (client && division.discordChannelId) {
      const mentions = [need.a, need.b].filter((p) => isRealDiscordId(p.discordId)).map((p) => `<@${p.discordId}>`);
      const names = `${sanitizeName(need.a.displayName)} & ${sanitizeName(need.b.displayName)}`;
      const content =
        `🎯 ${mentions.length ? mentions.join(" ") + " — " : ""}${mentions.length ? "you're" : names + " are"} ` +
        `tied for ${where} in **${division.name}** and split your head-to-head. **One shootout game** decides it — ` +
        `hit **Start shootout** in #league-matches (or \`/start-match mode:shootout\`).`;
      try {
        const ch = await client.channels.fetch(division.discordChannelId);
        if (ch && ch.type === ChannelType.GuildText) {
          await (ch as TextChannel).send({
            content,
            allowedMentions: { users: [need.a, need.b].filter((p) => isRealDiscordId(p.discordId)).map((p) => p.discordId) },
          });
        }
      } catch (err) {
        console.warn(`[shootout] channel ping failed for division ${division.id}:`, err);
      }
    }

    await prisma.leagueConfig.upsert({
      where: { key },
      create: { key, value: new Date().toISOString(), updatedBy: "system" },
      update: { value: new Date().toISOString(), updatedBy: "system" },
    });
    sent++;
  }
  return sent;
}

// For the #league-matches "Start shootout" button: which opponents does this
// player currently owe a shootout? A player sits in one division per season; we
// check that division's owed shootouts for ones involving them. Returns the
// opponent player + division for each (usually 0 or 1).
export async function pendingShootoutsForPlayer(
  playerId: string,
  seasonId: string,
): Promise<Array<{ opponentId: string; opponentName: string; divisionId: string; divisionName: string }>> {
  const membership = await prisma.divisionMember.findFirst({
    where: { playerId, seasonId, status: "ACTIVE" },
    select: { divisionId: true },
  });
  if (!membership) return [];
  if (!(await isDivisionComplete(membership.divisionId))) return [];
  const result = await computeDivisionShootoutNeeds(membership.divisionId);
  if (!result) return [];
  const out: Array<{ opponentId: string; opponentName: string; divisionId: string; divisionName: string }> = [];
  for (const need of result.needs) {
    const opp = need.a.id === playerId ? need.b : need.b.id === playerId ? need.a : null;
    if (opp) out.push({ opponentId: opp.id, opponentName: opp.displayName, divisionId: result.division.id, divisionName: result.division.name });
  }
  return out;
}

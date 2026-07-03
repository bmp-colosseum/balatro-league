// Deadline nudges (C3). Computes who should be reminded RIGHT NOW, for the bot's Friday
// reminder + Sunday-morning last call crons. Sunday is a SOFT intention — these are
// reminders only; nothing locks or forfeits.
//
// Scope: for each live season (REGULAR/PLAYOFFS), only the CURRENT week (the earliest week
// with an undecided matchup) — the schedule holds every week, so scoping stops future-week spam.
//   - matchup with NO sets yet → both captains: "pairing isn't done"
//   - set PROPOSED/SCHEDULED → both players: "your set is unplayed"
//   - set REPORTED → the non-reporter: "confirm or dispute"
import { prisma } from "../db";

export interface Nudge {
  discordId: string;
  message: string;
}

const real = (id: string | undefined | null): id is string => !!id && /^\d+$/.test(id);

export async function nudgeList(): Promise<Nudge[]> {
  const seasons = await prisma.tourSeason.findMany({ where: { state: { in: ["REGULAR", "PLAYOFFS"] } }, select: { id: true, name: true } });
  const out: Nudge[] = [];

  for (const season of seasons) {
    const weeks = await prisma.week.findMany({
      where: { seasonId: season.id },
      include: { matchups: { include: { sets: true } } },
      orderBy: { number: "asc" },
    });
    const currentWeek = weeks.find((w) => w.matchups.some((mu) => mu.setsWonA == null));
    if (!currentWeek) continue;

    const teamIds = [...new Set(currentWeek.matchups.flatMap((mu) => [mu.teamSeasonAId, mu.teamSeasonBId]))];
    const teamSeasons = await prisma.teamSeason.findMany({ where: { id: { in: teamIds } }, include: { team: true } });
    const tsOf = new Map(teamSeasons.map((t) => [t.id, t]));

    const playerIds = new Set<string>();
    for (const ts of teamSeasons) playerIds.add(ts.captainPlayerId);
    for (const mu of currentWeek.matchups) for (const s of mu.sets) { playerIds.add(s.playerAId); playerIds.add(s.playerBId); }
    const players = await prisma.player.findMany({ where: { id: { in: [...playerIds] } }, select: { id: true, displayName: true, discordId: true } });
    const pOf = new Map(players.map((p) => [p.id, p]));

    const matchIds = currentWeek.matchups.flatMap((mu) => mu.sets.map((s) => s.matchId)).filter((x): x is string => !!x);
    const matches = matchIds.length ? await prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, reporterId: true } }) : [];
    const reporterOf = new Map(matches.map((m) => [m.id, m.reporterId]));

    const wk = currentWeek.number;
    for (const mu of currentWeek.matchups) {
      if (mu.setsWonA != null) continue; // decided
      const nameA = tsOf.get(mu.teamSeasonAId)?.team.name ?? "?";
      const nameB = tsOf.get(mu.teamSeasonBId)?.team.name ?? "?";
      if (mu.sets.length === 0) {
        for (const [tsId, oppName] of [[mu.teamSeasonAId, nameB], [mu.teamSeasonBId, nameA]] as const) {
          const cap = pOf.get(tsOf.get(tsId)?.captainPlayerId ?? "");
          if (cap && real(cap.discordId)) {
            out.push({ discordId: cap.discordId, message: `Week ${wk} pairing vs ${oppName} hasn't started yet (${season.name}). Pair here: /matchups/${mu.id}` });
          }
        }
        continue;
      }
      for (const s of mu.sets) {
        if (s.status === "PROPOSED" || s.status === "SCHEDULED") {
          const a = pOf.get(s.playerAId);
          const b = pOf.get(s.playerBId);
          if (a && real(a.discordId)) out.push({ discordId: a.discordId, message: `Your Week ${wk} set vs ${b?.displayName ?? "your opponent"} hasn't been played (${season.name}) — sets are due Sunday night ET. Report at /me` });
          if (b && real(b.discordId)) out.push({ discordId: b.discordId, message: `Your Week ${wk} set vs ${a?.displayName ?? "your opponent"} hasn't been played (${season.name}) — sets are due Sunday night ET. Report at /me` });
        } else if (s.status === "REPORTED" && s.matchId) {
          const reporterId = reporterOf.get(s.matchId) ?? null;
          const confirmerId = reporterId === s.playerAId ? s.playerBId : s.playerAId;
          const confirmer = pOf.get(confirmerId);
          const reporter = reporterId ? pOf.get(reporterId) : null;
          if (confirmer && real(confirmer.discordId)) {
            out.push({ discordId: confirmer.discordId, message: `${reporter?.displayName ?? "Your opponent"} reported your Week ${wk} set (${season.name}) — confirm or dispute it at /me` });
          }
        }
      }
    }
  }
  return out;
}

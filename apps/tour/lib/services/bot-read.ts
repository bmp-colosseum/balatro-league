// Read models for the bot's /ppt commands — thin wrappers over the existing derive-on-read
// services, trimmed to exactly what the embeds need. "Current season" = the newest season
// that isn't DONE, else the newest season.
import { prisma } from "../db";
import { getSeasonStandings } from "../standings";
import { getSeasonWeeks } from "../season-weeks";
import { getPublicBracket, getChampionRun } from "../playoffs";
import { getFantasyStandings } from "./fantasy";

export async function resolveSeasonName(requested?: string | null): Promise<string | null> {
  if (requested?.trim()) {
    const s = await prisma.tourSeason.findUnique({ where: { name: requested.trim() }, select: { name: true } });
    if (s) return s.name;
    // forgiving match: "tt2", "team tour 2", partial names
    const all = await prisma.tourSeason.findMany({ select: { name: true } });
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, "");
    const needle = norm(requested);
    const hit = all.find((x) => {
      const full = norm(x.name);
      const abbr = norm(x.name.replace(/team\s*tour/i, "tt"));
      return full === needle || abbr === needle || full.includes(needle) || abbr.includes(needle);
    });
    return hit?.name ?? null;
  }
  const live = await prisma.tourSeason.findFirst({ where: { state: { not: "DONE" } }, orderBy: { createdAt: "desc" }, select: { name: true } });
  if (live) return live.name;
  const latest = await prisma.tourSeason.findFirst({ orderBy: { createdAt: "desc" }, select: { name: true } });
  return latest?.name ?? null;
}

export async function botStandings(seasonName: string) {
  const st = await getSeasonStandings(seasonName);
  if (!st) return null;
  return {
    seasonName: st.seasonName,
    groups: st.groups.map((g) => ({
      conference: g.conferenceName,
      rows: g.rows.map((r, i) => ({ rank: i + 1, team: r.name, w: r.matchupsW, l: r.matchupsL, setsW: r.setsW, setsL: r.setsL })),
    })),
    urlPath: `/seasons/${encodeURIComponent(seasonName)}`,
  };
}

export async function botSchedule(seasonName: string, week?: number | null) {
  const weeks = await getSeasonWeeks(seasonName);
  if (!weeks.length) return null;
  const target = week != null ? weeks.find((w) => w.week === week) : weeks[weeks.length - 1];
  if (!target) return null;
  return {
    seasonName,
    week: target.week,
    matchups: target.matchups.map((m) => ({ teamA: m.teamA, teamB: m.teamB, setsA: m.setsA, setsB: m.setsB })),
    urlPath: `/seasons/${encodeURIComponent(seasonName)}/weeks`,
  };
}

export async function botBracket(seasonName: string) {
  const bracket = await getPublicBracket(seasonName);
  if (bracket) {
    return {
      seasonName,
      champion: bracket.champion,
      rounds: bracket.rounds.map((r) => ({
        label: r.label,
        series: r.series.map((s) => ({ a: s.aName, b: s.bName, scoreA: s.scoreA, scoreB: s.scoreB, winner: s.winner })),
      })),
      urlPath: `/seasons/${encodeURIComponent(seasonName)}/bracket`,
    };
  }
  const run = await getChampionRun(seasonName);
  if (!run) return null;
  return {
    seasonName,
    champion: run.champion,
    rounds: run.rounds.map((r) => ({ label: r.label, series: [{ a: run.champion, b: r.opponent ?? "?", scoreA: r.champScore, scoreB: r.oppScore, winner: "A" as const }] })),
    urlPath: `/seasons/${encodeURIComponent(seasonName)}/bracket`,
  };
}

// Fantasy league standings (derive-on-read), trimmed for the embed. null when the season has no
// fantasy league yet.
export async function botFantasy(seasonName: string) {
  const st = await getFantasyStandings(seasonName);
  if (!st) return null;
  return {
    seasonName,
    scope: st.scope,
    rosterSize: st.rosterSize,
    setsCounted: st.setsCounted,
    rows: st.standings.map((s, i) => ({ rank: i + 1, manager: s.managerName, points: s.points, sets: s.sets })),
    urlPath: `/seasons/${encodeURIComponent(seasonName)}/fantasy`,
  };
}

// The invoking user's outstanding tour work: pending sets + captain pairing turns.
export async function botMyMatch(discordId: string) {
  const player = await prisma.player.findUnique({ where: { discordId }, select: { id: true, displayName: true } });
  if (!player) return { linked: false as const };
  const liveSeasons = await prisma.tourSeason.findMany({ where: { state: { in: ["REGULAR", "PLAYOFFS"] } }, select: { id: true, name: true } });
  const seasonIds = liveSeasons.map((s) => s.id);
  const sets = seasonIds.length
    ? await prisma.tourSet.findMany({
        where: {
          seasonId: { in: seasonIds },
          status: { in: ["PROPOSED", "SCHEDULED", "REPORTED"] },
          OR: [{ playerAId: player.id }, { playerBId: player.id }],
        },
        select: { id: true, status: true, week: true, playerAId: true, playerBId: true, matchupId: true, seasonId: true },
      })
    : [];
  const oppIds = sets.map((s) => (s.playerAId === player.id ? s.playerBId : s.playerAId));
  const opps = oppIds.length ? await prisma.player.findMany({ where: { id: { in: oppIds } }, select: { id: true, displayName: true } }) : [];
  const oppName = new Map(opps.map((o) => [o.id, o.displayName]));
  const seasonName = new Map(liveSeasons.map((s) => [s.id, s.name]));
  // Weeks via matchups when the set has no direct week.
  const muIds = sets.map((s) => s.matchupId).filter((x): x is string => !!x);
  const mus = muIds.length ? await prisma.matchup.findMany({ where: { id: { in: muIds } }, select: { id: true, week: { select: { number: true } } } }) : [];
  const weekOfMu = new Map(mus.map((m) => [m.id, m.week.number]));
  return {
    linked: true as const,
    name: player.displayName,
    sets: sets.map((s) => ({
      status: s.status,
      week: s.week ?? (s.matchupId ? weekOfMu.get(s.matchupId) ?? null : null),
      opponent: oppName.get(s.playerAId === player.id ? s.playerBId : s.playerAId) ?? "?",
      season: s.seasonId ? seasonName.get(s.seasonId) ?? "?" : "?",
    })),
    urlPath: "/me",
  };
}

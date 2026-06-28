// The season-story timeline (D2): a single chronological feed merging the derived
// roster-move log (B7), weekly results, and milestones (draft / playoffs / champion).
// All derive-on-read — no stored feed; this is just a reduction over the tables.
import { prisma } from "./db";

export type TimelineKind =
  | "DRAFT"
  | "SUB"
  | "QUIT"
  | "BANNED"
  | "REINSTATED"
  | "ADDED"
  | "CAPTAIN"
  | "RESULT"
  | "PLAYOFFS"
  | "PLAYOFF_RESULT"
  | "CHAMPION";

export interface TimelineEvent {
  week: number; // 0 = pre-season (draft); regular weeks; then playoffs/champion after the last week
  order: number; // tiebreak within a week (roster moves first, then results)
  kind: TimelineKind;
  title: string;
  detail?: string;
}

export interface SeasonTimeline {
  seasonName: string;
  events: TimelineEvent[];
}

const ROUND_ORDER: Record<string, number> = { QUARTERFINAL: 0, SEMIFINAL: 1, FINAL: 2 };
const ROUND_LABEL: Record<string, string> = { QUARTERFINAL: "Quarterfinal", SEMIFINAL: "Semifinal", FINAL: "Final" };

export async function getSeasonTimeline(seasonName: string): Promise<SeasonTimeline | null> {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true, name: true } });
  if (!season) return null;

  const [weeks, teamSeasons, moves, playoffSeries, championship] = await Promise.all([
    prisma.week.findMany({ where: { seasonId: season.id }, include: { matchups: true }, orderBy: { number: "asc" } }),
    prisma.teamSeason.findMany({ where: { seasonId: season.id }, include: { team: true } }),
    prisma.rosterMove.findMany({ where: { seasonId: season.id, kind: { not: "DRAFTED" } }, orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }] }),
    prisma.playoffSeries.findMany({ where: { seasonId: season.id } }),
    prisma.championship.findFirst({ where: { seasonId: season.id } }),
  ]);

  const teamName = new Map(teamSeasons.map((t) => [t.id, t.team.name]));
  const pids = [...new Set(moves.flatMap((m) => [m.playerId, m.outPlayerId, m.replacesPlayerId]).filter((x): x is string => !!x))];
  const players = await prisma.player.findMany({ where: { id: { in: pids } }, select: { id: true, displayName: true } });
  const pName = (id: string | null) => (id ? players.find((p) => p.id === id)?.displayName ?? "?" : "?");

  const events: TimelineEvent[] = [];
  const maxWeek = weeks.length ? Math.max(...weeks.map((w) => w.number)) : 0;

  // Draft milestone (pre-season).
  if (teamSeasons.length > 0) {
    events.push({ week: 0, order: 0, kind: "DRAFT", title: "Draft completed", detail: `${teamSeasons.length} teams set` });
  }

  // Roster exceptions (the move log, minus the bulk DRAFTED rows).
  for (const m of moves) {
    const tn = teamName.get(m.teamSeasonId) ?? "";
    if (m.kind === "SUB") {
      events.push({
        week: m.effectiveWeek,
        order: 0,
        kind: "SUB",
        title: `${pName(m.playerId)} subbed in for ${pName(m.outPlayerId)}`,
        detail: `${tn}${m.untilWeek ? ` · through W${m.untilWeek}` : ""}${m.reason ? ` — ${m.reason}` : ""}`,
      });
    } else if (m.kind === "QUIT") {
      events.push({ week: m.effectiveWeek, order: 0, kind: "QUIT", title: `${pName(m.playerId)} left ${tn}`, detail: m.reason ?? undefined });
    } else if (m.kind === "BANNED") {
      events.push({ week: m.effectiveWeek, order: 0, kind: "BANNED", title: `${pName(m.playerId)} banned`, detail: `${tn}${m.reason ? ` — ${m.reason}` : ""}` });
    } else if (m.kind === "ADDED") {
      events.push({ week: m.effectiveWeek, order: 0, kind: "ADDED", title: `${pName(m.playerId)} joined ${tn}${m.replacesPlayerId ? `, replacing ${pName(m.replacesPlayerId)}` : ""}`, detail: m.reason ?? undefined });
    } else if (m.kind === "REINSTATED") {
      events.push({ week: m.effectiveWeek, order: 0, kind: "REINSTATED", title: `${pName(m.playerId)} reinstated`, detail: `${tn}${m.reason ? ` — ${m.reason}` : ""}` });
    } else if (m.kind === "CAPTAIN_CHANGE") {
      events.push({ week: m.effectiveWeek, order: 0, kind: "CAPTAIN", title: `${pName(m.playerId)} took over as captain of ${tn}${m.replacesPlayerId ? ` (from ${pName(m.replacesPlayerId)})` : ""}`, detail: m.reason ?? undefined });
    }
  }

  // Weekly results (decided matchups).
  for (const w of weeks) {
    for (const mu of w.matchups) {
      if (mu.setsWonA == null || mu.setsWonB == null) continue;
      const a = teamName.get(mu.teamSeasonAId) ?? "?";
      const b = teamName.get(mu.teamSeasonBId) ?? "?";
      let title: string;
      if (mu.winnerTeamSeasonId === mu.teamSeasonAId) title = `${a} def. ${b} ${mu.setsWonA}–${mu.setsWonB}`;
      else if (mu.winnerTeamSeasonId === mu.teamSeasonBId) title = `${b} def. ${a} ${mu.setsWonB}–${mu.setsWonA}`;
      else title = `${a} ${mu.setsWonA}–${mu.setsWonB} ${b} (tie)`;
      events.push({ week: w.number, order: 1, kind: "RESULT", title });
    }
  }

  // Playoffs.
  if (playoffSeries.length > 0) {
    events.push({ week: maxWeek + 1, order: 0, kind: "PLAYOFFS", title: "Playoffs began" });
    for (const s of playoffSeries) {
      const winnerId = s.winnerTeamSeasonId ?? (s.scoreA != null && s.scoreB != null ? (s.scoreA >= s.scoreB ? s.teamSeasonAId : s.teamSeasonBId) : null);
      if (!winnerId || s.scoreA == null || s.scoreB == null) continue;
      const a = teamName.get(s.teamSeasonAId ?? "") ?? "?";
      const b = teamName.get(s.teamSeasonBId ?? "") ?? "?";
      const aWon = winnerId === s.teamSeasonAId;
      const hi = Math.max(s.scoreA, s.scoreB);
      const lo = Math.min(s.scoreA, s.scoreB);
      events.push({
        week: maxWeek + 1,
        order: 1 + (ROUND_ORDER[s.round] ?? 0),
        kind: "PLAYOFF_RESULT",
        title: `${ROUND_LABEL[s.round] ?? s.round}: ${aWon ? a : b} def. ${aWon ? b : a} ${hi}–${lo}`,
      });
    }
  }

  // Champion.
  if (championship) {
    const tn = teamSeasons.find((t) => t.teamId === championship.teamId)?.team.name ?? "Champion";
    events.push({ week: maxWeek + 2, order: 0, kind: "CHAMPION", title: `${tn} crowned champion` });
  }

  events.sort((x, y) => x.week - y.week || x.order - y.order);
  return { seasonName: season.name, events };
}

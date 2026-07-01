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

// A title is a sequence of parts so player/team names can be links (href set) while the
// connecting prose stays plain text.
export type TimelinePart = { text: string; href?: string };

export interface TimelineEvent {
  week: number; // 0 = pre-season (draft); regular weeks; then playoffs/champion after the last week
  order: number; // tiebreak within a week (roster moves first, then results)
  kind: TimelineKind;
  title: TimelinePart[];
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
  // Title-part builders: T = plain text, PL = player link, TL = team link.
  const T = (text: string): TimelinePart => ({ text });
  const PL = (id: string | null): TimelinePart => ({ text: pName(id), href: id ? `/players/${id}` : undefined });
  const TL = (tsId: string | null): TimelinePart => ({ text: tsId ? teamName.get(tsId) ?? "?" : "?", href: tsId ? `/teams/${tsId}` : undefined });

  const events: TimelineEvent[] = [];
  const maxWeek = weeks.length ? Math.max(...weeks.map((w) => w.number)) : 0;

  // Draft milestone (pre-season).
  if (teamSeasons.length > 0) {
    events.push({ week: 0, order: 0, kind: "DRAFT", title: [T("Draft completed")], detail: `${teamSeasons.length} teams set` });
  }

  // Internal ranking-block labels ("roster change (Weeks 4-7)", "ranking ...") are noise in
  // the feed — the week already conveys when — so don't surface them as a detail.
  const reasonClean = (r: string | null) => (r && !r.startsWith("roster change") && !r.startsWith("ranking") ? r : undefined);

  // Roster exceptions (the move log, minus the bulk DRAFTED rows).
  for (const m of moves) {
    const ts = m.teamSeasonId;
    const tn = teamName.get(m.teamSeasonId) ?? "";
    const seedTxt = m.seed != null ? [T(` at seed #${m.seed}`)] : [];
    if (m.kind === "SUB") {
      events.push({
        week: m.effectiveWeek,
        order: 0,
        kind: "SUB",
        title: [PL(m.playerId), T(" subbed in for "), PL(m.outPlayerId), ...seedTxt],
        detail: `${tn}${m.untilWeek ? ` · through W${m.untilWeek}` : ""}${reasonClean(m.reason) ? ` — ${reasonClean(m.reason)}` : ""}`,
      });
    } else if (m.kind === "QUIT") {
      events.push({ week: m.effectiveWeek, order: 0, kind: "QUIT", title: [PL(m.playerId), T(" left "), TL(ts)], detail: reasonClean(m.reason) });
    } else if (m.kind === "BANNED") {
      events.push({ week: m.effectiveWeek, order: 0, kind: "BANNED", title: [PL(m.playerId), T(" banned")], detail: `${tn}${reasonClean(m.reason) ? ` — ${reasonClean(m.reason)}` : ""}` });
    } else if (m.kind === "ADDED") {
      events.push({ week: m.effectiveWeek, order: 0, kind: "ADDED", title: [PL(m.playerId), T(" joined "), TL(ts), ...(m.replacesPlayerId ? [T(", for "), PL(m.replacesPlayerId)] : []), ...seedTxt], detail: reasonClean(m.reason) });
    } else if (m.kind === "REINSTATED") {
      events.push({ week: m.effectiveWeek, order: 0, kind: "REINSTATED", title: [PL(m.playerId), T(" reinstated")], detail: `${tn}${reasonClean(m.reason) ? ` — ${reasonClean(m.reason)}` : ""}` });
    } else if (m.kind === "CAPTAIN_CHANGE") {
      events.push({ week: m.effectiveWeek, order: 0, kind: "CAPTAIN", title: [PL(m.playerId), T(" took over as captain of "), TL(ts), ...(m.replacesPlayerId ? [T(" (from "), PL(m.replacesPlayerId), T(")")] : [])], detail: reasonClean(m.reason) });
    }
  }

  // Weekly results (decided matchups).
  for (const w of weeks) {
    for (const mu of w.matchups) {
      if (mu.setsWonA == null || mu.setsWonB == null) continue;
      const A = mu.teamSeasonAId, B = mu.teamSeasonBId;
      let title: TimelinePart[];
      if (mu.winnerTeamSeasonId === mu.teamSeasonAId) title = [TL(A), T(" def. "), TL(B), T(` ${mu.setsWonA}–${mu.setsWonB}`)];
      else if (mu.winnerTeamSeasonId === mu.teamSeasonBId) title = [TL(B), T(" def. "), TL(A), T(` ${mu.setsWonB}–${mu.setsWonA}`)];
      else title = [TL(A), T(` ${mu.setsWonA}–${mu.setsWonB} `), TL(B), T(" (tie)")];
      events.push({ week: w.number, order: 1, kind: "RESULT", title });
    }
  }

  // Playoffs.
  if (playoffSeries.length > 0) {
    events.push({ week: maxWeek + 1, order: 0, kind: "PLAYOFFS", title: [T("Playoffs began")] });
    for (const s of playoffSeries) {
      const winnerId = s.winnerTeamSeasonId ?? (s.scoreA != null && s.scoreB != null ? (s.scoreA >= s.scoreB ? s.teamSeasonAId : s.teamSeasonBId) : null);
      if (!winnerId || s.scoreA == null || s.scoreB == null) continue;
      const aWon = winnerId === s.teamSeasonAId;
      const hi = Math.max(s.scoreA, s.scoreB);
      const lo = Math.min(s.scoreA, s.scoreB);
      events.push({
        week: maxWeek + 1,
        order: 1 + (ROUND_ORDER[s.round] ?? 0),
        kind: "PLAYOFF_RESULT",
        title: [T(`${ROUND_LABEL[s.round] ?? s.round}: `), TL(aWon ? s.teamSeasonAId : s.teamSeasonBId), T(" def. "), TL(aWon ? s.teamSeasonBId : s.teamSeasonAId), T(` ${hi}–${lo}`)],
      });
    }
  }

  // Champion.
  if (championship) {
    const champTs = teamSeasons.find((t) => t.teamId === championship.teamId);
    events.push({ week: maxWeek + 2, order: 0, kind: "CHAMPION", title: [TL(champTs?.id ?? null), T(" crowned champion")] });
  }

  events.sort((x, y) => x.week - y.week || x.order - y.order);
  return { seasonName: season.name, events };
}

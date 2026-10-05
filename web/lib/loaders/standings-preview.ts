import "server-only";

// Loader for the admin-only /admin/standings-preview page. For a given
// season, loads what BOTH the current (computeStandings) and best-N
// (computeBestNStandings) engines need, runs both, and diffs the result per
// player: rank change, points change, and whether they cross a
// promotion/relegation boundary. Nothing here writes anything or touches
// web/lib/standings-cache.ts's DivisionStandings cache -- this is read-only,
// off to the side, purely for the TO to preview before deciding to enable
// best-N anywhere (see web/lib/standings-best-n.ts's header for the
// eventual switch point).
//
// The season/tier/division/member/match read shape below mirrors
// web/lib/loaders/standings.ts's loadStandingsPageData query (same joins),
// but widened to ALL members (not just ACTIVE) since computeBestNStandings
// needs the dropped members too, and re-run here rather than imported so
// this page never calls into the cache-backed loadDivisionStandings /
// loadManyDivisionStandings -- a preview must not warm or depend on the
// live cache.

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";
import { getLeagueSettingsForSeason } from "@/lib/league-settings";
import { computeStandings, type StandingRow, type ShootoutInput } from "@/lib/standings";
import {
  computeBestNStandings,
  type BestNMemberInput,
  type BestNPairing,
  type BestNStandingRow,
} from "@/lib/standings-best-n";

export interface StandingsPreviewSeasonOption {
  id: string;
  label: string;
  isActive: boolean;
}

export async function loadStandingsPreviewSeasonOptions(): Promise<StandingsPreviewSeasonOption[]> {
  const seasons = await prisma.season.findMany({
    where: { archivedAt: null },
    orderBy: [{ isActive: "desc" }, { number: "desc" }],
    select: { id: true, number: true, subtitle: true, isActive: true },
  });
  return seasons.map((s) => ({ id: s.id, label: formatSeasonLabel(s), isActive: s.isActive }));
}

export interface StandingsPreviewPlayerDiff {
  playerId: string;
  displayName: string;
  // 1-based display rank (ties share a rank; see assignRanks). Null only if
  // the player is somehow missing from that engine's rows (shouldn't happen
  // for an ACTIVE member, but keeps the type honest).
  currentRank: number | null;
  currentPoints: number;
  bestNRank: number | null;
  bestNPoints: number;
  bestNCounted: number;
  bestNOf: number;
  rankChanged: boolean;
  // True when this player's promotion/relegation zone membership differs
  // between the current and best-N tables (either direction).
  boundaryChanged: boolean;
  // One-line explanation when boundaryChanged -- e.g. "Would be promoted
  // instead of <name>." Null when boundaryChanged is false.
  boundaryNote: string | null;
}

// One best-N candidate's rows + diff against the current table. The two
// candidates ("count" vs "void" -- see web/lib/standings-best-n.ts's
// header) are computed independently and never compared against each
// other, only each against `currentRows`.
export interface StandingsPreviewCandidate {
  rows: BestNStandingRow[];
  players: StandingsPreviewPlayerDiff[];
  rankChangeCount: number;
  boundaryChangeCount: number;
}

export interface StandingsPreviewDivision {
  id: string;
  name: string;
  tierName: string;
  k: number;
  n: number;
  dropouts: number; // 0 = best-N not triggered here (same for both candidates -- mode doesn't change k/n/dropouts)
  promoteCount: number; // effective (ladder-clamped) promote count used for the zone diff
  relegateCount: number; // effective (ladder-clamped) relegate count used for the zone diff
  currentRows: StandingRow[];
  countMode: StandingsPreviewCandidate;
  voidMode: StandingsPreviewCandidate;
}

export interface StandingsPreviewData {
  season: { id: string; label: string } | null;
  // Only divisions with at least one unreplaced dropout -- that's the only
  // case where the two tables can possibly differ, and it's what the TO
  // asked to preview. Divisions with no dropout are counted in
  // totalDivisions but not rendered as their own card.
  divisions: StandingsPreviewDivision[];
  summary: {
    totalDivisions: number;
    divisionsWithDropout: number;
    countMode: { rankChanges: number; boundaryChanges: number };
    voidMode: { rankChanges: number; boundaryChanges: number };
  };
}

// Index-based zone membership (top `count` rows / bottom `count` rows of
// the SORTED table) -- matches how web/lib/loaders/standings.ts's moveById
// frames promote/relegate ("top N finishers", "bottom N finishers"), not the
// shared-tie "rank" number, so a tie at the boundary doesn't inflate the
// zone size.
function zoneSets(rowCount: number, promoteCount: number, relegateCount: number) {
  const promoteZone = new Set(Array.from({ length: Math.min(promoteCount, rowCount) }, (_, i) => i));
  const relegateZone = new Set(
    Array.from({ length: Math.min(relegateCount, rowCount) }, (_, i) => rowCount - 1 - i),
  );
  return { promoteZone, relegateZone };
}

// Builds one best-N candidate's diff against `currentRows` -- shared by both
// the "count" and "void" dropoutGames modes, which otherwise only differ in
// which `bestNRows` they were computed from.
function buildCandidate(
  currentRows: StandingRow[],
  bestNRows: BestNStandingRow[],
  activePlayers: { id: string; displayName: string }[],
  effectivePromote: number,
  effectiveRelegate: number,
): StandingsPreviewCandidate {
  const currentZones = zoneSets(currentRows.length, effectivePromote, effectiveRelegate);
  const bestNZones = zoneSets(bestNRows.length, effectivePromote, effectiveRelegate);

  const currentIndexById = new Map(currentRows.map((r, i) => [r.player.id, i]));
  const bestNIndexById = new Map(bestNRows.map((r, i) => [r.player.id, i]));

  // Pair up who entered vs. left each zone so the note can name names.
  const buildNotes = (
    zoneLabel: "promoted" | "relegated",
    currentZone: Set<number>,
    bestNZone: Set<number>,
  ) => {
    const left = currentRows.filter((r) => currentZone.has(currentIndexById.get(r.player.id)!) && !bestNZone.has(bestNIndexById.get(r.player.id)!));
    const entered = bestNRows.filter((r) => bestNZone.has(bestNIndexById.get(r.player.id)!) && !currentZone.has(currentIndexById.get(r.player.id)!));
    const enteredNoteById = new Map<string, string>();
    const leftNoteById = new Map<string, string>();
    entered.forEach((r, i) => {
      const displaced = left[i];
      enteredNoteById.set(
        r.player.id,
        displaced
          ? `Would be ${zoneLabel} instead of ${displaced.player.displayName}.`
          : `Would be ${zoneLabel}.`,
      );
    });
    left.forEach((r, i) => {
      const replacement = entered[i];
      leftNoteById.set(
        r.player.id,
        replacement
          ? `Would miss ${zoneLabel === "promoted" ? "promotion" : "relegation"} to ${replacement.player.displayName}.`
          : `Would no longer be ${zoneLabel}.`,
      );
    });
    return { enteredNoteById, leftNoteById };
  };
  const promoteNotes = buildNotes("promoted", currentZones.promoteZone, bestNZones.promoteZone);
  const relegateNotes = buildNotes("relegated", currentZones.relegateZone, bestNZones.relegateZone);

  const players: StandingsPreviewPlayerDiff[] = activePlayers.map((p) => {
    const currentIdx = currentIndexById.get(p.id);
    const bestNIdx = bestNIndexById.get(p.id);
    const currentRow = currentIdx !== undefined ? currentRows[currentIdx] : undefined;
    const bestNRow = bestNIdx !== undefined ? bestNRows[bestNIdx] : undefined;

    const note =
      promoteNotes.enteredNoteById.get(p.id) ??
      promoteNotes.leftNoteById.get(p.id) ??
      relegateNotes.enteredNoteById.get(p.id) ??
      relegateNotes.leftNoteById.get(p.id) ??
      null;

    return {
      playerId: p.id,
      displayName: p.displayName,
      currentRank: currentRow?.rank ?? null,
      currentPoints: currentRow?.points ?? 0,
      bestNRank: bestNRow?.rank ?? null,
      bestNPoints: bestNRow?.points ?? 0,
      bestNCounted: bestNRow?.counted ?? 0,
      bestNOf: bestNRow?.of ?? 0,
      rankChanged: (currentRow?.rank ?? null) !== (bestNRow?.rank ?? null),
      boundaryChanged: note !== null,
      boundaryNote: note,
    };
  });

  return {
    rows: bestNRows,
    players,
    rankChangeCount: players.filter((p) => p.rankChanged).length,
    boundaryChangeCount: players.filter((p) => p.boundaryChanged).length,
  };
}

export async function loadStandingsPreview(seasonId: string): Promise<StandingsPreviewData> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: {
      id: true,
      number: true,
      subtitle: true,
      tiers: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          name: true,
          position: true,
          divisions: {
            orderBy: { groupNumber: "asc" },
            select: {
              id: true,
              name: true,
              promoteCount: true,
              relegateCount: true,
              members: {
                select: {
                  playerId: true,
                  status: true,
                  joinedAt: true,
                  droppedAt: true,
                  player: { select: { id: true, displayName: true } },
                },
              },
              matches: {
                select: {
                  playerAId: true,
                  playerBId: true,
                  gamesWonA: true,
                  gamesWonB: true,
                  status: true,
                  format: true,
                  winnerId: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!season) {
    return {
      season: null,
      divisions: [],
      summary: {
        totalDivisions: 0,
        divisionsWithDropout: 0,
        countMode: { rankChanges: 0, boundaryChanges: 0 },
        voidMode: { rankChanges: 0, boundaryChanges: 0 },
      },
    };
  }

  const { scoring } = await getLeagueSettingsForSeason(season.id);
  const tierPositions = season.tiers.map((t) => t.position);
  const minTierPosition = tierPositions.length > 0 ? Math.min(...tierPositions) : 0;
  const maxTierPosition = tierPositions.length > 0 ? Math.max(...tierPositions) : 0;

  const divisions: StandingsPreviewDivision[] = [];
  let totalDivisions = 0;

  for (const tier of season.tiers) {
    for (const d of tier.divisions) {
      totalDivisions++;

      const leagueMatches = d.matches.filter((m) => m.format === "LEAGUE_BO2");
      const confirmedPairings: BestNPairing[] = leagueMatches
        .filter((m) => m.status === "CONFIRMED")
        .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId, gamesWonA: m.gamesWonA, gamesWonB: m.gamesWonB }));
      const shootouts: ShootoutInput[] = d.matches
        .filter((m) => m.format === "SHOOTOUT_BO1" && m.status === "CONFIRMED" && m.winnerId !== null)
        .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId, winnerId: m.winnerId! }));

      // Every member's total scheduled LEAGUE_BO2 games (any status) in
      // this division -- only consulted for a replacement's effective cap.
      const scheduledGamesByPlayerId = new Map<string, number>();
      for (const m of leagueMatches) {
        scheduledGamesByPlayerId.set(m.playerAId, (scheduledGamesByPlayerId.get(m.playerAId) ?? 0) + 1);
        scheduledGamesByPlayerId.set(m.playerBId, (scheduledGamesByPlayerId.get(m.playerBId) ?? 0) + 1);
      }

      // A member is treated as a mid-season "replacement" when they joined
      // AFTER at least one OTHER member in the division had already
      // dropped -- i.e. they could be backfilling a vacated slot. This is a
      // heuristic (the schema has no explicit "replaces" link for the
      // soft-drop + later-add path), deliberately conservative: at worst it
      // caps a late joiner's own effective N at their own scheduled games,
      // which is harmless even for a true coincidental late addition. See
      // web/lib/standings-best-n.ts's header for how a dedicated flag would
      // remove the need for this guess.
      const earliestDropAt = d.members.reduce<Date | null>((min, m) => {
        if (m.status !== "DROPPED" || !m.droppedAt) return min;
        return !min || m.droppedAt < min ? m.droppedAt : min;
      }, null);

      const members: BestNMemberInput[] = d.members.map((m) => ({
        player: m.player as BestNMemberInput["player"],
        status: m.status === "DROPPED" ? "DROPPED" : "ACTIVE",
        isReplacement:
          m.status === "ACTIVE" && earliestDropAt !== null && m.joinedAt > earliestDropAt,
        scheduledGames: scheduledGamesByPlayerId.get(m.playerId) ?? 0,
      }));

      const activePlayers = members.filter((m) => m.status === "ACTIVE").map((m) => m.player);
      const currentRows = computeStandings(activePlayers, confirmedPairings, shootouts, scoring);
      const bestNCount = computeBestNStandings(members, confirmedPairings, shootouts, scoring, "count");

      if (bestNCount.division.dropouts === 0) continue; // nothing to preview here (same for both modes)

      const bestNVoid = computeBestNStandings(members, confirmedPairings, shootouts, scoring, "void");

      const effectivePromote = tier.position === minTierPosition
        ? 0
        : Math.min(d.promoteCount, currentRows.length);
      const effectiveRelegate = tier.position === maxTierPosition
        ? 0
        : Math.min(d.relegateCount, currentRows.length);

      const countMode = buildCandidate(currentRows, bestNCount.rows, activePlayers, effectivePromote, effectiveRelegate);
      const voidMode = buildCandidate(currentRows, bestNVoid.rows, activePlayers, effectivePromote, effectiveRelegate);

      divisions.push({
        id: d.id,
        name: d.name,
        tierName: tier.name,
        k: bestNCount.division.k,
        n: bestNCount.division.n,
        dropouts: bestNCount.division.dropouts,
        promoteCount: effectivePromote,
        relegateCount: effectiveRelegate,
        currentRows,
        countMode,
        voidMode,
      });
    }
  }

  const summary = {
    totalDivisions,
    divisionsWithDropout: divisions.length,
    countMode: {
      rankChanges: divisions.reduce((sum, dd) => sum + dd.countMode.rankChangeCount, 0),
      boundaryChanges: divisions.reduce((sum, dd) => sum + dd.countMode.boundaryChangeCount, 0),
    },
    voidMode: {
      rankChanges: divisions.reduce((sum, dd) => sum + dd.voidMode.rankChangeCount, 0),
      boundaryChanges: divisions.reduce((sum, dd) => sum + dd.voidMode.boundaryChangeCount, 0),
    },
  };

  return { season: { id: season.id, label: formatSeasonLabel(season) }, divisions, summary };
}

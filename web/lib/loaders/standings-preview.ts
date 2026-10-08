import "server-only";

// Loader for the admin-only /admin/standings-preview page. For a given
// season, loads what BOTH the current (computeStandings) and best-N
// (computeBestNStandings) engines need, runs both, and diffs the result per
// player: rank change, points change, and whether they cross a
// promotion/relegation boundary. Nothing here writes anything or touches
// web/lib/standings-cache.ts's DivisionStandings cache -- this is read-only,
// off to the side, purely for the TO to preview before deciding whether to
// flip the season's live scoringMode (the actual write -- and the cache
// invalidation that makes it take effect immediately -- is a separate
// action, ./actions.ts's setSeasonScoringModeAction, never this loader).
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
import { computeStandings, type StandingRow, type ShootoutInput, type Tiebreak } from "@/lib/standings";
import {
  computeBestNStandings,
  buildBestNMembers,
  type BestNMemberInput,
  type BestNPairing,
  type BestNStandingRow,
} from "@/lib/standings-best-n";
import {
  suggestDropCandidates,
  withHypotheticalDrops,
  type DropCandidate,
  type DropCandidateMatchInput,
  type DropCandidateMemberInput,
} from "@/lib/drop-candidates-core";
import { normalizeScoringMode, type SeasonScoringMode } from "@/lib/standings-mode";

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
  // True when the net-lives tiebreak (tiebreak: "lives") changed THIS
  // player's rank on THIS table versus the same engine computed with the
  // default "chain" tiebreak -- i.e. a rank change caused by lives, not by
  // best-N selection. Always false when the page's tiebreak is "chain" (the
  // default -- see loadStandingsPreview's `tiebreak` option).
  livesRankChanged: boolean;
}

// One row's net-lives tiebreak detail, surfaced alongside a table so the UI
// can show "N games without lives" -- only populated when the page's
// tiebreak option is "lives".
export interface StandingsPreviewLivesRow {
  playerId: string;
  displayName: string;
  netLives: number;
  livesGamesMissing: number;
}

// Net-lives effect on one table (current rows, or one best-N candidate's
// rows), relative to the SAME rows computed with tiebreak: "chain". Only
// meaningful -- and only non-zero/non-empty -- when the page's tiebreak
// option is "lives"; always `{ tiesBroken: 0, missingLives: [] }` under the
// default "chain".
export interface StandingsPreviewLivesInfo {
  // How many rows that were tiedWithPrev under "chain" are no longer tied
  // under "lives" -- the TO's "lives broke N ties" count for this table.
  tiesBroken: number;
  // Every row (under "lives") with at least one counted game missing a
  // recorded winnerLives.
  missingLives: StandingsPreviewLivesRow[];
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
  // Net-lives effect on THIS candidate's own table (rows vs the same
  // candidate computed with tiebreak: "chain"). Always the zero value under
  // the page's default "chain" tiebreak.
  livesInfo: StandingsPreviewLivesInfo;
}

export interface StandingsPreviewDivision {
  id: string;
  name: string;
  tierName: string;
  k: number;
  n: number;
  scheduled: number;
  dropouts: number; // real + hypothetical unreplaced dropouts (same for both candidates -- mode doesn't change k/n/dropouts)
  // Of `dropouts`, how many are hypothetical (selected via the what-if panel,
  // not an actual DivisionMember.status === "DROPPED" yet) -- lets the UI
  // call those out distinctly from a real unreplaced dropout.
  hypotheticalDrops: { playerId: string; displayName: string }[];
  promoteCount: number; // effective (ladder-clamped) promote count used for the zone diff
  relegateCount: number; // effective (ladder-clamped) relegate count used for the zone diff
  currentRows: StandingRow[];
  countMode: StandingsPreviewCandidate;
  voidMode: StandingsPreviewCandidate;
  // Net-lives effect on the Current table, and a diff map for its rows (the
  // Current table has no OTHER per-player diff map today, unlike
  // countMode/voidMode, which already diff against Current for the
  // promotion/relegation notes). Always the zero value / empty map under
  // the page's default "chain" tiebreak.
  currentLivesInfo: StandingsPreviewLivesInfo;
  currentLivesDiffByPlayerId: Map<string, StandingsPreviewPlayerDiff>;
}

// One division's "who to treat as dropped" picker contents -- every
// division gets one of these regardless of whether it currently has any
// real or hypothetical dropout, since the picker needs to offer every
// division's roster.
export interface StandingsPreviewCandidateDivision {
  id: string;
  name: string;
  tierName: string;
  // Suggested candidates (per suggestDropCandidates), pre-tick material.
  candidates: DropCandidate[];
  // Every other ACTIVE member not already suggested, for the "add someone
  // else" picker.
  otherActiveMembers: { playerId: string; displayName: string }[];
}

export interface StandingsPreviewData {
  season: { id: string; label: string; scoringMode: SeasonScoringMode } | null;
  // Only divisions with at least one unreplaced (real or hypothetical)
  // dropout -- that's the only case where the tables can possibly differ.
  // Divisions with no dropout are counted in totalDivisions but not
  // rendered as their own card.
  divisions: StandingsPreviewDivision[];
  // Every division's what-if picker contents, regardless of whether it's
  // in `divisions` above.
  candidateDivisions: StandingsPreviewCandidateDivision[];
  // The currently-selected hypothetical drops that resolved to a real
  // ACTIVE member somewhere this season -- what the "Apply these drops"
  // form lists and submits.
  selectedDrops: StandingsPreviewSelectedDrop[];
  summary: {
    totalDivisions: number;
    divisionsWithDropout: number;
    countMode: { rankChanges: number; boundaryChanges: number };
    voidMode: { rankChanges: number; boundaryChanges: number };
    // Total ties broken by the net-lives tiebreak, summed across the
    // Current + Best N (count) + Best N (void) tables of every division.
    // Always 0 under the default "chain" tiebreak.
    livesTiesBroken: number;
  };
}

export interface StandingsPreviewSelectedDrop {
  playerId: string;
  displayName: string;
  divisionId: string;
  divisionName: string;
  tierName: string;
}

export interface LoadStandingsPreviewOptions {
  // Player ids to treat as dropped for this preview, even though they're
  // still a real ACTIVE member. Ids that don't resolve to an ACTIVE member
  // anywhere in the season are silently ignored (e.g. a stale query param).
  hypotheticalDroppedIds?: ReadonlySet<string>;
  // suggestDropCandidates options for the picker panel -- maxPlayed default
  // mirrors the core's documented intent (0 = never played).
  candidateMaxPlayed?: number;
  candidateInactiveDays?: number;
  // "chain" (default): today's tiebreak order, unchanged. "lives": preview
  // breaking ties by net lives instead -- see web/lib/standings.ts's
  // Tiebreak / computeNetLives. Purely a preview toggle (searchParams on
  // /admin/standings-preview); nothing here writes anything.
  tiebreak?: Tiebreak;
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

// Net-lives effect on one table: how many previously-tied rows got
// separated, and which rows (under "lives") are missing winnerLives data on
// a counted game. `chainRows`/`selectedRows` are the SAME engine/mode
// computed with tiebreak "chain" and the page's actual tiebreak option,
// respectively -- identical row sets (so zero effect) when the page's
// tiebreak is "chain".
function computeLivesTiebreakInfo(chainRows: StandingRow[], selectedRows: StandingRow[]): StandingsPreviewLivesInfo {
  const chainTiedById = new Map(chainRows.map((r) => [r.player.id, Boolean(r.tiedWithPrev)]));
  let tiesBroken = 0;
  const missingLives: StandingsPreviewLivesRow[] = [];
  for (const row of selectedRows) {
    if (chainTiedById.get(row.player.id) && !row.tiedWithPrev) tiesBroken++;
    if ((row.livesGamesMissing ?? 0) > 0) {
      missingLives.push({
        playerId: row.player.id,
        displayName: row.player.displayName,
        netLives: row.netLives ?? 0,
        livesGamesMissing: row.livesGamesMissing!,
      });
    }
  }
  return { tiesBroken, missingLives };
}

// Player ids whose rank differs between the SAME table computed with
// tiebreak "chain" vs the page's actual tiebreak option -- a rank change
// caused specifically by lives, as opposed to by best-N selection.
function livesRankChangedIds(chainRows: StandingRow[], selectedRows: StandingRow[]): Set<string> {
  const chainRankById = new Map(chainRows.map((r) => [r.player.id, r.rank ?? null]));
  const changed = new Set<string>();
  for (const row of selectedRows) {
    if ((chainRankById.get(row.player.id) ?? null) !== (row.rank ?? null)) changed.add(row.player.id);
  }
  return changed;
}

// The Current table has no OTHER-engine comparison (unlike count/void, which
// already diff against Current for the promotion/relegation notes) -- this
// builds a diff map with ONLY the lives-caused fields populated, reusing
// StandingsPreviewPlayerDiff's bestNRank/currentRank as "selected"/"chain"
// since that's the same "baseline vs alternate" meaning those fields
// already carry.
function buildLivesOnlyDiff(
  chainRows: StandingRow[],
  selectedRows: StandingRow[],
  activePlayers: { id: string; displayName: string }[],
): Map<string, StandingsPreviewPlayerDiff> {
  const chainById = new Map(chainRows.map((r) => [r.player.id, r]));
  const selectedById = new Map(selectedRows.map((r) => [r.player.id, r]));
  const map = new Map<string, StandingsPreviewPlayerDiff>();
  for (const p of activePlayers) {
    const chainRow = chainById.get(p.id);
    const selectedRow = selectedById.get(p.id);
    map.set(p.id, {
      playerId: p.id,
      displayName: p.displayName,
      currentRank: chainRow?.rank ?? null,
      currentPoints: chainRow?.points ?? 0,
      bestNRank: selectedRow?.rank ?? null,
      bestNPoints: selectedRow?.points ?? 0,
      bestNCounted: 0,
      bestNOf: 0,
      rankChanged: false,
      boundaryChanged: false,
      boundaryNote: null,
      livesRankChanged: (chainRow?.rank ?? null) !== (selectedRow?.rank ?? null),
    });
  }
  return map;
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
  livesChangedIds: ReadonlySet<string>,
  livesInfo: StandingsPreviewLivesInfo,
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
      livesRankChanged: livesChangedIds.has(p.id),
    };
  });

  return {
    rows: bestNRows,
    players,
    rankChangeCount: players.filter((p) => p.rankChanged).length,
    boundaryChangeCount: players.filter((p) => p.boundaryChanged).length,
    livesInfo,
  };
}

export async function loadStandingsPreview(
  seasonId: string,
  options: LoadStandingsPreviewOptions = {},
): Promise<StandingsPreviewData> {
  const hypotheticalDroppedIds = options.hypotheticalDroppedIds ?? new Set<string>();
  const candidateMaxPlayed = options.candidateMaxPlayed ?? 0;
  const candidateInactiveDays = options.candidateInactiveDays;
  const tiebreak = options.tiebreak ?? "chain";
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: {
      id: true,
      number: true,
      subtitle: true,
      scoringMode: true,
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
              opponentsPerPlayer: true,
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
                  confirmedAt: true,
                  reportedAt: true,
                  createdAt: true,
                  // Per-game lives, only read when tiebreak: "lives" is
                  // requested -- see web/lib/standings.ts's PairingGameLives.
                  games: { select: { winnerId: true, winnerLives: true } },
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
      candidateDivisions: [],
      selectedDrops: [],
      summary: {
        totalDivisions: 0,
        divisionsWithDropout: 0,
        countMode: { rankChanges: 0, boundaryChanges: 0 },
        voidMode: { rankChanges: 0, boundaryChanges: 0 },
        livesTiesBroken: 0,
      },
    };
  }

  const { scoring } = await getLeagueSettingsForSeason(season.id);
  const tierPositions = season.tiers.map((t) => t.position);
  const minTierPosition = tierPositions.length > 0 ? Math.min(...tierPositions) : 0;
  const maxTierPosition = tierPositions.length > 0 ? Math.max(...tierPositions) : 0;

  const divisions: StandingsPreviewDivision[] = [];
  const selectedDrops: StandingsPreviewSelectedDrop[] = [];
  // Flat, season-wide inputs for the pure suggestDropCandidates core --
  // gathered across every division (not just ones with a dropout) since
  // the picker panel needs every division's roster.
  const allDropCandidateMembers: DropCandidateMemberInput[] = [];
  const allDropCandidateMatches: DropCandidateMatchInput[] = [];
  const divisionMetaOrder: { id: string; name: string; tierName: string }[] = [];
  let totalDivisions = 0;
  const now = new Date();

  for (const tier of season.tiers) {
    for (const d of tier.divisions) {
      totalDivisions++;
      divisionMetaOrder.push({ id: d.id, name: d.name, tierName: tier.name });

      const leagueMatches = d.matches.filter((m) => m.format === "LEAGUE_BO2");
      const confirmedPairings: BestNPairing[] = leagueMatches
        .filter((m) => m.status === "CONFIRMED")
        .map((m) => ({
          playerAId: m.playerAId,
          playerBId: m.playerBId,
          gamesWonA: m.gamesWonA,
          gamesWonB: m.gamesWonB,
          games: m.games,
        }));
      const shootouts: ShootoutInput[] = d.matches
        .filter((m) => m.format === "SHOOTOUT_BO1" && m.status === "CONFIRMED" && m.winnerId !== null)
        .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId, winnerId: m.winnerId! }));

      for (const m of d.members) {
        allDropCandidateMembers.push({
          divisionId: d.id,
          playerId: m.playerId,
          displayName: m.player.displayName,
          status: m.status === "DROPPED" ? "DROPPED" : "ACTIVE",
          joinedAt: m.joinedAt,
        });
      }
      for (const m of leagueMatches) {
        allDropCandidateMatches.push({
          divisionId: d.id,
          playerAId: m.playerAId,
          playerBId: m.playerBId,
          status: m.status,
          lastActivityAt: m.confirmedAt ?? m.reportedAt ?? m.createdAt,
        });
      }

      // Every member's LIVE scheduled LEAGUE_BO2 matches (confirmed, pending or disputed;
      // never a cancelled one against a dropout, whose refill takes its place) -- this is
      // what the engine derives the division's matches-per-player from when the division
      // has no explicit setting, and what caps a replacement.
      const scheduledGamesByPlayerId = new Map<string, number>();
      for (const m of leagueMatches.filter((m) => m.status !== "CANCELLED")) {
        scheduledGamesByPlayerId.set(m.playerAId, (scheduledGamesByPlayerId.get(m.playerAId) ?? 0) + 1);
        scheduledGamesByPlayerId.set(m.playerBId, (scheduledGamesByPlayerId.get(m.playerBId) ?? 0) + 1);
      }

      // buildBestNMembers centralizes the mid-season "replacement" heuristic
      // (joined after another member's earliest real drop -- a guess, since
      // the schema has no explicit "replaces" link for the soft-drop +
      // later-add path) + each member's scheduledGames cap. Shared verbatim
      // with web/lib/standings-cache.ts and src/standings-cache.ts's live
      // standings path so the preview and the live best-n engine never
      // disagree on who counts as a replacement.
      const members: BestNMemberInput[] = buildBestNMembers(
        d.members.map((m) => ({
          player: m.player as BestNMemberInput["player"],
          status: m.status === "DROPPED" ? "DROPPED" : "ACTIVE",
          joinedAt: m.joinedAt,
          droppedAt: m.droppedAt,
        })),
        scheduledGamesByPlayerId,
      );

      // Players picked in the what-if panel, restricted to this division's
      // REAL ACTIVE members -- a stale/unknown id in hypotheticalDroppedIds
      // simply never matches here and is ignored.
      const hypotheticalIdsInDivision = new Set(
        d.members.filter((m) => m.status === "ACTIVE" && hypotheticalDroppedIds.has(m.playerId)).map((m) => m.playerId),
      );
      const effectiveMembers = withHypotheticalDrops(members, hypotheticalIdsInDivision);

      const activePlayers = effectiveMembers.filter((m) => m.status === "ACTIVE").map((m) => m.player);
      // "chain" baseline is always computed (cheap, pure) so lives-caused
      // rank changes/ties-broken can be diffed against it -- the DISPLAYED
      // rows only differ from it when the page's tiebreak option is "lives".
      const currentRowsChain = computeStandings(activePlayers, confirmedPairings, shootouts, scoring, "chain");
      const currentRows = tiebreak === "lives"
        ? computeStandings(activePlayers, confirmedPairings, shootouts, scoring, "lives")
        : currentRowsChain;
      const bestNCountChain = computeBestNStandings(effectiveMembers, confirmedPairings, shootouts, scoring, "count", d.opponentsPerPlayer ?? null, "chain");

      if (bestNCountChain.division.dropouts === 0) continue; // nothing to preview here (same for both modes)

      const bestNCount = tiebreak === "lives"
        ? computeBestNStandings(effectiveMembers, confirmedPairings, shootouts, scoring, "count", d.opponentsPerPlayer ?? null, "lives")
        : bestNCountChain;
      const bestNVoidChain = computeBestNStandings(effectiveMembers, confirmedPairings, shootouts, scoring, "void", d.opponentsPerPlayer ?? null, "chain");
      const bestNVoid = tiebreak === "lives"
        ? computeBestNStandings(effectiveMembers, confirmedPairings, shootouts, scoring, "void", d.opponentsPerPlayer ?? null, "lives")
        : bestNVoidChain;

      const effectivePromote = tier.position === minTierPosition
        ? 0
        : Math.min(d.promoteCount, currentRows.length);
      const effectiveRelegate = tier.position === maxTierPosition
        ? 0
        : Math.min(d.relegateCount, currentRows.length);

      const currentLivesInfo = computeLivesTiebreakInfo(currentRowsChain, currentRows);
      const currentLivesDiffByPlayerId = buildLivesOnlyDiff(currentRowsChain, currentRows, activePlayers);
      const countMode = buildCandidate(
        currentRows, bestNCount.rows, activePlayers, effectivePromote, effectiveRelegate,
        livesRankChangedIds(bestNCountChain.rows, bestNCount.rows),
        computeLivesTiebreakInfo(bestNCountChain.rows, bestNCount.rows),
      );
      const voidMode = buildCandidate(
        currentRows, bestNVoid.rows, activePlayers, effectivePromote, effectiveRelegate,
        livesRankChangedIds(bestNVoidChain.rows, bestNVoid.rows),
        computeLivesTiebreakInfo(bestNVoidChain.rows, bestNVoid.rows),
      );

      const hypotheticalDrops = d.members
        .filter((m) => hypotheticalIdsInDivision.has(m.playerId))
        .map((m) => ({ playerId: m.playerId, displayName: m.player.displayName }));
      for (const hd of hypotheticalDrops) {
        selectedDrops.push({ playerId: hd.playerId, displayName: hd.displayName, divisionId: d.id, divisionName: d.name, tierName: tier.name });
      }

      divisions.push({
        id: d.id,
        name: d.name,
        tierName: tier.name,
        k: bestNCount.division.k,
        n: bestNCount.division.n,
        scheduled: bestNCount.division.scheduled,
        dropouts: bestNCount.division.dropouts,
        hypotheticalDrops,
        promoteCount: effectivePromote,
        relegateCount: effectiveRelegate,
        currentRows,
        countMode,
        voidMode,
        currentLivesInfo,
        currentLivesDiffByPlayerId,
      });
    }
  }

  const suggested = suggestDropCandidates(allDropCandidateMembers, allDropCandidateMatches, now, {
    maxPlayed: candidateMaxPlayed,
    inactiveDays: candidateInactiveDays,
  });
  const suggestedByDivision = new Map<string, DropCandidate[]>();
  for (const c of suggested) {
    const list = suggestedByDivision.get(c.divisionId) ?? [];
    list.push(c);
    suggestedByDivision.set(c.divisionId, list);
  }
  const candidateDivisions: StandingsPreviewCandidateDivision[] = divisionMetaOrder.map((meta) => {
    const candidates = suggestedByDivision.get(meta.id) ?? [];
    const candidateIds = new Set(candidates.map((c) => c.playerId));
    const otherActiveMembers = allDropCandidateMembers
      .filter((m) => m.divisionId === meta.id && m.status === "ACTIVE" && !candidateIds.has(m.playerId))
      .map((m) => ({ playerId: m.playerId, displayName: m.displayName }));
    return { id: meta.id, name: meta.name, tierName: meta.tierName, candidates, otherActiveMembers };
  });

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
    livesTiesBroken: divisions.reduce(
      (sum, dd) => sum + dd.currentLivesInfo.tiesBroken + dd.countMode.livesInfo.tiesBroken + dd.voidMode.livesInfo.tiesBroken,
      0,
    ),
  };

  return {
    season: { id: season.id, label: formatSeasonLabel(season), scoringMode: normalizeScoringMode(season.scoringMode) },
    divisions,
    candidateDivisions,
    selectedDrops,
    summary,
  };
}

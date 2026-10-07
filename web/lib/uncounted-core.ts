// Pure core for "why wasn't this match counted toward the standings" --
// backs the muted match-row tag on the division page and the profile's
// match history. A best-N scoring mode (season.scoringMode
// "best-n-count" | "best-n-void", see standings-mode.ts) sets some of a
// player's results aside: either because the opponent was an unreplaced
// DROPPED member ("dropout" -- under the "void" variant this is set aside
// for EVERYONE who played them, not just the one player) or simply because
// the result was their worst ("worst" -- cut by best-N selection). "all"
// mode, and a best-n mode with zero unreplaced dropouts, never produce any
// uncounted entries at all.
//
// Zero imports -- same convention as web/lib/standings-best-n.ts. Mirrored
// (data shape + buildUncounted only, no display helper) at
// src/uncounted-core.ts for the bot's identical cache-write path -- see
// that file's header.

export type UncountedReason = "dropout" | "worst";

// On-disk shape of one entry in DivisionStandings.rowsJson's `uncounted`
// list (see standings-cache.ts's CachedPayload).
export interface UncountedEntry {
  // Canonical, order-independent key for the pair -- built the same way
  // regardless of which side was playerA/playerB in the match row, so a
  // caller holding either order can look an entry up. Uses "|" rather than
  // web/lib/unplayed-pairs.ts's pairKey "-" separator because player ids are
  // cuids that can themselves contain "-".
  matchKey: string;
  forPlayerId: string;
  reason: UncountedReason;
}

export interface UncountedTag {
  reason: UncountedReason;
  label: string;
  title: string;
}

// Canonical matchKey for an unordered pair of player ids.
export function uncountedMatchKey(playerAId: string, playerBId: string): string {
  return playerAId < playerBId ? `${playerAId}|${playerBId}` : `${playerBId}|${playerAId}`;
}

// Looks up whether a specific match is set aside for a specific player, and
// if so, what the UI should show. Returns null when the match counts
// normally for that player -- including every match in an "all"-mode
// season, where `uncounted` is always empty.
export function uncountedTag(
  uncounted: readonly UncountedEntry[],
  playerAId: string,
  playerBId: string,
  forPlayerId: string,
): UncountedTag | null {
  const key = uncountedMatchKey(playerAId, playerBId);
  const entry = uncounted.find((u) => u.matchKey === key && u.forPlayerId === forPlayerId);
  if (!entry) return null;
  return entry.reason === "dropout"
    ? {
        reason: "dropout",
        label: "not counted for standings",
        title: "Against a dropped player -- set aside for everyone.",
      }
    : {
        reason: "worst",
        label: "not counted for standings",
        title: "Their worst result -- set aside under best N.",
      };
}

// Inputs for buildUncounted below -- plain data, structurally compatible
// with the richer shapes standings-cache.ts already has in hand (a
// DivisionMember-ish row, a BestNStandingRow, a BestNPairing) without this
// pure module needing to import any of their (Prisma-typed) definitions.
export interface UncountedSourceMember {
  playerId: string;
  status: "ACTIVE" | "DROPPED";
}
export interface UncountedSourceRow {
  playerId: string;
  droppedResults: readonly { opponentId: string }[];
}
export interface UncountedSourcePairing {
  playerAId: string;
  playerBId: string;
}

// Derives the full `uncounted` list for a division's cache payload from the
// best-N engine's own output. Two sources:
//   1. Every row's droppedResults -- the results that engine already picked
//      as NOT among that player's best N. "dropout" when the opponent is a
//      DROPPED member, "worst" otherwise.
//   2. Under "void" mode only: a dropout's results are stripped from every
//      player's candidate pool BEFORE best-N selection even runs (see
//      standings-best-n.ts), so they never surface via droppedResults above
//      -- recovered here directly from the live pairings.
export function buildUncounted(
  members: readonly UncountedSourceMember[],
  rows: readonly UncountedSourceRow[],
  pairings: readonly UncountedSourcePairing[],
  dropoutGames: "count" | "void",
): UncountedEntry[] {
  const droppedIds = new Set(members.filter((m) => m.status === "DROPPED").map((m) => m.playerId));
  const activeIds = new Set(rows.map((r) => r.playerId));
  const out: UncountedEntry[] = [];

  for (const row of rows) {
    for (const dr of row.droppedResults) {
      out.push({
        matchKey: uncountedMatchKey(row.playerId, dr.opponentId),
        forPlayerId: row.playerId,
        reason: droppedIds.has(dr.opponentId) ? "dropout" : "worst",
      });
    }
  }

  if (dropoutGames === "void") {
    for (const pr of pairings) {
      const aDropped = droppedIds.has(pr.playerAId);
      const bDropped = droppedIds.has(pr.playerBId);
      if (aDropped === bDropped) continue; // neither dropped (normal result), or both (ghost pairing)
      const activePlayerId = aDropped ? pr.playerBId : pr.playerAId;
      if (!activeIds.has(activePlayerId)) continue; // not a current standing row
      out.push({
        matchKey: uncountedMatchKey(pr.playerAId, pr.playerBId),
        forPlayerId: activePlayerId,
        reason: "dropout",
      });
    }
  }

  return out;
}

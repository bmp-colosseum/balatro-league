// Pure core mirroring web/lib/uncounted-core.ts's data shape + buildUncounted
// EXACTLY, so whichever side (bot recompute or web cold-cache compute) last
// wrote a division's DivisionStandings.rowsJson produces an identical
// `uncounted` payload -- same convention as standings-best-n.ts's header. The
// bot never renders a per-match tag (its live-standings post only needs each
// row's counted/of numbers), so uncountedTag + its display strings live only
// on the web side; this copy carries just the data types + the builder that
// computes what goes into the cache.
//
// Zero imports.

export interface UncountedEntry {
  matchKey: string;
  forPlayerId: string;
}

// Canonical matchKey for an unordered pair of player ids. Uses "|" rather
// than a "-" separator because player ids are cuids that can themselves
// contain "-".
export function uncountedMatchKey(playerAId: string, playerBId: string): string {
  return playerAId < playerBId ? `${playerAId}|${playerBId}` : `${playerBId}|${playerAId}`;
}

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
      out.push({ matchKey: uncountedMatchKey(row.playerId, dr.opponentId), forPlayerId: row.playerId });
    }
  }

  if (dropoutGames === "void") {
    for (const pr of pairings) {
      const aDropped = droppedIds.has(pr.playerAId);
      const bDropped = droppedIds.has(pr.playerBId);
      if (aDropped === bDropped) continue;
      const activePlayerId = aDropped ? pr.playerBId : pr.playerAId;
      if (!activeIds.has(activePlayerId)) continue;
      out.push({ matchKey: uncountedMatchKey(pr.playerAId, pr.playerBId), forPlayerId: activePlayerId });
    }
  }

  return out;
}

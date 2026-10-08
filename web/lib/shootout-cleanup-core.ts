// Pure core for the admin "shootout clean-up" tool
// (web/app/admin/standings-preview). The TO used to break lives ties by
// hand-recording pairwise SHOOTOUT_BO1 matches via resolveTieWithShowdowns
// (web/lib/match-admin.ts). Now that a season can set tiebreak: "lives"
// (web/lib/standings-mode.ts's normalizeTiebreak), those admin-recorded
// shootouts are redundant wherever lives would have picked the SAME winner
// -- deleting them changes nothing in sortStandings (web/lib/standings.ts),
// since lives only gets consulted after shootout in the tiebreak chain.
// This function decides, per recorded shootout, whether it's safe to
// delete (lives agrees) or must stay (lives disagrees, is tied, has no
// data, or the result came from the players themselves rather than an
// admin resolve-tie).
//
// Zero I/O: the caller (web/lib/loaders/shootout-cleanup.ts) is responsible
// for loading the shootout rows and computing each player's net lives (via
// computeNetLives in web/lib/standings.ts) before calling this.

export interface ShootoutCleanupInput {
  id: string;
  divisionId: string;
  playerAId: string;
  playerBId: string;
  winnerId: string | null;
  // A Discord id (or "self-report") for a player-reported result, or null
  // for a showdown admin-recorded via resolveTieWithShowdowns. See the
  // Match.recordedBy comment in web/prisma/schema.prisma -- this field is
  // what distinguishes an admin tie-break recording from a normal result.
  recordedBy: string | null;
}

// Net life differential for one player, as computed by computeNetLives in
// web/lib/standings.ts over their division's counted pairings -- the SAME
// input the "lives" tiebreak itself uses, so this plan can never disagree
// with what switching the season to tiebreak: "lives" would actually do.
export interface PlayerNetLives {
  netLives: number;
  livesGamesMissing: number;
}

export type ShootoutCleanupVerdict =
  | "same" // lives picks the same winner -- safe to delete
  | "lives-disagree" // lives picks the OTHER player -- must keep
  | "lives-tied" // lives doesn't break this pair at all -- must keep
  | "no-lives-data" // winner/lives data incomplete -- must keep
  | "player-reported"; // not an admin tie-break recording -- always keep

export interface ShootoutCleanupEntry {
  id: string;
  divisionId: string;
  playerAId: string;
  playerBId: string;
  winnerId: string | null;
  // Each player's net lives, when known -- null when that player has no
  // entry in netLivesByPlayerId (not an active member of this division's
  // standings run). Present even for a "no-lives-data" verdict caused by
  // livesGamesMissing, so the UI can still show what lives data exists.
  livesA: number | null;
  livesB: number | null;
  verdict: ShootoutCleanupVerdict;
}

export interface ShootoutCleanupPlan {
  deletable: ShootoutCleanupEntry[];
  keep: ShootoutCleanupEntry[];
}

// Classifies every recorded shootout and splits it into "deletable" (lives
// decides the same way, so removing it changes no standings order) and
// "keep" (everything else). Input order is preserved within each output
// array.
export function planShootoutCleanup(
  shootouts: ShootoutCleanupInput[],
  netLivesByPlayerId: Map<string, PlayerNetLives | undefined>,
): ShootoutCleanupPlan {
  const deletable: ShootoutCleanupEntry[] = [];
  const keep: ShootoutCleanupEntry[] = [];

  for (const s of shootouts) {
    const livesA = netLivesByPlayerId.get(s.playerAId);
    const livesB = netLivesByPlayerId.get(s.playerBId);
    const entry: ShootoutCleanupEntry = {
      id: s.id,
      divisionId: s.divisionId,
      playerAId: s.playerAId,
      playerBId: s.playerBId,
      winnerId: s.winnerId,
      livesA: livesA?.netLives ?? null,
      livesB: livesB?.netLives ?? null,
      verdict: classify(s, livesA, livesB),
    };
    (entry.verdict === "same" ? deletable : keep).push(entry);
  }

  return { deletable, keep };
}

function classify(
  s: ShootoutCleanupInput,
  livesA: PlayerNetLives | undefined,
  livesB: PlayerNetLives | undefined,
): ShootoutCleanupVerdict {
  if (s.recordedBy === null) return "player-reported";
  if (s.winnerId === null) return "no-lives-data";
  if (livesA === undefined || livesB === undefined) return "no-lives-data";
  if (livesA.livesGamesMissing > 0 || livesB.livesGamesMissing > 0) return "no-lives-data";
  if (livesA.netLives === livesB.netLives) return "lives-tied";

  const winnerLives = s.winnerId === s.playerAId ? livesA.netLives : livesB.netLives;
  const loserLives = s.winnerId === s.playerAId ? livesB.netLives : livesA.netLives;
  return winnerLives > loserLives ? "same" : "lives-disagree";
}

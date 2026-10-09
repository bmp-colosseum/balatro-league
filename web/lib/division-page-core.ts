// Pure core for the v2 "Card Table" division page's matchup grouping. Zero
// imports by design (see web/lib/drop-candidates-core.ts for the same
// convention) -- the page/loader map their own richer row shapes down to
// the plain Pairing union below, call groupPairings, then render.
//
// A single division's matchups come from two different loader lists
// (unplayed pairs, confirmed pairings) with different shapes; Pairing
// unifies them into one discriminated type so the v2 "vs" blocks can
// render either kind with one component, and this module can group/sort
// them without caring which loader a given pairing came from.

export interface PairingParticipant {
  id: string;
  displayName: string;
}

export interface UnplayedPairing {
  played: false;
  a: PairingParticipant;
  b: PairingParticipant;
}

export interface PlayedPairing {
  played: true;
  // Stable identity for the match row (used as the React key upstream).
  id: string;
  date: Date | null;
  a: PairingParticipant;
  b: PairingParticipant;
  scoreA: number;
  scoreB: number;
  forfeit: boolean;
}

export type Pairing = UnplayedPairing | PlayedPairing;

export interface GroupedPairings {
  // Pairings involving the viewer -- unplayed first (actionable), then
  // played (newest first). Always empty when viewerPlayerId is null.
  yours: Pairing[];
  // Unplayed pairings NOT involving the viewer, in input order.
  toPlay: Pairing[];
  // Played pairings NOT involving the viewer, newest first.
  played: Pairing[];
}

function involvesPlayer(p: Pairing, playerId: string | null): boolean {
  return playerId !== null && (p.a.id === playerId || p.b.id === playerId);
}

// Newest first; a pairing with no recorded date (shouldn't normally happen
// for a played match, but the loader's `date` is nullable) sorts last.
function byNewestFirst(a: PlayedPairing, b: PlayedPairing): number {
  const at = a.date ? a.date.getTime() : -Infinity;
  const bt = b.date ? b.date.getTime() : -Infinity;
  return bt - at;
}

// Splits every pairing into exactly one of three buckets for the v2 page's
// "Your matches" / "Still to play" / "Played" sections -- no pairing ever
// appears twice, and nothing is dropped. Pure: same input always produces
// the same grouping, independent of render order.
export function groupPairings(
  pairings: Pairing[],
  viewerPlayerId: string | null,
): GroupedPairings {
  const yoursUnplayed: UnplayedPairing[] = [];
  const yoursPlayed: PlayedPairing[] = [];
  const toPlay: UnplayedPairing[] = [];
  const playedOthers: PlayedPairing[] = [];

  for (const p of pairings) {
    const mine = involvesPlayer(p, viewerPlayerId);
    if (p.played) {
      (mine ? yoursPlayed : playedOthers).push(p);
    } else {
      (mine ? yoursUnplayed : toPlay).push(p);
    }
  }

  const sortedYoursPlayed = [...yoursPlayed].sort(byNewestFirst);
  const sortedPlayedOthers = [...playedOthers].sort(byNewestFirst);

  return {
    yours: [...yoursUnplayed, ...sortedYoursPlayed],
    toPlay,
    played: sortedPlayedOthers,
  };
}

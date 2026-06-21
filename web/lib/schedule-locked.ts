// Single source of truth for "is this division/season on a fixed (locked)
// schedule?" — the graph or pre-created round-robin format, as opposed to
// legacy on-demand round-robin.
//
// This logic used to be copy-pasted across ~10 loaders. The subtlety it
// encodes: Season.scheduleLocked is ONLY a fast-path. The flag has proven
// unreliable (it can stick stale — e.g. it's set when schedules are locked but
// never cleared if matches are removed), so the AUTHORITATIVE signal is the
// existence of a pre-created, never-played 0-0 PENDING match. The flag just
// lets us short-circuit when it's correctly set.

// The minimal shape both checks need. Match/Pairing rows from any select that
// includes these three columns satisfy it (Prisma's PairingStatus is assignable
// to string).
export type UnplayableMatch = {
  status: string;
  gamesWonA: number;
  gamesWonB: number;
};

// A pre-created schedule slot that's never been played: a 0-0 PENDING series.
// Its presence is the ground-truth marker that a division was graph- or
// round-robin-scheduled at activation.
export function isUnplayedPending(m: UnplayableMatch): boolean {
  return m.status === "PENDING" && m.gamesWonA === 0 && m.gamesWonB === 0;
}

// True when the schedule is locked. Pass the flag plus the matches relevant to
// the scope you're checking — a division's matches, or a single player's
// pairings. The flag short-circuits; otherwise we look for a pre-created slot.
export function isScheduleLocked(
  seasonScheduleLocked: boolean,
  matches: readonly UnplayableMatch[],
): boolean {
  return seasonScheduleLocked || matches.some(isUnplayedPending);
}

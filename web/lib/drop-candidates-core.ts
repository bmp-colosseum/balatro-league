// Pure core for the "who would I drop" what-if layer on top of the best-N
// standings preview (web/app/admin/standings-preview). Zero prisma/react
// imports -- same convention as web/lib/standings-best-n.ts. The shell
// (web/lib/loaders/standings-preview.ts) resolves Prisma rows into the
// plain inputs below; this file only decides.
//
// Two pure operations:
//   - suggestDropCandidates: given the real ACTIVE roster + their match
//     history, which players look droppable right now (no/low activity)?
//   - withHypotheticalDrops: given a real roster + a chosen set of player
//     ids, return the SAME roster with those ids marked DROPPED -- so the
//     existing computeBestNStandings/computeStandings machinery can run
//     against a hypothetical world without caring that the drop isn't
//     real yet.

export type DropCandidateReason = "no-games" | "inactive";

export interface DropCandidateMemberInput {
  divisionId: string;
  playerId: string;
  displayName: string;
  status: "ACTIVE" | "DROPPED";
  // Membership start -- doubles as the "last activity" floor for a member
  // who has never played a game, so a brand-new joiner isn't flagged
  // "inactive" relative to the epoch.
  joinedAt: Date;
}

export interface DropCandidateMatchInput {
  divisionId: string;
  playerAId: string;
  playerBId: string;
  // Only "CONFIRMED" counts as a played game; anything else (e.g. "PENDING")
  // is a scheduled-but-unplayed game.
  status: "CONFIRMED" | "PENDING" | string;
  // Shell-resolved single timestamp for this match (e.g.
  // confirmedAt ?? reportedAt ?? createdAt) -- the core just compares it.
  lastActivityAt: Date;
}

export interface SuggestDropOptions {
  // A player with at most this many CONFIRMED games is a candidate. Default
  // intent is 0 (never played), but the caller decides -- the core has no
  // default of its own.
  maxPlayed: number;
  // When set, a player whose most recent activity (a confirmed/pending
  // match, or their joinedAt if they have none) is at least this many days
  // before `now` is also a candidate. Omitted/undefined = inactivity check
  // is off entirely.
  inactiveDays?: number;
}

export interface DropCandidate {
  divisionId: string;
  playerId: string;
  displayName: string;
  playedCount: number;
  unplayedCount: number;
  lastActivityAt: Date;
  reasons: DropCandidateReason[];
}

const MS_PER_DAY = 86_400_000;

// Per-division ACTIVE players who look droppable: too few confirmed games,
// or too long without activity (when inactiveDays is given). Never returns
// an already-DROPPED member -- only "status": "ACTIVE" rows are even
// considered. Deterministic order: input member order.
export function suggestDropCandidates(
  members: DropCandidateMemberInput[],
  matches: DropCandidateMatchInput[],
  now: Date,
  options: SuggestDropOptions,
): DropCandidate[] {
  const { maxPlayed, inactiveDays } = options;
  const candidates: DropCandidate[] = [];

  for (const member of members) {
    if (member.status !== "ACTIVE") continue;

    const own = matches.filter(
      (m) =>
        m.divisionId === member.divisionId &&
        (m.playerAId === member.playerId || m.playerBId === member.playerId),
    );
    const playedCount = own.filter((m) => m.status === "CONFIRMED").length;
    const unplayedCount = own.length - playedCount;
    const lastActivityAt = own.reduce(
      (latest, m) => (m.lastActivityAt > latest ? m.lastActivityAt : latest),
      member.joinedAt,
    );

    const reasons: DropCandidateReason[] = [];
    if (playedCount <= maxPlayed) reasons.push("no-games");
    if (inactiveDays !== undefined) {
      const daysSince = (now.getTime() - lastActivityAt.getTime()) / MS_PER_DAY;
      if (daysSince >= inactiveDays) reasons.push("inactive");
    }

    if (reasons.length > 0) {
      candidates.push({
        divisionId: member.divisionId,
        playerId: member.playerId,
        displayName: member.displayName,
        playedCount,
        unplayedCount,
        lastActivityAt,
        reasons,
      });
    }
  }

  return candidates;
}

// Returns `members` with every ACTIVE row whose player.id is in
// `droppedIds` switched to DROPPED -- everything else (including any
// extra fields a caller's own member shape carries, e.g. isReplacement /
// scheduledGames on BestNMemberInput) passes through untouched. Generic
// over any member shape with a `player.id` + ACTIVE/DROPPED status so it
// composes directly with computeBestNStandings's BestNMemberInput without
// this file importing that type.
//
// - Empty `droppedIds` is the identity: returns `members` as-is.
// - A member already DROPPED is left alone (idempotent: applying the same
//   droppedIds twice produces the same result as applying it once).
export function withHypotheticalDrops<
  M extends { player: { id: string }; status: "ACTIVE" | "DROPPED" },
>(members: M[], droppedIds: ReadonlySet<string>): M[] {
  if (droppedIds.size === 0) return members;
  return members.map((m) =>
    m.status === "ACTIVE" && droppedIds.has(m.player.id) ? { ...m, status: "DROPPED" as const } : m,
  );
}

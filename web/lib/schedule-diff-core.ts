// Pure core for diffing two schedule snapshots (lists of player-pairs) to find
// which players' opponent sets changed. Drives the "your opponents changed"
// correction DM sent after a division's schedule is regenerated. Zero
// imports -- colocated test runs under the root vitest project (see
// vitest.config.ts's `include: ["web/lib/**/*.test.ts"]`).

export interface Pairing {
  playerAId: string;
  playerBId: string;
}

export interface OpponentDiff {
  playerId: string;
  added: string[];
  removed: string[];
}

// Builds playerId -> unique-opponent-set from a pairing list. Each pairing
// contributes an edge in both directions; a duplicate (unordered) pairing
// collapses to one edge via the Set, so repeats in the input never inflate
// the result.
function opponentsByPlayer(pairings: Pairing[]): Map<string, Set<string>> {
  const byPlayer = new Map<string, Set<string>>();
  const add = (playerId: string, opponentId: string) => {
    let set = byPlayer.get(playerId);
    if (!set) {
      set = new Set<string>();
      byPlayer.set(playerId, set);
    }
    set.add(opponentId);
  };
  for (const { playerAId, playerBId } of pairings) {
    add(playerAId, playerBId);
    add(playerBId, playerAId);
  }
  return byPlayer;
}

// Returns, per player whose opponent set changed between `before` and
// `after`, the opponents gained and lost -- sorted, deduped, and independent
// of the order either pairing list was built in. A player whose set is
// unchanged (including a player absent from both snapshots) is omitted
// entirely. Result is sorted by playerId for a deterministic recipient list.
export function diffOpponents(before: Pairing[], after: Pairing[]): OpponentDiff[] {
  const beforeByPlayer = opponentsByPlayer(before);
  const afterByPlayer = opponentsByPlayer(after);
  const playerIds = new Set<string>([...beforeByPlayer.keys(), ...afterByPlayer.keys()]);

  const diffs: OpponentDiff[] = [];
  for (const playerId of playerIds) {
    const beforeSet = beforeByPlayer.get(playerId) ?? new Set<string>();
    const afterSet = afterByPlayer.get(playerId) ?? new Set<string>();
    const added = [...afterSet].filter((id) => !beforeSet.has(id)).sort();
    const removed = [...beforeSet].filter((id) => !afterSet.has(id)).sort();
    if (added.length > 0 || removed.length > 0) {
      diffs.push({ playerId, added, removed });
    }
  }
  diffs.sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
  return diffs;
}

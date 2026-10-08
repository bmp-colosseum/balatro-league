// Pure: which promotion/relegation lines does the net-lives tiebreak decide?
// A mid-table tie is cosmetic; the TO only cares when a tie that today's chain
// cannot break sits ON a promotion or relegation line. Given the same table
// ranked by today's chain and by net lives, this returns one plain sentence per
// line that lives decided (or left tied).

export interface LineRow {
  playerId: string;
  displayName: string;
  tiedWithPrev?: boolean;
  netLives?: number;
}

function tieGroups(rows: LineRow[]): Array<[number, number]> {
  const groups: Array<[number, number]> = [];
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i === rows.length || !rows[i].tiedWithPrev) {
      if (i - 1 > start) groups.push([start, i - 1]);
      start = i;
    }
  }
  return groups;
}

export function lineDecisions(chainRows: LineRow[], livesRows: LineRow[], promoteCount: number, relegateCount: number): string[] {
  const n = chainRows.length;
  const livesIndex = new Map(livesRows.map((r, i) => [r.playerId, i]));
  const byId = new Map(livesRows.map((r) => [r.playerId, r]));
  const out: string[] = [];
  for (const [s, e] of tieGroups(chainRows)) {
    const members = chainRows.slice(s, e + 1).map((r) => byId.get(r.playerId) ?? r);
    const ordered = members.slice().sort((a, b) => (livesIndex.get(a.playerId) ?? 0) - (livesIndex.get(b.playerId) ?? 0));
    const lives = (r: LineRow) => `${(r.netLives ?? 0) >= 0 ? "+" : ""}${r.netLives ?? 0}`;
    const stillTied = ordered.every((r, i) => i === 0 || (r.tiedWithPrev ?? false));
    const promoLine = promoteCount > 0 && s < promoteCount && e >= promoteCount;
    const relegLine = relegateCount > 0 && s < n - relegateCount && e >= n - relegateCount;
    if (!promoLine && !relegLine) continue;
    const names = ordered.map((r) => `${r.displayName} (${lives(r)})`).join(", ");
    if (stillTied) {
      out.push(`${promoLine ? "Promotion" : "Relegation"} line still tied on lives: ${names}`);
      continue;
    }
    if (promoLine) {
      const up = ordered.filter((r) => (livesIndex.get(r.playerId) ?? n) < promoteCount);
      const down = ordered.filter((r) => (livesIndex.get(r.playerId) ?? n) >= promoteCount);
      out.push(`Promotion: ${up.map((r) => `${r.displayName} (${lives(r)})`).join(", ")} over ${down.map((r) => `${r.displayName} (${lives(r)})`).join(", ")}`);
    }
    if (relegLine) {
      const safe = ordered.filter((r) => (livesIndex.get(r.playerId) ?? n) < n - relegateCount);
      const drop = ordered.filter((r) => (livesIndex.get(r.playerId) ?? n) >= n - relegateCount);
      out.push(`Relegation: ${drop.map((r) => `${r.displayName} (${lives(r)})`).join(", ")} down instead of ${safe.map((r) => `${r.displayName} (${lives(r)})`).join(", ")}`);
    }
  }
  return out;
}

// Parse the cross-season `alltime/Player Stats.html` career sheet. One row per
// player. Columns (data positions): 0=Player, 2=Avg.Seed, 3=Seasons, 4=Rookie
// season, 5=Championships, 6=Finals made, 7=Playoffs made, 8..13=set/game W-L+%,
// 14=Captain (1/0). We take only the counters we can't derive from our
// (champion-path-only) playoff data: avg seed + championships/finals/playoffs made.

import { parseSheet } from "./sheet.mjs";

const num = (v) => {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace("%", ""));
  return Number.isFinite(n) ? n : null;
};

export function parsePlayerStats(path) {
  const rows = parseSheet(path);
  const out = [];
  for (const r of rows) {
    const name = (r[0] || "").trim();
    if (!name || name === "Player") continue;
    // A real data row has a numeric Championships cell (col 5).
    const champ = num(r[5]);
    if (r[5] === undefined || String(r[5]).trim() === "" || champ === null) continue;
    out.push({
      name,
      avgSeed: num(r[2]),
      rookieSeason: num(r[4]),
      championships: champ,
      finalsMade: num(r[6]) ?? 0,
      playoffsMade: num(r[7]) ?? 0,
      everCaptain: (r[14] || "").trim() === "1",
    });
  }
  return out;
}

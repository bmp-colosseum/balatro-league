// Runtime readers for a season's xlsx export (the Google-Sheets download). These
// pull the data that ISN'T in the HTML "alltime" export — conference + seed
// assignments (Standings tab) and signup preferred-name → Discord @username
// (signups tab) — so the importer reads them from the uploaded file instead of
// from baked-in config. Operates on the positional cell grid from xlsx-grid.mjs.
import { loadWorkbook, tabGrid } from "./xlsx-grid.mjs";

// Standings grid → { "Pluto Conference": [[team, seed], ...], ... }. Conferences
// sit in side-by-side column blocks (merged headers span their block); each team
// cell directly follows its seed integer. Maps every team column to the nearest
// "X Conference" header at or before it. Mirrors parse-conferences.mjs but keeps
// the seed and preserves first-seen order (so the seed list is in seed order).
export function conferencesFromStandingsGrid(rows) {
  if (!rows?.length) return {};

  // First row carrying "… Conference" headers → their column positions.
  let headers = [];
  for (const r of rows) {
    const hs = r.map((c, i) => ({ c: (c ?? "").trim(), i })).filter((x) => /conference$/i.test(x.c));
    if (hs.length) {
      // Collapse merged duplicates: keep the leftmost column for each distinct name.
      const byName = new Map();
      for (const h of hs) {
        const name = h.c.trim(); // keep the full "X Conference" header as the name
        if (!byName.has(name) || h.i < byName.get(name)) byName.set(name, h.i);
      }
      headers = [...byName].map(([name, col]) => ({ name, col }));
      break;
    }
  }
  if (!headers.length) return {};

  // Teams by the column they appear in, with their seed. A team cell follows a
  // seed integer 1..30 and contains letters.
  const byCol = new Map(); // teamCol → [[team, seed], ...] (first-seen order)
  for (const r of rows) {
    for (let i = 0; i < r.length - 1; i++) {
      const seed = Number(r[i]);
      const team = (r[i + 1] ?? "").trim();
      if (
        Number.isInteger(seed) && seed >= 1 && seed <= 30 &&
        team && /[A-Za-z]/.test(team) && !/conference|^seed$|^team$/i.test(team)
      ) {
        const col = i + 1;
        if (!byCol.has(col)) byCol.set(col, []);
        const list = byCol.get(col);
        if (!list.some(([t]) => t === team)) list.push([team, seed]);
      }
    }
  }

  // Each team column → nearest conference header at or before it.
  const result = {};
  for (const [teamCol, teams] of byCol) {
    let best = null;
    for (const h of headers) if (h.col <= teamCol && (!best || h.col > best.col)) best = h;
    if (!best) continue;
    const acc = (result[best.name] ??= []);
    for (const pair of teams) if (!acc.some(([t]) => t === pair[0])) acc.push(pair);
  }
  // Sort each conference by seed.
  for (const name of Object.keys(result)) result[name].sort((a, b) => a[1] - b[1]);
  return result;
}

// Signups grid → [{ preferredName, username }]. Finds the header row carrying a
// "Discord username" column and a "Preferred name" column, then reads each data row.
export function signupsFromGrid(rows) {
  if (!rows?.length) return [];
  let userCol = -1, prefCol = -1, headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = rows[i].map((c) => (c ?? "").toLowerCase());
    const u = r.findIndex((c) => c.includes("discord") && c.includes("username"));
    const p = r.findIndex((c) => c.includes("preferred name"));
    if (u >= 0 && p >= 0) { userCol = u; prefCol = p; headerRow = i; break; }
  }
  if (headerRow < 0) return [];

  const out = [];
  const seen = new Set();
  for (let i = headerRow + 1; i < rows.length; i++) {
    const username = (rows[i][userCol] ?? "").trim();
    const preferredName = (rows[i][prefCol] ?? "").trim();
    if (!username || !preferredName) continue;
    const key = preferredName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ preferredName, username });
  }
  return out;
}

// Draft Results grid → [{ team, captain, players:[...], subs:[...] }]. Teams are laid
// out as COLUMNS (every team's name spans 2 merged cells, with a gap column between);
// the label column (col 0) reads "Captain", "Player 1".."Player N", "Sub". Used to
// import the conference season's rosters + draft order (the HTML "alltime" export
// doesn't include that season).
export function draftTeamsFromGrid(rows) {
  if (!rows?.length) return [];
  const norm = (s) => (s ?? "").trim().toLowerCase();
  const capRow = rows.findIndex((r) => norm(r[0]) === "captain");
  if (capRow < 1) return [];
  const header = rows[capRow - 1];

  // A team's first column: a non-empty header cell whose left neighbour is empty.
  const cols = [];
  for (let c = 1; c < header.length; c++) {
    const v = (header[c] ?? "").trim();
    if (v && !(header[c - 1] ?? "").trim() && !/conference$/i.test(v)) cols.push({ c, name: v });
  }
  if (!cols.length) return [];

  const teams = cols.map(({ name }) => ({ team: name, captain: null, players: [], subs: [] }));
  const clean = (s) => {
    const v = (s ?? "").trim();
    return v && !v.startsWith("#") ? v : null; // drop blanks and #N/A / #REF! formula errors
  };
  for (let r = capRow; r < rows.length; r++) {
    const label = norm(rows[r][0]);
    const isCaptain = label === "captain";
    const isPlayer = /^player\s*\d+$/.test(label);
    const isSub = /^sub/.test(label);
    if (!isCaptain && !isPlayer && !isSub) continue;
    cols.forEach(({ c }, i) => {
      const nm = clean(rows[r][c]);
      if (!nm) return;
      if (isCaptain) teams[i].captain = teams[i].captain ?? nm;
      else if (isSub) { if (!teams[i].subs.includes(nm)) teams[i].subs.push(nm); }
      else if (!teams[i].players.includes(nm)) teams[i].players.push(nm);
    });
  }
  return teams.filter((t) => t.captain || t.players.length);
}

// A conference results tab → player sets. Weeks are stacked vertically; each week has
// team-matchup blocks [teamA, setsA, setsB, teamB] side-by-side, then player rows
// [playerA, gamesA, gamesB, playerB] under each block until a blank row. Returns
// [{ week, p1, p1g, p2, p2g }] — one per player matchup (the actual played set).
export function conferenceResultsFromGrid(rows) {
  const isNum = (v) => /^\d+$/.test((v ?? "").trim());
  const sets = [];
  let week = 0;
  let blocks = null; // [[aCol, saCol, sbCol, bCol], ...] for the current week
  for (const row of rows) {
    const wk = (row[1] ?? "").trim().match(/^Week\s+(\d+)/i);
    if (wk) { week = Number(wk[1]); blocks = null; continue; }
    if (!blocks) {
      // Find the team-matchup HEADER row: groups of [name, int, int, name].
      const found = [];
      for (let c = 0; c < row.length - 3; c++) {
        if ((row[c] ?? "").trim() && !isNum(row[c]) && isNum(row[c + 1]) && isNum(row[c + 2]) && (row[c + 3] ?? "").trim() && !isNum(row[c + 3])) {
          found.push([c, c + 1, c + 2, c + 3]);
          c += 3;
        }
      }
      if (found.length) blocks = found; // header found; the player rows follow it
      continue;
    }
    // Player rows: same columns as the header blocks.
    let any = false;
    for (const [a, sa, sb, b] of blocks) {
      const pa = (row[a] ?? "").trim(), pb = (row[b] ?? "").trim();
      if (pa && pb && isNum(row[sa]) && isNum(row[sb])) {
        sets.push({ week, p1: pa, p1g: Number(row[sa]), p2: pb, p2g: Number(row[sb]) });
        any = true;
      }
    }
    if (!any) blocks = null; // blank row ends this week's matchups
  }
  return sets;
}

// Read a season xlsx's player results from its conference tabs (every tab named
// "<X> Conference"). [{ conference, week, p1, p1g, p2, p2g }].
export async function readSeasonResults(path) {
  const wb = await loadWorkbook(path);
  const out = [];
  for (const ws of wb.worksheets) {
    if (!/\sConference$/i.test(ws.name) || /^Conference\b/i.test(ws.name)) continue;
    const grid = tabGrid(wb, ws.name);
    for (const s of conferenceResultsFromGrid(grid)) out.push({ conference: ws.name, ...s });
  }
  return out;
}

// Load one season xlsx → its conference + signup + draft-roster data (each empty if absent).
export async function readSeasonXlsx(path) {
  const wb = await loadWorkbook(path);
  const standings = tabGrid(wb, "Standings");
  const signups = tabGrid(wb, "signups");
  const draft = tabGrid(wb, "Draft Results ") ?? tabGrid(wb, "Draft Results");
  return {
    conferences: standings ? conferencesFromStandingsGrid(standings) : {},
    signups: signups ? signupsFromGrid(signups) : [],
    draftTeams: draft ? draftTeamsFromGrid(draft) : [],
  };
}

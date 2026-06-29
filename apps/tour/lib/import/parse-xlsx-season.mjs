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
  let blocks = null; // [{a, sa, sb, b, teamA, teamB}, ...] for the current week
  for (const row of rows) {
    const wk = (row[1] ?? "").trim().match(/^Week\s+(\d+)/i);
    if (wk) { week = Number(wk[1]); blocks = null; continue; }
    if (!blocks) {
      // Team-matchup HEADER row: groups of [teamA, int, int, teamB]. Remember the teams.
      const found = [];
      for (let c = 0; c < row.length - 3; c++) {
        if ((row[c] ?? "").trim() && !isNum(row[c]) && isNum(row[c + 1]) && isNum(row[c + 2]) && (row[c + 3] ?? "").trim() && !isNum(row[c + 3])) {
          found.push({ a: c, sa: c + 1, sb: c + 2, b: c + 3, teamA: (row[c] ?? "").trim(), teamB: (row[c + 3] ?? "").trim() });
          c += 3;
        }
      }
      if (found.length) blocks = found; // header found; the player rows follow it
      continue;
    }
    // Player rows: same columns as the header blocks; carry each player's team.
    let any = false;
    for (const bl of blocks) {
      const pa = (row[bl.a] ?? "").trim(), pb = (row[bl.b] ?? "").trim();
      if (pa && pb && isNum(row[bl.sa]) && isNum(row[bl.sb])) {
        sets.push({ week, teamA: bl.teamA, p1: pa, p1g: Number(row[bl.sa]), p2: pb, p2g: Number(row[bl.sb]), teamB: bl.teamB });
        any = true;
      }
    }
    if (!any) blocks = null; // blank row ends this week's matchups
  }
  return sets;
}

// A Swiss-season results tab (TT3) → player sets. Layout differs from the conference
// tabs: the "Week N" label is in col 0 of EVERY row (not a separator), and matchup
// blocks [nameA, scoreA, scoreB, nameB] run across with a gap column between, team-
// header rows interleaved with player rows. Scores may be blank (= 0). Returns every
// block (team headers included); the importer drops team-vs-team rows by name.
export function swissResultsFromGrid(rows) {
  const isNum = (v) => /^\d+$/.test((v ?? "").trim());
  const num = (v) => (isNum(v) ? Number((v ?? "").trim()) : 0);
  const findBlocks = (row) => {
    const out = [];
    for (let c = 2; c < row.length - 3; c++) {
      const a = (row[c] ?? "").trim(), b = (row[c + 3] ?? "").trim();
      if (a && b && !isNum(row[c]) && !isNum(row[c + 3]) && (isNum(row[c + 1]) || isNum(row[c + 2]))) {
        out.push({ a, sa: c + 1, sb: c + 2, b, c }); c += 3;
      }
    }
    return out;
  };
  const sets = [];
  let header = null; // current group's team-matchup header: [{ c, teamA, teamB }]
  let week = 0;
  for (const row of rows) {
    const wk = (row[0] ?? "").trim().match(/^Week\s+(\d+)/i);
    if (wk) week = Number(wk[1]);
    const found = findBlocks(row);
    if (!found.length) { header = null; continue; } // no matchups → group separator
    if (!header) { header = found.map((f) => ({ c: f.c, teamA: f.a, teamB: f.b })); continue; } // team-header row
    for (const f of found) {
      const hdr = header.find((h) => h.c === f.c);
      if (!hdr) continue;
      sets.push({ week, teamA: hdr.teamA, p1: f.a, p1g: num(row[f.sa]), p2: f.b, p2g: num(row[f.sb]), teamB: hdr.teamB });
    }
  }
  return sets;
}

// Playoffs tab → player sets. Same [name, sA, sB, name] blocks as the Swiss tab
// (round headers like "Quarterfinal 1" are single cells, never match). Scores may be
// blank (= 0). Team-header rows included; the importer filters them by team name.
export function playoffResultsFromGrid(rows) {
  const isNum = (v) => /^\d+$/.test((v ?? "").trim());
  const num = (v) => (isNum(v) ? Number((v ?? "").trim()) : 0);
  const sets = [];
  for (const row of rows) {
    for (let c = 0; c < row.length - 3; c++) {
      const a = (row[c] ?? "").trim(), b = (row[c + 3] ?? "").trim();
      if (a && b && !isNum(row[c]) && !isNum(row[c + 3]) && (isNum(row[c + 1]) || isNum(row[c + 2]))) {
        sets.push({ p1: a, p1g: num(row[c + 1]), p2: b, p2g: num(row[c + 2]) });
        c += 3;
      }
    }
  }
  return sets;
}

// Read a season xlsx's player results — regular (conference tabs for conference
// seasons, or the "Swiss" tab for TT3) + playoff (Playoffs tab). Each row carries a
// `bracket` ("REGULAR" | "PLAYOFF"). Team-header rows are filtered by the importer.
export async function readSeasonResults(path) {
  const wb = await loadWorkbook(path);
  const out = [];
  for (const ws of wb.worksheets) {
    if (/\sConference$/i.test(ws.name) && !/^Conference\b/i.test(ws.name)) {
      for (const s of conferenceResultsFromGrid(tabGrid(wb, ws.name))) out.push({ source: ws.name, bracket: "REGULAR", ...s });
    } else if (/^Swiss$/i.test(ws.name)) {
      for (const s of swissResultsFromGrid(tabGrid(wb, ws.name))) out.push({ source: "Swiss", bracket: "REGULAR", ...s });
    } else if (/^Playoffs?$/i.test(ws.name)) {
      for (const s of playoffResultsFromGrid(tabGrid(wb, ws.name))) out.push({ source: "Playoffs", bracket: "PLAYOFF", ...s });
    }
  }
  return out;
}

// Team Rosters tab → [{ team, captain, players, subs }] for the MULTI-BAND layout
// (TT3): teams are blocks stacked in rows; the label column ("Team", "Captain",
// "Player N", "Backup") repeats per band; team names + roster cells share a column.
// Used when a season has no "Draft Results" tab.
export function rosterBandsFromGrid(rows) {
  const norm = (s) => (s ?? "").trim().toLowerCase();
  // Label column = the column where "captain" appears (col 0 or 1).
  let labelCol = -1;
  for (let r = 0; r < rows.length && labelCol < 0; r++) {
    for (let c = 0; c < 3; c++) if (norm(rows[r][c]) === "captain") { labelCol = c; break; }
  }
  if (labelCol < 0) return [];

  const teams = [];
  let cols = null, cur = null; // current band's team columns + team objects
  for (const row of rows) {
    const label = norm(row[labelCol]);
    if (label === "team") {
      cols = [];
      for (let c = labelCol + 1; c < row.length; c++) {
        const v = (row[c] ?? "").trim();
        if (v && !(row[c - 1] ?? "").trim()) cols.push(c);
      }
      cur = cols.map((c) => ({ team: (row[c] ?? "").trim(), captain: null, players: [], subs: [] }));
      cur.forEach((t) => teams.push(t));
      continue;
    }
    if (!cols) continue;
    const isCap = label === "captain", isPlayer = /^player\s*\d+$/.test(label), isSub = /^(sub|backup)/.test(label);
    if (!isCap && !isPlayer && !isSub) continue;
    cols.forEach((c, i) => {
      const nm = (row[c] ?? "").trim();
      if (!nm || nm.startsWith("#")) return;
      if (isCap) cur[i].captain = cur[i].captain ?? nm;
      else if (isSub) { if (!cur[i].subs.includes(nm)) cur[i].subs.push(nm); }
      else if (!cur[i].players.includes(nm)) cur[i].players.push(nm);
    });
  }
  return teams.filter((t) => t.team && (t.captain || t.players.length));
}

// Load one season xlsx → its conference + signup + draft-roster data (each empty if absent).
export async function readSeasonXlsx(path) {
  const wb = await loadWorkbook(path);
  const standings = tabGrid(wb, "Standings");
  const signups = tabGrid(wb, "signups");
  // Rosters: the single-band "Draft Results" tab (TT1/2/4) if present, else the
  // multi-band "Team Rosters" tab (TT3).
  const draft = tabGrid(wb, "Draft Results ") ?? tabGrid(wb, "Draft Results");
  let draftTeams = draft ? draftTeamsFromGrid(draft) : [];
  if (!draftTeams.length) {
    const tr = tabGrid(wb, "Team Rosters");
    if (tr) draftTeams = rosterBandsFromGrid(tr);
  }
  return {
    conferences: standings ? conferencesFromStandingsGrid(standings) : {},
    signups: signups ? signupsFromGrid(signups) : [],
    draftTeams,
  };
}

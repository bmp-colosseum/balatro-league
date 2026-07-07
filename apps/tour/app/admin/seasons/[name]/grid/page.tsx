// Coverage grid -- per conference, a full head-to-head matrix so a TO can SEE, at a
// glance, which teams have played (score in the cell) and which never met. Built purely
// from existing data (Matchup rows or flat imported sets), zero setup.
//
// A blank cell is a hole. The TO resolves each one in the editor below the matrix:
//   * Record result   -- the game happened but wasn't in the data; enter the team score.
//   * Not scheduled    -- a DESIGNED non-matchup (TT4 had one pair per conference that
//                         never played); mark it so it stops counting as a hole (shows ×).
// Editing writes Matchup rows, so the season must be reconciled first (played games grouped
// into matchups) -- the page prompts for that when it's still flat imported sets.
import Link from "next/link";
import { ArrowLeft, Grid3x3, ClipboardList } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonGrid, type GridCell, type ConferenceGrid } from "@/lib/services/grid";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { recordHoleAction, markNotScheduledAction, unmarkNotScheduledAction } from "./actions";

export const dynamic = "force-dynamic";

// One matrix cell, from the ROW team's perspective. Blank (never met) is tinted so holes
// pop; a designed bye is a dark ×; a played cell shows the set score with games in the tip.
function Cell({ cell, self }: { cell: GridCell | null; self: boolean }) {
  if (self) return <td style={{ background: "var(--surface-2)", textAlign: "center", color: "var(--muted)" }}>{"—"}</td>;
  if (!cell) {
    return (
      <td style={{ background: "rgba(245,165,36,0.10)", textAlign: "center", color: "var(--muted)" }} title="Never played -- candidate missing match">
        {"·"}
      </td>
    );
  }
  if (cell.state === "excluded") {
    return (
      <td style={{ background: "var(--surface-2)", textAlign: "center", color: "var(--muted)" }} title="Designed bye -- these two never play">
        {"×"}
      </td>
    );
  }
  if (cell.state === "scheduled") {
    const dash = <span title="Fixture exists, not played yet">{"○"}</span>;
    return (
      <td style={{ textAlign: "center", color: "var(--muted)" }}>
        {cell.matchupId ? <Link href={`/admin/matchups/${cell.matchupId}`} title="Open the matchup console -- pair players / report each set">{dash}</Link> : dash}
      </td>
    );
  }
  // Whole-match double DQ: decided 0-0 with nothing accounted -- nobody played, on purpose.
  if (cell.setsFor === 0 && cell.setsAgainst === 0 && cell.setsAccounted === 0) {
    const dq = <span title="Double DQ -- nobody played (0-0, no winner)">DQ</span>;
    return (
      <td style={{ textAlign: "center", color: "var(--muted)", fontWeight: 600 }}>
        {cell.matchupId ? <Link href={`/admin/matchups/${cell.matchupId}`} style={{ color: "inherit" }}>{dq}</Link> : dq}
      </td>
    );
  }
  const won = cell.setsFor > cell.setsAgainst;
  const lost = cell.setsFor < cell.setsAgainst;
  const color = won ? "var(--accent-2)" : lost ? "var(--danger, #e5484d)" : undefined;
  const games =
    `${cell.gamesFor}–${cell.gamesAgainst} games` +
    (cell.meetings > 1 ? ` · ${cell.meetings} meetings` : "") +
    (cell.short ? ` · only ${cell.setsAccounted} of ${cell.setsExpected} sets accounted -- add or DQ the rest in the console` : "") +
    (cell.matchupId ? " · click to edit sets" : "");
  const score = (
    <>
      {cell.setsFor}{"–"}{cell.setsAgainst}
      {cell.short && <sup style={{ color: "var(--warning, #f5a524)", fontWeight: 700 }}>{"!"}</sup>}
    </>
  );
  return (
    <td style={{ textAlign: "center", color, fontWeight: 600, whiteSpace: "nowrap" }} title={games}>
      {cell.matchupId ? <Link href={`/admin/matchups/${cell.matchupId}`} style={{ color: "inherit" }}>{score}</Link> : score}
    </td>
  );
}

// The holes editor for one conference: every blank pair gets a record-result form + a
// "not scheduled" button; every designed bye gets a restore button.
function HolesEditor({ season, c, weekNumbers }: { season: string; c: ConferenceGrid; weekNumbers: number[] }) {
  const ids = c.teams.map((t) => t.teamSeasonId);
  const names = c.teams.map((t) => t.name);
  const missing: [number, number][] = [];
  const byes: [number, number][] = [];
  c.rows.forEach((row, i) => {
    for (let j = i + 1; j < row.cells.length; j++) {
      const cell = row.cells[j];
      if (cell === null) missing.push([i, j]);
      else if (cell.state === "excluded") byes.push([i, j]);
    }
  });
  if (missing.length === 0 && byes.length === 0) return null;

  const defaultWeek = weekNumbers.length ? weekNumbers[weekNumbers.length - 1] : 1;
  const numStyle = { width: "3rem", textAlign: "center" as const };

  return (
    <details open={missing.length > 0} style={{ marginTop: "0.6rem", borderTop: "1px solid var(--border)", paddingTop: "0.5rem" }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        Resolve holes {"—"} {missing.length} to fill{byes.length ? `, ${byes.length} marked as byes` : ""}
      </summary>

      {missing.map(([i, j]) => (
        <div key={`m${i}-${j}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0", borderTop: "1px solid var(--border)" }}>
          <span style={{ minWidth: "13rem" }}>
            <strong><Link href={`/teams/${ids[i]}`} style={{ color: "inherit" }}>{names[i]}</Link></strong>{" "}
            <span className="muted">vs</span>{" "}
            <strong><Link href={`/teams/${ids[j]}`} style={{ color: "inherit" }}>{names[j]}</Link></strong>
          </span>
          <ActionFlashForm action={recordHoleAction} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.35rem" }}>
            <input type="hidden" name="season" value={season} />
            <input type="hidden" name="aId" value={ids[i]} />
            <input type="hidden" name="bId" value={ids[j]} />
            <input type="hidden" name="aName" value={names[i]} />
            <input type="hidden" name="bName" value={names[j]} />
            <span className="sub">sets</span>
            <input type="number" name="setsA" min={0} defaultValue={0} required style={numStyle} title={`${names[i]} sets won`} />
            <span className="sub">{"–"}</span>
            <input type="number" name="setsB" min={0} defaultValue={0} required style={numStyle} title={`${names[j]} sets won`} />
            <span className="sub">games</span>
            <input type="number" name="gamesA" min={0} placeholder="0" style={numStyle} title={`${names[i]} games won (optional)`} />
            <span className="sub">{"–"}</span>
            <input type="number" name="gamesB" min={0} placeholder="0" style={numStyle} title={`${names[j]} games won (optional)`} />
            <span className="sub">week</span>
            <select name="week" defaultValue={defaultWeek} style={{ width: "3.6rem" }}>
              {weekNumbers.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
            <SubmitButton size="sm" pendingText="Saving…">Record</SubmitButton>
            <SubmitButton size="sm" variant="secondary" name="dq" value="1" pendingText="Saving…"
              title="Nobody played and it doesn't matter -- record a 0-0 double DQ (no winner)">
              DQ 0{"–"}0
            </SubmitButton>
          </ActionFlashForm>
          <ActionFlashForm action={markNotScheduledAction}>
            <input type="hidden" name="season" value={season} />
            <input type="hidden" name="aId" value={ids[i]} />
            <input type="hidden" name="bId" value={ids[j]} />
            <input type="hidden" name="aName" value={names[i]} />
            <input type="hidden" name="bName" value={names[j]} />
            <SubmitButton size="sm" variant="secondary" pendingText="…" title="These two were never scheduled to play">Not scheduled</SubmitButton>
          </ActionFlashForm>
        </div>
      ))}

      {byes.length > 0 && (
        <div style={{ marginTop: "0.5rem" }}>
          <div className="sub" style={{ marginBottom: "0.25rem" }}>Designed byes (never play):</div>
          {byes.map(([i, j]) => (
            <div key={`b${i}-${j}`} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.25rem 0" }}>
              <span style={{ minWidth: "13rem" }} className="muted">{names[i]} vs {names[j]} <span className="sub">× bye</span></span>
              <ActionFlashForm action={unmarkNotScheduledAction}>
                <input type="hidden" name="season" value={season} />
                <input type="hidden" name="aId" value={ids[i]} />
                <input type="hidden" name="bId" value={ids[j]} />
                <input type="hidden" name="aName" value={names[i]} />
                <input type="hidden" name="bName" value={names[j]} />
                <SubmitButton size="sm" variant="secondary" pendingText="…">Restore as hole</SubmitButton>
              </ActionFlashForm>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

export default async function GridPage({ params }: { params: Promise<{ name: string }> }) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only {"—"} you don&apos;t have access.</Callout>
      </main>
    );
  }

  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);
  const grid = await getSeasonGrid(seasonName);

  if (!grid) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }

  const { conferences, crossConf, totals, weekNumbers, editable, needsReconcile } = grid;

  return (
    <main>
      <p>
        <Link href={`/admin/seasons/${enc}/audit`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> audit</Link>
      </p>
      <h1 className="inline-flex items-center gap-2"><Grid3x3 className="size-6" /> {seasonName} {"—"} Coverage grid</h1>
      <p className="sub">
        {totals.teams} teams {"·"} {totals.playedMeetings} matches played {"·"}{" "}
        <strong style={{ color: "var(--warning, #f5a524)" }}>{totals.missingPairs} holes</strong>
        {totals.excludedPairs > 0 && <> {"·"} {totals.excludedPairs} designed byes</>}
      </p>

      <Callout type="admin" style={{ marginBottom: "0.75rem" }}>
        Each cell is <strong>row team vs column team</strong> (the row team&apos;s set score).
        <strong> Click a score</strong> to open its matchup console and edit the individual sets behind it
        (who played whom + each set&apos;s game score). A tinted blank ({"·"}) means they{" "}
        <strong>never played</strong> {"—"} a hole. A dark {"×"} is a designed bye (never scheduled).
        A {"○"} is an unplayed fixture. <strong>DQ</strong> is a double DQ (0{"–"}0, nobody played).
        An orange <strong>!</strong> marks a short match {"—"} some of its sets are missing (e.g. 10 of 11);
        open it and report or DQ the rest. Resolve holes below the matrix: record the team result, DQ it,
        or mark it a bye.
      </Callout>

      {needsReconcile && (
        <Callout type="admin" style={{ marginBottom: "0.75rem" }}>
          <div style={{ marginBottom: "0.4rem" }}>
            This season&apos;s games are imported but not yet grouped into matchups, so the holes can&apos;t
            be edited here yet. Rebuild the matchups first, then come back to fill/mark them:
          </div>
          <Link href={`/admin/seasons/${enc}/audit/rebuild`} className="inline-flex items-center gap-1">
            <ClipboardList className="size-4" /> Preview matchup rebuild {"→"}
          </Link>
        </Callout>
      )}

      {conferences.length === 0 && <Callout type="admin">No conferences with teams yet {"—"} nothing to grid.</Callout>}

      {conferences.map((c) => {
        // Short matches: played but missing sets inside (10 of 11) -- listed under the
        // matrix because a superscript alone is easy to miss when scanning.
        const shorts: { label: string; matchupId?: string }[] = [];
        c.rows.forEach((row, i) => {
          for (let j = i + 1; j < row.cells.length; j++) {
            const cell = row.cells[j];
            if (cell?.short) {
              shorts.push({
                label: `${c.teams[i].name} vs ${c.teams[j].name} (${cell.setsAccounted}/${cell.setsExpected} sets)`,
                matchupId: cell.matchupId,
              });
            }
          }
        });
        return (
        <div className="card" key={c.conferenceId} style={{ marginBottom: "1rem" }}>
          <div className="bracket-title">
            {c.conferenceName} <span className="sub">({c.teams.length} teams)</span>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: "0.85rem" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", position: "sticky", left: 0, background: "var(--surface)" }}>Team</th>
                  {c.teams.map((t, j) => (
                    <th key={t.teamSeasonId} className="num" title={t.name} style={{ minWidth: "2.6rem" }}>{j + 1}</th>
                  ))}
                  <th className="num" title="in-conference opponents played / expected">Played</th>
                  <th className="num" title="in-conference opponents never met (excluding designed byes)">Holes</th>
                </tr>
              </thead>
              <tbody>
                {c.rows.map((row, i) => {
                  const t = c.teams[i];
                  return (
                    <tr key={row.teamSeasonId}>
                      <td style={{ whiteSpace: "nowrap", position: "sticky", left: 0, background: "var(--surface)" }}>
                        <span className="sub">{i + 1}.</span> <Link href={`/teams/${t.teamSeasonId}`} style={{ color: "inherit" }}>{t.name}</Link>
                      </td>
                      {row.cells.map((cell, j) => <Cell key={j} cell={cell} self={i === j} />)}
                      <td className="num">
                        {t.opponentsPlayed}/{t.possibleOpponents}
                        {t.opponentsScheduled > 0 && <span className="sub"> (+{t.opponentsScheduled})</span>}
                        {t.excluded > 0 && <span className="sub"> · {t.excluded} bye</span>}
                      </td>
                      <td className="num" style={{ color: t.missing > 0 ? "var(--warning, #f5a524)" : "var(--accent-2)" }}>
                        {t.missing || "✓"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {shorts.length > 0 && (
            <p className="sub" style={{ marginTop: "0.5rem", color: "var(--warning, #f5a524)" }}>
              Short matches:{" "}
              {shorts.map((s, k) => (
                <span key={k}>
                  {k > 0 && ", "}
                  {s.matchupId ? <Link href={`/admin/matchups/${s.matchupId}`} style={{ color: "inherit" }}>{s.label}</Link> : s.label}
                </span>
              ))}
            </p>
          )}

          {editable && <HolesEditor season={seasonName} c={c} weekNumbers={weekNumbers} />}
        </div>
        );
      })}

      {crossConf.length > 0 && (
        <div className="card">
          <div className="bracket-title">Cross-conference games ({crossConf.length})</div>
          <p className="sub" style={{ marginBottom: "0.4rem" }}>
            Played between teams in different conferences {"—"} not part of either round-robin grid above.
          </p>
          <table>
            <tbody>
              {crossConf.map((m, i) => (
                <tr key={i}>
                  <td><Link href={`/teams/${m.aTeamSeasonId}`} style={{ color: "inherit" }}>{m.aName}</Link> <span className="sub">({m.aConf})</span></td>
                  <td className="num">{m.setsA}{"–"}{m.setsB}</td>
                  <td><Link href={`/teams/${m.bTeamSeasonId}`} style={{ color: "inherit" }}>{m.bName}</Link> <span className="sub">({m.bConf})</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

// Coverage grid -- per conference, a full head-to-head matrix so a TO can SEE, at a
// glance, which teams have played (score in the cell) and which never met (a blank =
// a candidate missing match). Built purely from existing data (Matchup rows or flat
// imported sets), zero setup -- the "gauge from what we have, you fill the rest" view.
// A blank cell is a real hole in the schedule; the TO decides which holes are games
// still owed vs pairs that were never going to play.
import Link from "next/link";
import { ArrowLeft, Grid3x3 } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonGrid, type GridCell } from "@/lib/services/grid";
import { Callout } from "@/components/Callout";

export const dynamic = "force-dynamic";

// One matrix cell. Blank (never met) is tinted so the holes pop; a played cell shows the
// row team's set score (green when it won, red when it lost) with games in the tooltip.
function Cell({ cell, self }: { cell: GridCell | null; self: boolean }) {
  if (self) {
    return <td style={{ background: "var(--surface-2)", textAlign: "center", color: "var(--muted)" }}>{"—"}</td>;
  }
  if (!cell) {
    return (
      <td style={{ background: "rgba(245,165,36,0.10)", textAlign: "center", color: "var(--muted)" }} title="Never played -- candidate missing match">
        {"·"}
      </td>
    );
  }
  if (cell.state === "scheduled") {
    return (
      <td style={{ textAlign: "center", color: "var(--muted)" }} title="Fixture exists, not played yet">
        {"○"}
      </td>
    );
  }
  const won = cell.setsFor > cell.setsAgainst;
  const lost = cell.setsFor < cell.setsAgainst;
  const color = won ? "var(--accent-2)" : lost ? "var(--danger, #e5484d)" : undefined;
  const games = `${cell.gamesFor}–${cell.gamesAgainst} games` + (cell.meetings > 1 ? ` · ${cell.meetings} meetings` : "");
  return (
    <td style={{ textAlign: "center", color, fontWeight: 600, whiteSpace: "nowrap" }} title={games}>
      {cell.setsFor}
      {"–"}
      {cell.setsAgainst}
    </td>
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

  const { conferences, crossConf, totals } = grid;

  return (
    <main>
      <p>
        <Link href={`/admin/seasons/${enc}/audit`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> audit</Link>
      </p>
      <h1 className="inline-flex items-center gap-2"><Grid3x3 className="size-6" /> {seasonName} {"—"} Coverage grid</h1>
      <p className="sub">
        {totals.teams} teams {"·"} {totals.playedMeetings} matches played {"·"}{" "}
        <strong style={{ color: "var(--warning, #f5a524)" }}>{totals.missingPairs} pairs never met</strong>
      </p>

      <Callout type="admin" style={{ marginBottom: "0.75rem" }}>
        Each cell is <strong>row team vs column team</strong>, shown as the row team&apos;s set score. A tinted
        blank ({"·"}) means those two <strong>never played</strong> {"—"} a candidate missing match.
        A {"○"} is a fixture that exists but hasn&apos;t been played. Hover a score for games / repeat meetings.
        This is built from existing data {"—"} eyeball the holes and fill in the ones that are real.
      </Callout>

      {conferences.length === 0 && (
        <Callout type="admin">No conferences with teams yet {"—"} nothing to grid.</Callout>
      )}

      {conferences.map((c) => {
        const teamsMissing = c.teams.filter((t) => t.missing > 0);
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
                    <th className="num" title="in-conference opponents played / possible">Played</th>
                    <th className="num" title="in-conference opponents never met">Missing</th>
                  </tr>
                </thead>
                <tbody>
                  {c.rows.map((row, i) => {
                    const t = c.teams[i];
                    return (
                      <tr key={row.teamSeasonId}>
                        <td style={{ whiteSpace: "nowrap", position: "sticky", left: 0, background: "var(--surface)" }}>
                          <span className="sub">{i + 1}.</span> {t.name}
                        </td>
                        {row.cells.map((cell, j) => (
                          <Cell key={j} cell={cell} self={i === j} />
                        ))}
                        <td className="num">
                          {t.opponentsPlayed}/{t.possibleOpponents}
                          {t.opponentsScheduled > 0 && <span className="sub"> (+{t.opponentsScheduled})</span>}
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

            {teamsMissing.length > 0 && (
              <p className="sub" style={{ marginTop: "0.5rem" }}>
                Holes: {teamsMissing.map((t) => `${t.name} (${t.missing})`).join(", ")}
              </p>
            )}
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
                  <td>{m.aName} <span className="sub">({m.aConf})</span></td>
                  <td className="num">{m.setsA}{"–"}{m.setsB}</td>
                  <td>{m.bName} <span className="sub">({m.bConf})</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

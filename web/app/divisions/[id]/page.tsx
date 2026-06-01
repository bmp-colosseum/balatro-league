// Public read-only division page. Shows standings, played pairings, and the
// remaining matchups. Admin equivalent at /admin/divisions/[id] has the
// editing controls (drop, remove, override, etc.).

import Link from "next/link";
import { notFound } from "next/navigation";
import { loadDivisionPageData } from "@/lib/loaders/division";
import { tierColors } from "@/lib/tier-colors";
import { Crosstable } from "@/components/Crosstable";
import { SiteNav } from "@/components/SiteNav";

export const dynamic = "force-dynamic";

export default async function PublicDivisionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await loadDivisionPageData(id);
  if (!data) notFound();
  const { division, standings, recentPairings, shootouts, unplayed, crosstable } = data;
  const tc = tierColors(division.tierPosition);

  return (
    <>
      <SiteNav activePath="/standings" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>{division.name}</h2>
          <span className="pill" style={{ background: tc.bg, color: tc.fg }}>{division.tierName}</span>
          <Link href={`/seasons/${division.seasonId}`} className="muted">
            {division.seasonName}
          </Link>
          <Link href="/standings" style={{ marginLeft: "auto" }}>← all standings</Link>
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          {division.activeCount} active player(s) · {division.confirmedPairingCount} set(s) played · {unplayed.length} remaining
        </div>

        <div className="card">
          <strong>Standings</strong>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr><th></th><th>Player</th><th>Pts</th><th>W-D-L</th><th>Games</th></tr>
            </thead>
            <tbody>
              {standings.length === 0 ? (
                <tr><td colSpan={5} className="muted">No matches played yet.</td></tr>
              ) : standings.map((r, i) => {
                const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
                const link = (
                  <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>
                    {r.player.displayName}
                  </Link>
                );
                return (
                  <tr key={r.player.id}>
                    <td>{medal}</td>
                    <td>{r.dropped ? <s>{link}</s> : link}{r.dropped && <span className="muted"> (dropped)</span>}</td>
                    <td><strong>{r.points}</strong></td>
                    <td>{r.wins}-{r.draws}-{r.losses}</td>
                    <td>{r.gamesWon}-{r.gamesLost}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {crosstable.players.length > 0 && (
          <div className="card">
            <strong>Crosstable</strong>
            <p className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
              Games won — row beat column. Empty cells = not played yet. Points = total games won.
            </p>
            <Crosstable data={crosstable} />
          </div>
        )}

        <div className="card">
          <strong>Recent matches ({division.confirmedPairingCount})</strong>
          {recentPairings.length === 0 ? (
            <p className="muted" style={{ marginTop: 4 }}>No matches played yet.</p>
          ) : (
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Date</th><th>Result</th></tr></thead>
              <tbody>
                {recentPairings.map((p) => {
                  const date = p.date ? p.date.toISOString().slice(0, 10) : "—";
                  return (
                    <tr key={p.id}>
                      <td className="muted">{date}</td>
                      <td>
                        <Link href={`/profile/${p.playerA.id}`} style={{ color: "var(--text)" }}>{p.playerA.displayName}</Link>
                        {" "}<strong>{p.gamesWonA}-{p.gamesWonB}</strong>{" "}
                        <Link href={`/profile/${p.playerB.id}`} style={{ color: "var(--text)" }}>{p.playerB.displayName}</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {shootouts.length > 0 && (
          <div className="card">
            <strong>⚔ Shootouts ({shootouts.length})</strong>
            <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              1-game tiebreakers. Recorded when two players tied on points + drew their head-to-head.
            </p>
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Date</th><th>Result</th><th></th></tr></thead>
              <tbody>
                {shootouts.map((s) => {
                  const date = s.recordedAt.toISOString().slice(0, 10);
                  return (
                    <tr key={s.id}>
                      <td className="muted">{date}</td>
                      <td>
                        <Link href={`/profile/${s.winner.id}`} style={{ color: "var(--text)" }}>
                          <strong>{s.winner.displayName}</strong>
                        </Link>
                        {" "}beat{" "}
                        <Link href={`/profile/${s.loser.id}`} style={{ color: "var(--text)" }}>
                          {s.loser.displayName}
                        </Link>
                      </td>
                      <td className="muted" style={{ fontSize: 11 }}>
                        {s.selfReported ? "self-reported" : "mediator"}
                        {s.notes ? ` · ${s.notes}` : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {unplayed.length > 0 && (
          <div className="card">
            <strong>Remaining ({unplayed.length})</strong>
            <ul style={{ marginTop: 4, columns: 2 }}>
              {unplayed.map((m, i) => (
                <li key={i} className="muted" style={{ fontSize: 12 }}>
                  <Link href={`/profile/${m.a.id}`} style={{ color: "var(--text)" }}>{m.a.displayName}</Link>
                  {" vs "}
                  <Link href={`/profile/${m.b.id}`} style={{ color: "var(--text)" }}>{m.b.displayName}</Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </>
  );
}

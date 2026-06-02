// Public read-only division page. Shows standings, played pairings, and the
// remaining matchups. Admin equivalent at /admin/divisions/[id] has the
// editing controls (drop, remove, override, etc.).

import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { hasTier } from "@/lib/admin";
import { loadDivisionPageData } from "@/lib/loaders/division";
import { prisma } from "@/lib/prisma";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { recordFromDivisionAction, reportFromDivisionAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function PublicDivisionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await loadDivisionPageData(id);
  if (!data) notFound();
  const { division, standings, recentPairings, shootouts, unplayed } = data;
  const tc = tierColors(division.tierPosition);

  // Viewer identity: drives the per-row reporting controls on
  // the Remaining list. Two paths:
  //   - viewer is one of the two players → report from their POV
  //   - viewer is an admin → record either side's POV
  // Otherwise the row renders as plain text.
  const session = await auth();
  const viewerDiscordId = (session?.user as { discordId?: string } | undefined)?.discordId ?? null;
  const viewerPlayerId: string | null = viewerDiscordId
    ? (await prisma.player.findUnique({
        where: { discordId: viewerDiscordId },
        select: { id: true },
      }))?.id ?? null
    : null;
  const viewerIsAdmin = await hasTier("ADMIN");

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
              <tr>
                <th></th>
                <th>Player</th>
                <th title="League-wide rank (1 = best player in the league). Updated at end of season.">Overall</th>
                <th>Pts</th>
                <th>W-D-L</th>
                <th>Games</th>
              </tr>
            </thead>
            <tbody>
              {standings.length === 0 ? (
                <tr><td colSpan={6} className="muted">No matches played yet.</td></tr>
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
                    <td className="muted">{r.player.rating != null ? `#${r.player.rating}` : "—"}</td>
                    <td><strong>{r.points}</strong></td>
                    <td>{r.wins}-{r.draws}-{r.losses}</td>
                    <td>{r.gamesWon}-{r.gamesLost}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {unplayed.length > 0 && (
          <div className="card">
            <strong>Remaining ({unplayed.length})</strong>
            <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
              {viewerPlayerId
                ? "You can report your own matches inline. Admins can record anyone's."
                : "Players in this division can report their matches by signing in."}
            </p>
            <ul style={{ marginTop: 4, listStyle: "none", padding: 0 }}>
              {unplayed.map((m) => {
                const viewerIsA = viewerPlayerId === m.a.id;
                const viewerIsB = viewerPlayerId === m.b.id;
                const viewerIsPlayer = viewerIsA || viewerIsB;
                const opponent = viewerIsA ? m.b : viewerIsB ? m.a : null;
                return (
                  <li
                    key={`${m.a.id}-${m.b.id}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 0",
                      borderBottom: "1px solid rgba(255,255,255,0.05)",
                      fontSize: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ flex: "1 1 220px" }}>
                      <Link href={`/profile/${m.a.id}`} style={{ color: "var(--text)" }}>{m.a.displayName}</Link>
                      <span className="muted"> vs </span>
                      <Link href={`/profile/${m.b.id}`} style={{ color: "var(--text)" }}>{m.b.displayName}</Link>
                    </span>
                    {viewerIsPlayer && opponent && (
                      <form action={reportFromDivisionAction} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="hidden" name="divisionId" value={id} />
                        <input type="hidden" name="opponentId" value={opponent.id} />
                        <select name="result" defaultValue="2-0" style={{ fontSize: 11, padding: "1px 4px" }}>
                          <option value="2-0">I won 2-0</option>
                          <option value="1-1">Draw 1-1</option>
                          <option value="0-2">I lost 0-2</option>
                        </select>
                        <button type="submit" style={{ fontSize: 11, padding: "1px 8px" }}>Report</button>
                      </form>
                    )}
                    {!viewerIsPlayer && viewerIsAdmin && (
                      <form action={recordFromDivisionAction} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="hidden" name="divisionId" value={id} />
                        <input type="hidden" name="playerAId" value={m.a.id} />
                        <input type="hidden" name="playerBId" value={m.b.id} />
                        <select name="result" defaultValue="2-0" style={{ fontSize: 11, padding: "1px 4px" }} title="Result from playerA's POV">
                          <option value="2-0">{m.a.displayName} 2-0</option>
                          <option value="1-1">Draw 1-1</option>
                          <option value="0-2">{m.b.displayName} 2-0</option>
                        </select>
                        <button type="submit" className="secondary" style={{ fontSize: 11, padding: "1px 8px" }}>Record</button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
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
      </main>
    </>
  );
}

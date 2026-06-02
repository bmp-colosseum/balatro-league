// Public read-only division page. Shows standings, played pairings, and the
// remaining matchups. Admin equivalent at /admin/divisions/[id] has the
// editing controls (drop, remove, override, etc.).

import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { loadDivisionPageData } from "@/lib/loaders/division";
import { prisma } from "@/lib/prisma";
import { tierColors } from "@/lib/tier-colors";
import { Crosstable } from "@/components/Crosstable";
import { SiteNav } from "@/components/SiteNav";
import { reportFromDivisionAction } from "./actions";

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

  // Viewer-specific: if the viewer is a player in this division and has
  // any unplayed opponents, surface the report-a-match dropdown right
  // on this page so they don't have to navigate to /me or /profile.
  const session = await auth();
  const viewerDiscordId = (session?.user as { discordId?: string } | undefined)?.discordId ?? null;
  const viewerReportable: { divisionName: string; opponents: Array<{ playerId: string; displayName: string }> } | null = await (async () => {
    if (!viewerDiscordId) return null;
    const viewerPlayer = await prisma.player.findUnique({
      where: { discordId: viewerDiscordId },
      select: { id: true },
    });
    if (!viewerPlayer) return null;
    const membership = await prisma.divisionMember.findFirst({
      where: { playerId: viewerPlayer.id, divisionId: id, status: "ACTIVE" },
      select: { id: true },
    });
    if (!membership) return null;
    const myPairings = await prisma.pairing.findMany({
      where: {
        divisionId: id,
        status: "CONFIRMED",
        OR: [{ playerAId: viewerPlayer.id }, { playerBId: viewerPlayer.id }],
      },
      select: { playerAId: true, playerBId: true },
    });
    const played = new Set<string>();
    for (const p of myPairings) {
      played.add(p.playerAId === viewerPlayer.id ? p.playerBId : p.playerAId);
    }
    const opponents = standings
      .filter((r) => r.player.id !== viewerPlayer.id && !played.has(r.player.id) && !r.dropped)
      .map((r) => ({ playerId: r.player.id, displayName: r.player.displayName }));
    return { divisionName: division.name, opponents };
  })();

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

        {viewerReportable && viewerReportable.opponents.length > 0 && (
          <div className="card">
            <strong>Report a match</strong>
            <form action={reportFromDivisionAction} style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input type="hidden" name="divisionId" value={id} />
              <span className="muted" style={{ fontSize: 12 }}>vs</span>
              <select name="opponentId" required style={{ flex: "1 1 200px" }}>
                <option value="">— pick an opponent —</option>
                {viewerReportable.opponents.map((o) => (
                  <option key={o.playerId} value={o.playerId}>{o.displayName}</option>
                ))}
              </select>
              <select name="result" required defaultValue="2-0">
                <option value="2-0">2-0 (I won both)</option>
                <option value="1-1">1-1 (draw)</option>
                <option value="0-2">0-2 (I lost both)</option>
              </select>
              <button type="submit">Report</button>
            </form>
            <p className="muted" style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}>
              Reports go to <strong>#results</strong> with Confirm + Dispute buttons. Auto-confirms after 2 min.
            </p>
          </div>
        )}

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

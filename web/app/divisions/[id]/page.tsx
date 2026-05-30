// Public read-only division page. Shows standings, played pairings, and the
// remaining matchups. Admin equivalent at /admin/divisions/[id] has the
// editing controls (drop, remove, override, etc.).

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";

export const dynamic = "force-dynamic";

export default async function PublicDivisionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const division = await prisma.division.findFirst({
    where: { id, season: { visibility: "PUBLIC" } },
    include: {
      season: true,
      tier: true,
      members: { include: { player: true }, orderBy: { joinedAt: "asc" } },
      pairings: {
        where: { status: "CONFIRMED" },
        include: { playerA: true, playerB: true },
        orderBy: { confirmedAt: "desc" },
      },
    },
  });
  if (!division) notFound();

  const droppedIds = new Set(
    division.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
  );
  const rows = computeStandings(
    division.members.map((m) => m.player),
    division.pairings.map((p) => ({
      playerAId: p.playerAId,
      playerBId: p.playerBId,
      gamesWonA: p.gamesWonA,
      gamesWonB: p.gamesWonB,
    })),
  ).map((r) => ({ ...r, dropped: droppedIds.has(r.player.id) }));

  // Compute unplayed matchups across ACTIVE members
  const active = division.members.filter((m) => m.status === "ACTIVE");
  const playedKey = (a: string, b: string) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const playedSet = new Set(division.pairings.map((p) => playedKey(p.playerAId, p.playerBId)));
  const unplayed: Array<{ a: typeof active[number]["player"]; b: typeof active[number]["player"] }> = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!.player;
      const b = active[j]!.player;
      if (!playedSet.has(playedKey(a.id, b.id))) unplayed.push({ a, b });
    }
  }

  const tc = tierColors(division.tier.position);

  return (
    <>
      <SiteNav activePath="/standings" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>{division.name}</h2>
          <span className="pill" style={{ background: tc.bg, color: tc.fg }}>{division.tier.name}</span>
          <Link href={`/seasons/${division.seasonId}`} className="muted">
            {division.season.name}
          </Link>
          <Link href="/standings" style={{ marginLeft: "auto" }}>← all standings</Link>
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          {active.length} active player(s) · {division.pairings.length} set(s) played · {unplayed.length} remaining
        </div>

        <div className="card">
          <strong>Standings</strong>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr><th></th><th>Player</th><th>Pts</th><th>W-D-L</th><th>Games</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={5} className="muted">No sets played yet.</td></tr>
              ) : rows.map((r, i) => {
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

        <div className="card">
          <strong>Recent sets ({division.pairings.length})</strong>
          {division.pairings.length === 0 ? (
            <p className="muted" style={{ marginTop: 4 }}>No sets played yet.</p>
          ) : (
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Date</th><th>Result</th></tr></thead>
              <tbody>
                {division.pairings.slice(0, 30).map((p) => {
                  const date = p.confirmedAt ? p.confirmedAt.toISOString().slice(0, 10) : "—";
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

import Link from "next/link";
import { notFound } from "next/navigation";
import { hasTier } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { loadPlayerHistory } from "@/lib/profile";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { recordSetForPlayer } from "@/app/admin/players/actions";

export const dynamic = "force-dynamic";

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await loadPlayerHistory(id);
  if (!profile) notFound();

  const t = profile.totals;

  // BMP Ranked MMR snapshots — show current and previous LEAGUE seasons
  // side by side so players can see trend (improving, slipping). Falls
  // back to "just the latest" if there's only ever been one. Renders
  // nothing if zero snapshots — new players see the card appear once
  // the next refresh cycle catches them.
  const seasonSnapshots = await prisma.playerMmrSnapshot.findMany({
    where: {
      playerId: profile.player.id,
      rankedMmr: { not: null },
      seasonId: { not: null },
    },
    orderBy: { capturedAt: "desc" },
    distinct: ["seasonId"],
    include: { player: false },
    take: 2,
  });
  const seasonIds = seasonSnapshots.map((s) => s.seasonId!).filter(Boolean);
  const seasonNames = seasonIds.length === 0 ? [] : await prisma.season.findMany({
    where: { id: { in: seasonIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(seasonNames.map((s) => [s.id, s.name]));
  // Fallback: if no season-tied snapshots exist yet, show the most recent
  // un-tied snapshot so the card still renders for ad-hoc captures.
  const fallbackSnapshot = seasonSnapshots.length === 0
    ? await prisma.playerMmrSnapshot.findFirst({
        where: { playerId: profile.player.id, rankedMmr: { not: null } },
        orderBy: { capturedAt: "desc" },
      })
    : null;

  // Admin-only: if the viewer is an admin, surface a record-set form scoped
  // to this player's current division. Same opponent-filter rules as
  // /admin/players (only unplayed opponents shown).
  const isAdmin = await hasTier("ADMIN");
  const adminCtx = isAdmin
    ? await loadAdminRecordContext(profile.player.id)
    : null;

  return (
    <>
      <SiteNav activePath="" />
      <main>
        <h2>{profile.player.displayName}</h2>

        <div className="grid grid-3">
          <div className="stat"><div className="label">Seasons</div><div className="value">{t.seasons}</div></div>
          <div className="stat"><div className="label">Total points</div><div className="value">{t.points}</div></div>
          <div className="stat"><div className="label">Best rank</div><div className="value">{t.bestRank ? `#${t.bestRank}` : "—"}</div></div>
        </div>

        {(seasonSnapshots.length > 0 || fallbackSnapshot) && (
          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
              <strong>BMP Ranked MMR</strong>
              <span className="muted" style={{ fontSize: 11 }}>
                from <a href={`https://balatromp.com/players/${profile.player.discordId}`} target="_blank" rel="noopener">balatromp.com</a>
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: seasonSnapshots.length === 2 ? "1fr 1fr" : "1fr", gap: 12 }}>
              {seasonSnapshots.length > 0 ? (
                seasonSnapshots.map((snap, i) => (
                  <div key={snap.id} style={{ padding: 8, background: "var(--surface-2)", borderRadius: 4 }}>
                    <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                      {i === 0 ? "Current" : "Previous"} · {nameById.get(snap.seasonId!) ?? "Season"}
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 22, fontWeight: 600 }}>{snap.rankedMmr}</span>
                      <span className="pill" style={{ background: "rgba(118,199,255,0.15)", color: "#76c7ff", fontSize: 11 }}>
                        {snap.rankedTier}
                      </span>
                      {snap.totalGames != null && (
                        <span className="muted" style={{ fontSize: 11 }}>
                          {snap.totalGames}g · {snap.winRatePct}%
                        </span>
                      )}
                    </div>
                  </div>
                ))
              ) : fallbackSnapshot ? (
                <div style={{ padding: 8, background: "var(--surface-2)", borderRadius: 4 }}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                    Latest snapshot · captured {fallbackSnapshot.capturedAt.toISOString().slice(0, 10)}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 22, fontWeight: 600 }}>{fallbackSnapshot.rankedMmr}</span>
                    <span className="pill" style={{ background: "rgba(118,199,255,0.15)", color: "#76c7ff", fontSize: 11 }}>
                      {fallbackSnapshot.rankedTier}
                    </span>
                    {fallbackSnapshot.totalGames != null && (
                      <span className="muted" style={{ fontSize: 11 }}>
                        {fallbackSnapshot.totalGames}g · {fallbackSnapshot.winRatePct}%
                      </span>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {adminCtx && adminCtx.opponents.length > 0 && (
          <div className="card" style={{ borderColor: "#f1c40f" }}>
            <strong style={{ color: "#f1c40f" }}>⚙ Admin: record a set for {profile.player.displayName}</strong>
            <p className="muted" style={{ fontSize: 12 }}>
              In <strong>{adminCtx.divisionName}</strong>. Only unplayed opponents shown — to override
              an already-recorded set, use the division admin page.
            </p>
            <form action={recordSetForPlayer} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input type="hidden" name="divisionId" value={adminCtx.divisionId} />
              <input type="hidden" name="playerId" value={profile.player.id} />
              <select name="opponentId" required style={{ flex: "1 1 200px" }}>
                <option value="">— pick opponent —</option>
                {adminCtx.opponents.map((o) => (
                  <option key={o.playerId} value={o.playerId}>{o.displayName}</option>
                ))}
              </select>
              <select name="result" defaultValue="2-0">
                <option value="2-0">{profile.player.displayName} won 2-0</option>
                <option value="1-1">1-1 draw</option>
                <option value="0-2">{profile.player.displayName} lost 0-2</option>
              </select>
              <button type="submit">Record</button>
            </form>
          </div>
        )}
        <div className="grid grid-3" style={{ marginTop: 16 }}>
          <div className="stat"><div className="label">Wins (2-0)</div><div className="value">{t.wins}</div></div>
          <div className="stat"><div className="label">Draws (1-1)</div><div className="value">{t.draws}</div></div>
          <div className="stat"><div className="label">Losses (0-2)</div><div className="value">{t.losses}</div></div>
        </div>

        <h3 style={{ marginTop: 24 }}>Season history</h3>
        {profile.history.length === 0 ? (
          <div className="card muted">No season history yet.</div>
        ) : (
          profile.history.map((h) => {
            const rankStr = h.rank > 0 ? `#${h.rank}/${h.totalMembers}` : "—";
            const color = tierColors(h.tierPosition);
            return (
              <div key={h.seasonId} className="card">
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
                  <Link href={`/seasons/${h.seasonId}`} style={{ color: "var(--text)", fontWeight: 600, fontSize: 16 }}>
                    {h.seasonName}
                  </Link>
                  {h.isActive && <span className="pill" style={{ background: "rgba(46,204,113,0.15)", color: "var(--success)" }}>ACTIVE</span>}
                  <span className="pill" style={{ background: color.bg, color: color.fg }}>{h.tierName}</span>
                  <span>{h.divisionName}</span>
                  {h.status === "DROPPED" && (
                    <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "#e74c3c" }}>DROPPED</span>
                  )}
                  <span style={{ marginLeft: "auto" }} className="muted">
                    Rank {rankStr} · {h.points} pts · {h.wins}-{h.draws}-{h.losses} · {h.gamesWon}-{h.gamesLost} games
                  </span>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Opponent</th>
                      <th>Score</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h.matches.length === 0 ? (
                      <tr><td colSpan={4} className="muted">No sets played yet.</td></tr>
                    ) : (
                      h.matches.map((m, i) => {
                        const date = m.confirmedAt ? m.confirmedAt.toISOString().slice(0, 10) : "—";
                        const outcomePill =
                          m.outcome === "WIN" ? { bg: "rgba(46,204,113,0.15)", fg: "#2ecc71", label: "W" }
                          : m.outcome === "LOSS" ? { bg: "rgba(231,76,60,0.15)", fg: "#e74c3c", label: "L" }
                          : { bg: "rgba(241,196,15,0.15)", fg: "#f1c40f", label: "D" };
                        return (
                          <tr key={i}>
                            <td>{date}</td>
                            <td><Link href={`/profile/${m.opponentPlayerId}`} style={{ color: "var(--text)" }}>{m.opponentDisplayName}</Link></td>
                            <td><strong>{m.myGames}–{m.opponentGames}</strong></td>
                            <td><span className="pill" style={{ background: outcomePill.bg, color: outcomePill.fg }}>{outcomePill.label}</span></td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            );
          })
        )}
      </main>
    </>
  );
}

interface AdminRecordContext {
  divisionId: string;
  divisionName: string;
  opponents: Array<{ playerId: string; displayName: string }>;
}

async function loadAdminRecordContext(playerId: string): Promise<AdminRecordContext | null> {
  const membership = await prisma.divisionMember.findFirst({
    where: {
      playerId,
      status: "ACTIVE",
      division: { season: { isActive: true } },
    },
    include: {
      division: {
        include: {
          members: { where: { status: "ACTIVE" }, include: { player: true } },
          pairings: { where: { status: "CONFIRMED" }, select: { playerAId: true, playerBId: true } },
        },
      },
    },
  });
  if (!membership) return null;
  const div = membership.division;
  const played = new Set(
    div.pairings
      .filter((p) => p.playerAId === playerId || p.playerBId === playerId)
      .map((p) => (p.playerAId === playerId ? p.playerBId : p.playerAId)),
  );
  const opponents = div.members
    .filter((m) => m.playerId !== playerId && !played.has(m.playerId))
    .map((m) => ({ playerId: m.playerId, displayName: m.player.displayName }));
  return { divisionId: div.id, divisionName: div.name, opponents };
}

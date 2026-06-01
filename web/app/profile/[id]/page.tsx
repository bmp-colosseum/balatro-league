import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { hasTier } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { loadPlayerHistory } from "@/lib/profile";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { recordSetForPlayer } from "@/app/admin/players/actions";
import { castEasterEggVote } from "./actions";

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

  // Easter egg: if this profile belongs to Sanji, render the impeach /
  // don't-impeach poll under the totals strip. targetKey is a slug so
  // we can add new targets later without a schema change. Detection is
  // a case-insensitive substring on displayName so 'Sanji', 'sanji',
  // 'Budget Sanji | JOIN PPTT!!!!' all match. Voting requires Discord
  // OAuth login; one vote per logged-in user, switching sides updates.
  const isSanji = profile.player.displayName.toLowerCase().includes("sanji");
  const session = isSanji ? await auth() : null;
  const voterDiscordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  let yesVotes = 0;
  let noVotes = 0;
  let myVote: "yes" | "no" | null = null;
  if (isSanji) {
    const counts = await prisma.easterEggVote.groupBy({
      by: ["side"],
      where: { targetKey: "sanji" },
      _count: { side: true },
    });
    for (const c of counts) {
      if (c.side === "yes") yesVotes = c._count.side;
      if (c.side === "no") noVotes = c._count.side;
    }
    if (voterDiscordId) {
      const mine = await prisma.easterEggVote.findUnique({
        where: { targetKey_voterDiscordId: { targetKey: "sanji", voterDiscordId } },
      });
      if (mine?.side === "yes" || mine?.side === "no") myVote = mine.side;
    }
  }

  // BMP Ranked MMR snapshots — show latest 2 BMP SEASONS side by side
  // (e.g. season6 next to season5). Distinct on bmpSeason, ordered by
  // capturedAt desc, take 2 — gives the most recently-captured row per
  // BMP season. Worker captures current + previous on every refresh so
  // the trend view fills in without waiting for the next league cycle.
  const bmpSeasonSnapshots = await prisma.playerMmrSnapshot.findMany({
    where: {
      OR: [{ playerId: profile.player.id }, { discordId: profile.player.discordId }],
      rankedMmr: { not: null },
      bmpSeason: { not: null },
    },
    orderBy: [{ bmpSeason: "desc" }, { capturedAt: "desc" }],
    distinct: ["bmpSeason"],
    take: 2,
  });
  // Fallback: a player who's never been captured under an explicit
  // bmpSeason (legacy data or initial fetch before BmpCurrentSeason was
  // set) — pull their latest unlabeled snapshot so the card still renders.
  const fallbackSnapshot = bmpSeasonSnapshots.length === 0
    ? await prisma.playerMmrSnapshot.findFirst({
        where: {
          OR: [{ playerId: profile.player.id }, { discordId: profile.player.discordId }],
          rankedMmr: { not: null },
        },
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

        <div className="grid grid-2">
          <div className="stat"><div className="label">Seasons</div><div className="value">{t.seasons}</div></div>
          <div className="stat"><div className="label">Total points</div><div className="value">{t.points}</div></div>
        </div>

        {isSanji && (
          <div className="card" style={{ marginTop: 16, borderColor: "#e67e22" }}>
            <strong style={{ color: "#e67e22" }}>⚖️ Should we impeach {profile.player.displayName}?</strong>
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
              <form action={castEasterEggVote} style={{ display: "inline" }}>
                <input type="hidden" name="targetKey" value="sanji" />
                <input type="hidden" name="playerId" value={profile.player.id} />
                <input type="hidden" name="side" value="yes" />
                <button
                  type="submit"
                  disabled={!voterDiscordId}
                  style={{
                    background: myVote === "yes" ? "#c0392b" : "rgba(231,76,60,0.2)",
                    color: myVote === "yes" ? "#fff" : "#e74c3c",
                    border: "1px solid #e74c3c",
                    padding: "6px 12px",
                    borderRadius: 4,
                    cursor: voterDiscordId ? "pointer" : "not-allowed",
                    fontWeight: 600,
                  }}
                >
                  🔨 Impeach ({yesVotes})
                </button>
              </form>
              <form action={castEasterEggVote} style={{ display: "inline" }}>
                <input type="hidden" name="targetKey" value="sanji" />
                <input type="hidden" name="playerId" value={profile.player.id} />
                <input type="hidden" name="side" value="no" />
                <button
                  type="submit"
                  disabled={!voterDiscordId}
                  style={{
                    background: myVote === "no" ? "#27ae60" : "rgba(46,204,113,0.2)",
                    color: myVote === "no" ? "#fff" : "#2ecc71",
                    border: "1px solid #2ecc71",
                    padding: "6px 12px",
                    borderRadius: 4,
                    cursor: voterDiscordId ? "pointer" : "not-allowed",
                    fontWeight: 600,
                  }}
                >
                  🕊️ Keep ({noVotes})
                </button>
              </form>
              <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
                {voterDiscordId
                  ? myVote
                    ? `You voted ${myVote === "yes" ? "impeach" : "keep"} — click the other to switch.`
                    : "Cast your one vote."
                  : "Sign in with Discord to vote."}
              </span>
            </div>
          </div>
        )}

        {(bmpSeasonSnapshots.length > 0 || fallbackSnapshot) && (
          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
              <strong>BMP Ranked MMR</strong>
              <span className="muted" style={{ fontSize: 11 }}>
                from <a href={`https://balatromp.com/players/${profile.player.discordId}`} target="_blank" rel="noopener">balatromp.com</a>
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: bmpSeasonSnapshots.length === 2 ? "1fr 1fr" : "1fr", gap: 12 }}>
              {bmpSeasonSnapshots.length > 0 ? (
                bmpSeasonSnapshots.map((snap, i) => (
                  <div key={snap.id} style={{ padding: 8, background: "var(--surface-2)", borderRadius: 4 }}>
                    <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                      {i === 0 ? "Current" : "Previous"} · {formatBmpSeason(snap.bmpSeason)}
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 22, fontWeight: 600 }}>{snap.rankedMmr}</span>
                      <span className="pill" style={{ background: "rgba(118,199,255,0.15)", color: "#76c7ff", fontSize: 11 }}>
                        {snap.rankedTier}
                      </span>
                      {snap.leaderboardRank != null && (
                        <span className="muted" style={{ fontSize: 11 }}>
                          #{snap.leaderboardRank}
                        </span>
                      )}
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                      {snap.wins != null && snap.losses != null
                        ? `${snap.wins}W-${snap.losses}L`
                        : snap.totalGames != null
                          ? `${snap.totalGames} games`
                          : null}
                      {snap.winRatePct != null && ` · ${snap.winRatePct}% WR`}
                      {snap.peakMmr != null && ` · peak ${snap.peakMmr}`}
                      {snap.peakStreak != null && snap.peakStreak > 0 && ` · streak ${snap.peakStreak}`}
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
            <strong style={{ color: "#f1c40f" }}>⚙ Admin: record a match for {profile.player.displayName}</strong>
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
                  <Link href={`/divisions/${h.divisionId}`} style={{ color: "var(--text)" }}>{h.divisionName}</Link>
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
                      <tr><td colSpan={4} className="muted">No matches played yet.</td></tr>
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

// "season6" → "Season 6"; anything else returned as-is for forward
// compatibility with whatever naming BMP rolls out later.
function formatBmpSeason(s: string | null): string {
  if (!s) return "";
  const m = /^season(\d+)$/.exec(s);
  return m ? `Season ${m[1]}` : s;
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

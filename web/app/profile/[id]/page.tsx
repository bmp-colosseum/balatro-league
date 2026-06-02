import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { hasTier } from "@/lib/admin";
import { loadProfileExtras } from "@/lib/loaders/profile-extras";
import { getShowBmpMmr } from "@/lib/preferences";
import { loadPlayerHistory } from "@/lib/profile";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { recordSetForPlayer } from "@/app/admin/players/actions";
import { castEasterEggVote, reportFromProfileAction, submitProfileDispute } from "./actions";

export const dynamic = "force-dynamic";

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ disputeOk?: string; disputeErr?: string }>;
}) {
  const { id } = await params;
  const { disputeOk, disputeErr } = await searchParams;
  const profile = await loadPlayerHistory(id);
  if (!profile) notFound();

  const t = profile.totals;

  const viewerSession = await auth();
  const viewerDiscordId =
    (viewerSession?.user as { discordId?: string } | undefined)?.discordId ?? null;
  const showBmpMmr = await getShowBmpMmr();
  const isAdmin = await hasTier("ADMIN");
  const { viewer, sanji, bmpSeasonSnapshots, fallbackSnapshot, adminCtx, ownActiveDivision } = await loadProfileExtras({
    profilePlayerId: profile.player.id,
    profileDiscordId: profile.player.discordId,
    profileDisplayName: profile.player.displayName,
    viewerDiscordId,
    isViewerAdmin: isAdmin,
    showBmpMmr,
  });
  const isOwnProfile = viewer.isOwnProfile;
  const { isSanji, voterDiscordId, yesVotes, noVotes, myVote } = sanji;

  return (
    <>
      <SiteNav activePath="" />
      <main>
        <h2>{profile.player.displayName}</h2>

        <div className="grid grid-2">
          <div
            className="stat"
            title="League-wide rank (1 = best player in the league). Updated at end of season."
          >
            <div className="label">Overall rank</div>
            <div className="value">
              {profile.player.rating != null ? `#${profile.player.rating}` : <span className="muted">—</span>}
            </div>
          </div>
          <div className="stat"><div className="label">Seasons</div><div className="value">{t.seasons}</div></div>
          <div className="stat"><div className="label">Total points</div><div className="value">{t.points}</div></div>
        </div>

        {/* Own profile + active division → report-a-match dropdown.
            Same UX as /me, just lives here so the player can stay on
            their profile while logging results. */}
        {isOwnProfile && ownActiveDivision && (
          <div className="card" style={{ marginTop: 16 }}>
            <strong>Report a match — {ownActiveDivision.divisionName}</strong>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              Season: {ownActiveDivision.seasonName}
            </div>
            {ownActiveDivision.reportableOpponents.length === 0 ? (
              <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
                No unplayed opponents — you've played everyone in your division.
              </p>
            ) : (
              <>
                <form action={reportFromProfileAction} style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input type="hidden" name="profileId" value={profile.player.id} />
                  <span className="muted" style={{ fontSize: 12 }}>vs</span>
                  <select name="opponentId" required style={{ flex: "1 1 200px" }}>
                    <option value="">— pick an opponent —</option>
                    {ownActiveDivision.reportableOpponents.map((o) => (
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
                  Reports go to <strong>#results</strong> with Confirm + Dispute buttons. If no one
                  clicks within 2 minutes, the result auto-confirms.
                </p>
              </>
            )}
          </div>
        )}

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
              <strong>BMP Ranked history</strong>
              <span className="muted" style={{ fontSize: 11 }}>
                from <a href={`https://balatromp.com/players/${profile.player.discordId}`} target="_blank" rel="noopener">balatromp.com</a>
              </span>
            </div>
            {bmpSeasonSnapshots.length > 0 ? (
              <table style={{ fontSize: 12, marginTop: 4, width: "100%" }}>
                <thead>
                  <tr>
                    <th>Season</th>
                    <th>MMR</th>
                    <th>Tier</th>
                    <th>Peak</th>
                    <th>W-L</th>
                    <th>Win %</th>
                    <th>Rank</th>
                    <th>Streak</th>
                  </tr>
                </thead>
                <tbody>
                  {bmpSeasonSnapshots.map((snap, i) => (
                    <tr key={snap.id}>
                      <td>
                        <strong>{formatBmpSeason(snap.bmpSeason)}</strong>
                        {i === 0 && <span className="muted" style={{ fontSize: 11 }}> · current</span>}
                      </td>
                      <td><strong>{snap.rankedMmr}</strong></td>
                      <td>
                        <span className="pill" style={{ background: "rgba(118,199,255,0.15)", color: "#76c7ff", fontSize: 11 }}>
                          {snap.rankedTier}
                        </span>
                      </td>
                      <td>{snap.peakMmr ?? <span className="muted">—</span>}</td>
                      <td>
                        {snap.wins != null && snap.losses != null
                          ? `${snap.wins}-${snap.losses}`
                          : <span className="muted">—</span>}
                      </td>
                      <td>{snap.winRatePct != null ? `${snap.winRatePct}%` : <span className="muted">—</span>}</td>
                      <td>{snap.leaderboardRank != null ? `#${snap.leaderboardRank}` : <span className="muted">—</span>}</td>
                      <td>{snap.peakStreak != null && snap.peakStreak > 0 ? snap.peakStreak : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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

        {disputeOk && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ Dispute filed. A helper has been pinged in #results.
          </div>
        )}
        {disputeErr && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {disputeErr}
          </div>
        )}

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
                    {h.finalGlobalRank != null && (
                      <span
                        title="Global league rank when this season ended. Doesn't shift when later seasons recompute Player.rating."
                        style={{ marginLeft: 8 }}
                      >
                        · global #{h.finalGlobalRank}
                      </span>
                    )}
                  </span>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Opponent</th>
                      <th>Score</th>
                      <th>Result</th>
                      {isOwnProfile && h.isActive && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {h.matches.length === 0 ? (
                      <tr><td colSpan={isOwnProfile && h.isActive ? 5 : 4} className="muted">No matches played yet.</td></tr>
                    ) : (
                      h.matches.map((m, i) => {
                        const date = m.confirmedAt ? m.confirmedAt.toISOString().slice(0, 10) : "—";
                        const isDisputed = m.status === "DISPUTED";
                        const isShootout = m.isShootout === true;
                        const outcomePill =
                          isDisputed ? { bg: "rgba(241,196,15,0.15)", fg: "#f1c40f", label: "DISPUTED" }
                          : m.outcome === "WIN" ? { bg: "rgba(46,204,113,0.15)", fg: "#2ecc71", label: "W" }
                          : m.outcome === "LOSS" ? { bg: "rgba(231,76,60,0.15)", fg: "#e74c3c", label: "L" }
                          : { bg: "rgba(241,196,15,0.15)", fg: "#f1c40f", label: "D" };
                        return (
                          <tr key={i} style={isDisputed ? { opacity: 0.7 } : undefined}>
                            <td>{date}</td>
                            <td>
                              {isShootout && <span title="Shootout (1-game tiebreaker)" style={{ marginRight: 4 }}>⚔</span>}
                              <Link href={`/profile/${m.opponentPlayerId}`} style={{ color: "var(--text)" }}>{m.opponentDisplayName}</Link>
                              {isShootout && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>(shootout)</span>}
                            </td>
                            <td><strong>{m.myGames}–{m.opponentGames}</strong></td>
                            <td><span className="pill" style={{ background: outcomePill.bg, color: outcomePill.fg, fontSize: isDisputed ? 10 : undefined }}>{outcomePill.label}</span></td>
                            {isOwnProfile && h.isActive && isShootout && (
                              <td className="muted" style={{ fontSize: 11 }}>—</td>
                            )}
                            {isOwnProfile && h.isActive && !isShootout && (
                              <td>
                                <details>
                                  <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--muted-text, #888)" }}>
                                    {isDisputed ? "Update dispute" : "Dispute"}
                                  </summary>
                                  <form action={submitProfileDispute} style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4, minWidth: 200 }}>
                                    <input type="hidden" name="pairingId" value={m.pairingId} />
                                    <input type="hidden" name="profileId" value={profile.player.id} />
                                    <label style={{ fontSize: 11 }} className="muted">What it should be (your POV):</label>
                                    <select name="proposed" defaultValue="unsure" style={{ fontSize: 12 }}>
                                      <option value="unsure">— not sure, let helper decide —</option>
                                      <option value="2-0">2-0 (I won both)</option>
                                      <option value="1-1">1-1 (draw)</option>
                                      <option value="0-2">0-2 (I lost both)</option>
                                    </select>
                                    <textarea
                                      name="reason"
                                      rows={2}
                                      placeholder="Optional context for the helper…"
                                      maxLength={500}
                                      style={{ fontSize: 12, width: "100%" }}
                                    />
                                    <button type="submit" className="secondary" style={{ fontSize: 11 }}>
                                      Submit dispute
                                    </button>
                                  </form>
                                </details>
                              </td>
                            )}
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


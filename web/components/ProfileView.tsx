import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { hasTier } from "@/lib/admin";
import { loadProfileExtras } from "@/lib/loaders/profile-extras";
import { loadPlayerTraits } from "@/lib/loaders/player-traits";
import { deckImage, stakeImage } from "@/lib/balatro-slugs";
import { getShowBmpMmr } from "@/lib/preferences";
import { loadPlayerHistory, loadPlayerBanStats } from "@/lib/profile";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { DiscordId } from "@/components/DiscordId";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReportForm } from "@/components/ReportForm";
import { MatchActionsPanel } from "@/components/MatchActionsPanel";
import { DisputeForm } from "@/components/DisputeForm";
import { CANONICAL_DECKS, CANONICAL_STAKES } from "@/lib/balatro-info";
import { reportFromProfileAction, submitProfileDispute } from "@/app/profile/[id]/actions";
import { resetToDiscordNameAction, setCustomNameAction, setShowUsernameAction } from "@/app/me/actions";
import { TimezoneSetting } from "@/components/TimezoneSetting";
import { NextSeasonCard } from "@/components/NextSeasonCard";
import { prisma } from "@/lib/prisma";
import type { SeasonHistoryEntry, FavoriteEntry, BanStatEntry } from "@/lib/profile";

// Builds the hover tooltip for a season card's "W-D-L" inline number.
// Spells out the rates explicitly so a glance over a player's career
// can answer "is that win count from a few seasons or one good one".
function seasonRateTooltip(h: SeasonHistoryEntry): string {
  if (h.played === 0) return "No matches yet.";
  const win = Math.round((h.wins / h.played) * 100);
  const draw = Math.round((h.draws / h.played) * 100);
  const loss = Math.round((h.losses / h.played) * 100);
  return `${win}% W · ${draw}% D · ${loss}% L`;
}

// One "favourite" row — deck and/or stake thumbnail + name + a count
// (× plays, or W for wins). Combos carry "Deck · Stake" so we split + show both.
function favRow(r: FavoriteEntry, kind: "deck" | "stake" | "combo", metric: "played" | "won") {
  const [deckName, stakeName] = kind === "combo" ? r.name.split(" · ") : [r.name, r.name];
  // Win RATE is the headline, with the wins/plays record next to it for
  // context — never a bare play count. e.g. "3W/5  60%".
  const winRate = r.gamesPlayed > 0 ? Math.round((r.gamesWon / r.gamesPlayed) * 100) : 0;
  const title =
    metric === "won"
      ? `${r.gamesWon} wins across ${r.gamesPlayed} games`
      : `${r.gamesPlayed} games played, ${r.gamesWon} won`;
  return (
    <li key={r.name} title={title} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0" }}>
      {(kind === "deck" || kind === "combo") && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={deckImage(deckName!)} alt="" width={16} height={16} style={{ borderRadius: 2 }} />
      )}
      {(kind === "stake" || kind === "combo") && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={stakeImage(kind === "combo" ? stakeName! : r.name)} alt="" width={16} height={16} style={{ borderRadius: 2 }} />
      )}
      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
      <span className="muted" style={{ whiteSpace: "nowrap", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
        {r.gamesWon}W/{r.gamesPlayed}
      </span>
      <span
        style={{
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
          fontWeight: 600,
          minWidth: 36,
          textAlign: "right",
          color: winRate >= 50 ? "#2ecc71" : "#e74c3c",
        }}
      >
        {winRate}%
      </span>
    </li>
  );
}
// One "most-banned" row: icon, name, ban rate (how often this player bans it
// when it appears) + the bans/appearances record. Ban rate isn't good/bad, so
// it's a neutral orange, not win/loss colours.
function banRow(r: BanStatEntry, kind: "deck" | "stake") {
  return (
    <li
      key={r.name}
      title={`Banned ${r.bans} of the ${r.appearances} times it appeared in your pool`}
      style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={kind === "deck" ? deckImage(r.name) : stakeImage(r.name)} alt="" width={16} height={16} style={{ borderRadius: 2 }} />
      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
      <span className="muted" style={{ whiteSpace: "nowrap", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
        {r.bans}/{r.appearances}
      </span>
      <span style={{ whiteSpace: "nowrap", fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right", color: "#e67e22" }}>
        {r.banRatePct}%
      </span>
    </li>
  );
}
function favBlock(title: string, rows: FavoriteEntry[], kind: "deck" | "stake" | "combo", metric: "played" | "won") {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>{title}</div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
        {rows.map((r) => favRow(r, kind, metric))}
      </ul>
    </div>
  );
}

// Unified profile view, rendered by BOTH /profile/[id] and /me (no redirect).
// It resolves the viewer itself (via auth) and branches the UI on the
// relationship: your own profile (settings + report form + next-season
// opt-ins), an admin (record / DQ tools), or anyone else (read-only + the
// "vs you" head-to-head).
export async function ProfileView({
  playerId,
  disputeOk,
  disputeErr,
}: {
  playerId: string;
  disputeOk?: string;
  disputeErr?: string;
}) {
  const profile = await loadPlayerHistory(playerId);
  if (!profile) notFound();

  const t = profile.totals;

  const viewerSession = await auth();
  const viewerDiscordId =
    (viewerSession?.user as { discordId?: string } | undefined)?.discordId ?? null;
  const viewerInGuild =
    (viewerSession?.user as { inGuild?: boolean } | undefined)?.inGuild === true;
  const showBmpMmr = await getShowBmpMmr();
  const isAdmin = await hasTier("ADMIN");
  const { viewer, bmpSeasonSnapshots, fallbackSnapshot, adminCtx, ownActiveDivision } = await loadProfileExtras({
    profilePlayerId: profile.player.id,
    profileDiscordId: profile.player.discordId,
    viewerDiscordId,
    isViewerAdmin: isAdmin,
    showBmpMmr,
  });
  const isOwnProfile = viewer.isOwnProfile;
  const traits = await loadPlayerTraits(profile.player.id);
  // Own-profile-only personal settings (folded in from the old /me page).
  const myPrefs = isOwnProfile
    ? await prisma.player.findUnique({
        where: { id: profile.player.id },
        select: { hasCustomDisplayName: true, signupReminderOptOut: true },
      })
    : null;
  const myInterest = isOwnProfile
    ? await prisma.seasonInterest.findUnique({
        where: { discordId: profile.player.discordId },
        select: { subscribedAt: true },
      })
    : null;
  const me = isOwnProfile
    ? {
        hasCustomDisplayName: myPrefs?.hasCustomDisplayName ?? false,
        // Reminded by default (any past player) unless they opted out; the 🔔
        // interest row also counts as on.
        remindersOn: !!myInterest || !(myPrefs?.signupReminderOptOut ?? false),
      }
    : null;
  // Privacy fields for the profiled player — needed both for the timezone
  // display (to server members) and, on your own profile, the Privacy settings.
  const playerPrivacy = await prisma.player.findUnique({
    where: { id: profile.player.id },
    select: { timezone: true, showUsername: true },
  });
  // Timezone is shown only to server members (and always to yourself).
  const shownTimezone =
    (isOwnProfile || viewerInGuild) && playerPrivacy?.timezone ? playerPrivacy.timezone : null;

  // What this player bans (most-banned decks/stakes + their ban rate).
  const banStats = await loadPlayerBanStats(profile.player.id);

  return (
    <>
      <SiteNav activePath="" />
      <main>
        <p style={{ marginBottom: 4 }}>
          <Link href="/standings" className="muted" style={{ fontSize: 13 }}>← Standings</Link>
        </p>
        <h2>{profile.player.displayName}<DiscordId value={profile.player.discordId} username={profile.player.username} /></h2>
        {shownTimezone && (
          <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>🕐 {shownTimezone}</p>
        )}

        <div className="grid grid-2">
          <div className="stat"><div className="label">Seasons</div><div className="value">{t.seasons}</div></div>
          <div className="stat"><div className="label">Total points</div><div className="value">{t.points}</div></div>
        </div>

        {/* Fun traits derived from ban/pick behaviour — flavour only. */}
        {traits.length > 0 && (
          <div className="card" style={{ marginTop: 12 }}>
            <strong style={{ fontSize: 13 }}>🎭 Traits</strong>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {traits.map((tr) => (
                <span
                  key={tr.key}
                  title={`${tr.description} (${tr.detail})\n\nHow it's earned: ${tr.criteria}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    borderRadius: 999,
                    background: "rgba(155,89,182,0.15)",
                    border: "1px solid rgba(155,89,182,0.4)",
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {tr.iconDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={tr.iconDataUrl}
                      alt=""
                      width={16}
                      height={16}
                      style={{ borderRadius: 3, objectFit: "contain" }}
                    />
                  ) : (
                    <span>{tr.emoji}</span>
                  )}{" "}
                  {tr.label}
                </span>
              ))}
            </div>
          </div>
        )}

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
                {ownActiveDivision.scheduleLocked
                  ? "You've played all your scheduled opponents. Your season is complete."
                  : "You've played everyone in your division."}
              </p>
            ) : (
              <div style={{ marginTop: 8 }}>
                <ReportForm
                  action={reportFromProfileAction}
                  opponents={ownActiveDivision.reportableOpponents.map((o) => ({
                    playerId: o.playerId,
                    displayName: o.displayName,
                    alreadyPending: false,
                  }))}
                  decks={CANONICAL_DECKS.map((d) => d.name)}
                  stakes={CANONICAL_STAKES.map((s) => s.name)}
                  hiddenFields={{ profileId: profile.player.id }}
                />
                <p className="muted" style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}>
                  Recorded right away and posted to <strong>#results</strong>. Your opponent gets a DM to dispute if it&apos;s wrong.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Personal settings — only on your own profile (folded in from /me). */}
        {me && (
          <>
            <NextSeasonCard remindersOn={me.remindersOn} />

            <div className="card" style={{ marginTop: 16 }}>
              <strong>Display name</strong>
              <p className="muted" style={{ fontSize: 12 }}>
                {me.hasCustomDisplayName
                  ? <>Using custom name <strong>{profile.player.displayName}</strong>. Reset to sync from Discord.</>
                  : <>Synced from your Discord name (<strong>{profile.player.displayName}</strong>). Set a custom one below.</>}
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <form action={setCustomNameAction} style={{ display: "flex", gap: 6, flex: "1 1 280px" }}>
                  <Input type="text" name="displayName" defaultValue={profile.player.displayName} required maxLength={64} style={{ flex: 1 }} />
                  <Button type="submit">Save custom name</Button>
                </form>
                {me.hasCustomDisplayName && (
                  <form action={resetToDiscordNameAction}>
                    <Button type="submit" variant="secondary">↻ Reset to auto</Button>
                  </form>
                )}
              </div>
            </div>

            {/* Privacy — you control what's shared. Both default to the
                least-surprising state: timezone off (opt in), @username on
                (opt out), and both are visible to server members only. */}
            <div className="card" style={{ marginTop: 16 }}>
              <strong>Privacy</strong>

              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Timezone</div>
                <TimezoneSetting current={playerPrivacy?.timezone ?? null} />
              </div>

              <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Discord @username</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 13 }}>
                    {playerPrivacy?.showUsername ?? true
                      ? <>Visible to server members next to your name.</>
                      : <>Hidden — your @username isn&apos;t shown to anyone.</>}
                  </span>
                  <form action={setShowUsernameAction}>
                    <input type="hidden" name="show" value={(playerPrivacy?.showUsername ?? true) ? "0" : "1"} />
                    <Button type="submit" variant="secondary">
                      {(playerPrivacy?.showUsername ?? true) ? "Hide my @username" : "Show my @username"}
                    </Button>
                  </form>
                </div>
              </div>
            </div>
          </>
        )}

        {(bmpSeasonSnapshots.length > 0 || fallbackSnapshot) && (
          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
              <strong>BMP Ranked history</strong>
              <span className="muted" style={{ fontSize: 11 }}>
                from <a href={`https://balatromp.com/players/${profile.player.discordId}`} target="_blank" rel="noopener">balatromp.com</a>
              </span>
            </div>
            <p className="muted" style={{ fontSize: 11, marginTop: 0, marginBottom: 8 }}>
              One snapshot per BMP season.
            </p>
            {bmpSeasonSnapshots.length > 0 ? (
              <table className="responsive-table" style={{ fontSize: 12, marginTop: 4, width: "100%" }}>
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
                      <td className="card-header">
                        <strong>{formatBmpSeason(snap.bmpSeason)}</strong>
                        {i === 0 && <span className="muted" style={{ fontSize: 11 }}> · current</span>}
                      </td>
                      <td data-label="MMR"><strong>{snap.rankedMmr}</strong></td>
                      <td data-label="Tier">
                        <span className="pill" style={{ background: "rgba(118,199,255,0.15)", color: "#76c7ff", fontSize: 11 }}>
                          {snap.rankedTier}
                        </span>
                      </td>
                      <td data-label="Peak">{snap.peakMmr ?? <span className="muted">—</span>}</td>
                      <td data-label="W-L">
                        {snap.wins != null && snap.losses != null
                          ? `${snap.wins}-${snap.losses}`
                          : <span className="muted">—</span>}
                      </td>
                      <td data-label="Win %">{snap.winRatePct != null ? `${snap.winRatePct}%` : <span className="muted">—</span>}</td>
                      <td data-label="Rank">{snap.leaderboardRank != null ? `#${snap.leaderboardRank}` : <span className="muted">—</span>}</td>
                      <td data-label="Streak">{snap.peakStreak != null && snap.peakStreak > 0 ? snap.peakStreak : <span className="muted">—</span>}</td>
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

        {adminCtx && adminCtx.members.length > 1 && (
          <div style={{ marginTop: 16 }}>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
              <span style={{ color: "#f1c40f" }}>⚙ Admin</span> — {profile.player.displayName}&apos;s matches in{" "}
              <strong>{adminCtx.divisionName}</strong>. Record, fix, void, or DQ any of them below.
            </p>
            <MatchActionsPanel
              divisionId={adminCtx.divisionId}
              returnTo={`/profile/${profile.player.id}`}
              members={adminCtx.members}
              unplayed={adminCtx.unplayed}
              played={adminCtx.played}
            />
          </div>
        )}
        <div className="grid grid-3" style={{ marginTop: 16 }}>
          <div className="stat" title={t.totalMatches > 0 ? `${t.wins}/${t.totalMatches} matches won 2-0` : undefined}>
            <div className="label">Wins (2-0)</div>
            <div className="value">{t.wins}{t.totalMatches > 0 && <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}> · {t.winRatePct}%</span>}</div>
          </div>
          <div className="stat" title={t.totalMatches > 0 ? `${t.draws}/${t.totalMatches} matches drew 1-1` : undefined}>
            <div className="label">Draws (1-1)</div>
            <div className="value">{t.draws}{t.totalMatches > 0 && <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}> · {t.drawRatePct}%</span>}</div>
          </div>
          <div className="stat" title={t.totalMatches > 0 ? `${t.losses}/${t.totalMatches} matches lost 0-2` : undefined}>
            <div className="label">Losses (0-2)</div>
            <div className="value">{t.losses}{t.totalMatches > 0 && <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}> · {t.lossRatePct}%</span>}</div>
          </div>
        </div>
        {t.totalGames > 0 && (
          <div
            className="muted"
            style={{ marginTop: 6, fontSize: 12 }}
            title="Game-level win rate."
          >
            Game win rate: <strong>{t.gameWinRatePct}%</strong> (across {t.totalGames} games)
          </div>
        )}

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

        {/* "Vs you" head-to-head — only when looking at someone else's
            profile and we have at least one match between us. */}
        {(() => {
          if (isOwnProfile || !viewer.playerId) return null;
          const h2h = profile.headToHeads.find(
            (h) => h.opponentPlayerId === viewer.playerId,
          );
          if (!h2h) return null;
          return (
            <div className="card" style={{ marginTop: 16, borderColor: "#76c7ff" }}>
              <strong style={{ color: "#76c7ff" }}>vs you</strong>
              <p style={{ marginTop: 4, marginBottom: 0 }}>
                <strong>{h2h.wins}W</strong> – <strong>{h2h.draws}D</strong> – <strong>{h2h.losses}L</strong>{" "}
                across {h2h.totalMatches} matches (game record {h2h.gamesWon}-{h2h.gamesLost}).{" "}
                <span className="muted" style={{ fontSize: 12 }}>From your perspective.</span>
              </p>
            </div>
          );
        })()}

        {/* Personal deck/stake analytics — collapsed so they don't bury the
            record above. These are YOUR numbers; league-wide stats live on /stats. */}
        {(profile.deckPerformance.filter((d) => d.gamesTotal >= 5).length > 0
          || profile.favorites.mostPlayed.decks.length > 0
          || banStats.decks.length > 0
          || banStats.stakes.length > 0) && (
          <details className="card" style={{ marginTop: 16 }}>
            <summary style={{ cursor: "pointer" }}><strong>Your deck &amp; stake stats</strong></summary>
        {/* Deck + stake performance cards. Apply a minimum-games filter
            (5+ games) so a 100%/1 deck doesn't shout louder than a
            real signal. */}
        {profile.deckPerformance.filter((d) => d.gamesTotal >= 5).length > 0 && (
          <div className="grid grid-2" style={{ marginTop: 16 }}>
            <div className="card">
              <strong>Deck performance</strong>
              <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
                Per deck. Min 5 games.
              </p>
              <table className="table-dense" style={{ width: "100%", fontSize: 12 }}>
                <tbody>
                  {profile.deckPerformance
                    .filter((d) => d.gamesTotal >= 5)
                    .slice(0, 10)
                    .map((d) => (
                      <tr key={d.name}>
                        <td>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={deckImage(d.name)} alt="" width={20} height={20} style={{ verticalAlign: "middle", marginRight: 6, borderRadius: 3 }} />
                          {d.name}
                        </td>
                        <td style={{ textAlign: "right" }} className="muted">
                          {d.gamesWon}/{d.gamesTotal}
                        </td>
                        <td style={{ textAlign: "right", width: 50 }}>
                          <strong style={{ color: d.winRatePct >= 50 ? "#2ecc71" : "#e74c3c" }}>
                            {d.winRatePct}%
                          </strong>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {profile.stakePerformance.filter((s) => s.gamesTotal >= 5).length > 0 && (
              <div className="card">
                <strong>Stake performance</strong>
                <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
                  Per stake. Min 5 games.
                </p>
                <table className="table-dense" style={{ width: "100%", fontSize: 12 }}>
                  <tbody>
                    {profile.stakePerformance
                      .filter((s) => s.gamesTotal >= 5)
                      .map((s) => (
                        <tr key={s.name}>
                          <td>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={stakeImage(s.name)} alt="" width={20} height={20} style={{ verticalAlign: "middle", marginRight: 6, borderRadius: 3 }} />
                            {s.name}
                          </td>
                          <td style={{ textAlign: "right" }} className="muted">
                            {s.gamesWon}/{s.gamesTotal}
                          </td>
                          <td style={{ textAlign: "right", width: 50 }}>
                            <strong style={{ color: s.winRatePct >= 50 ? "#2ecc71" : "#e74c3c" }}>
                              {s.winRatePct}%
                            </strong>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Favourites — top-5 by raw count (decks / stakes / combos), most-
            played and (separately) most-won. */}
        {profile.favorites.mostPlayed.decks.length > 0 && (
          <div className="grid grid-2" style={{ marginTop: 16 }}>
            <div className="card">
              <strong>⭐ Most played</strong>
              <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
                By games played.
              </p>
              {favBlock("Decks", profile.favorites.mostPlayed.decks, "deck", "played")}
              {favBlock("Stakes", profile.favorites.mostPlayed.stakes, "stake", "played")}
              {favBlock("Combos", profile.favorites.mostPlayed.combos, "combo", "played")}
            </div>
            <div className="card">
              <strong>🏆 Most won</strong>
              <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
                By games won.
              </p>
              {favBlock("Decks", profile.favorites.mostWon.decks, "deck", "won")}
              {favBlock("Stakes", profile.favorites.mostWon.stakes, "stake", "won")}
              {favBlock("Combos", profile.favorites.mostWon.combos, "combo", "won")}
            </div>
          </div>
        )}

        {/* What this player bans — their most-banned decks/stakes + ban rate. */}
        {(banStats.decks.length > 0 || banStats.stakes.length > 0) && (
          <div className="grid grid-2" style={{ marginTop: 16 }}>
            {banStats.decks.length > 0 && (
              <div className="card">
                <strong>🚫 Most-banned decks</strong>
                <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
                  How often you ban each deck when it shows up.
                </p>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
                  {banStats.decks.map((r) => banRow(r, "deck"))}
                </ul>
              </div>
            )}
            {banStats.stakes.length > 0 && (
              <div className="card">
                <strong>🚫 Most-banned stakes</strong>
                <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
                  How often you ban each stake when it shows up.
                </p>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
                  {banStats.stakes.map((r) => banRow(r, "stake"))}
                </ul>
              </div>
            )}
          </div>
        )}
          </details>
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
                </div>
                {/* Stat summary on its own line directly under the title —
                    keeps the numbers close to the season name instead of
                    flung to the far-right edge, and wraps cleanly on phones. */}
                <div className="muted" style={{ fontSize: 13, marginBottom: 8, lineHeight: 1.7 }}>
                    Rank {rankStr} · {h.points} pts ·{" "}
                    <span title={seasonRateTooltip(h)}>
                      {h.wins}-{h.draws}-{h.losses}
                      {h.played > 0 && (
                        <span style={{ marginLeft: 4, fontSize: 11 }}>
                          ({Math.round((h.wins / h.played) * 100)}% win)
                        </span>
                      )}
                    </span>{" "}
                    · {h.gamesWon}-{h.gamesLost} games
                    {(h.seedRank != null || h.finalGlobalRank != null) && (
                      <span
                        title={
                          h.seedRank != null && h.finalGlobalRank != null
                            ? `Seeded into this season at global #${h.seedRank}, finished at global #${h.finalGlobalRank}.`
                            : h.seedRank != null
                            ? `Seeded into this season at global #${h.seedRank}.`
                            : `Finished this season at global #${h.finalGlobalRank}.`
                        }
                        style={{ marginLeft: 8 }}
                      >
                        · global{" "}
                        {h.seedRank != null ? `#${h.seedRank}` : "—"}
                        {" → "}
                        {h.finalGlobalRank != null ? `#${h.finalGlobalRank}` : "TBD"}
                        {h.seedRank != null && h.finalGlobalRank != null && (
                          <span
                            style={{
                              marginLeft: 4,
                              fontSize: 11,
                              color:
                                h.finalGlobalRank < h.seedRank
                                  ? "#2ecc71"
                                  : h.finalGlobalRank > h.seedRank
                                  ? "#e74c3c"
                                  : "#888",
                            }}
                          >
                            ({h.finalGlobalRank < h.seedRank ? "↑" : h.finalGlobalRank > h.seedRank ? "↓" : "·"}
                            {Math.abs(h.finalGlobalRank - h.seedRank)})
                          </span>
                        )}
                      </span>
                    )}
                </div>
                <table className="responsive-table">
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
                        // A 0-0 is a void (finished, no points) — distinct from a 1-1 draw.
                        const isVoid = m.myGames === 0 && m.opponentGames === 0;
                        const outcomePill =
                          isDisputed ? { bg: "rgba(241,196,15,0.15)", fg: "#f1c40f", label: "DISPUTED" }
                          : isVoid ? { bg: "rgba(149,165,166,0.18)", fg: "#95a5a6", label: "V" }
                          : m.outcome === "WIN" ? { bg: "rgba(46,204,113,0.15)", fg: "#2ecc71", label: "W" }
                          : m.outcome === "LOSS" ? { bg: "rgba(231,76,60,0.15)", fg: "#e74c3c", label: "L" }
                          : { bg: "rgba(241,196,15,0.15)", fg: "#f1c40f", label: "D" };
                        return (
                          <tr key={i} style={isDisputed ? { opacity: 0.7 } : undefined}>
                            <td data-label="Date">{date}</td>
                            <td className="card-header">
                              {isShootout && <span title="Shootout (a 1-game tiebreaker)" style={{ marginRight: 4 }}>⚔</span>}
                              <Link href={`/profile/${m.opponentPlayerId}`} style={{ color: "var(--text)" }}>{m.opponentDisplayName}</Link>
                              {isShootout && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>(shootout)</span>}
                            </td>
                            <td data-label="Score">
                              <strong>{m.myGames}-{m.opponentGames}</strong>
                              {m.games.length > 0 && (
                                <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
                                  {m.games.map((g, gi) => (
                                    <span key={gi} style={{ marginRight: 6 }}>
                                      <span style={{ opacity: 0.6 }}>g{g.num}</span>{" "}
                                      <span
                                        title={
                                          (g.deck && g.stake ? `${g.deck} / ${g.stake}` : "lives only — no deck/stake recorded") +
                                          (g.lives != null ? ` · winner had ${g.lives} ${g.lives === 1 ? "life" : "lives"} left` : "") +
                                          (g.iWon === null ? "" : g.iWon ? " · won" : " · lost")
                                        }
                                        style={{
                                          display: "inline-flex",
                                          alignItems: "center",
                                          gap: 2,
                                          color:
                                            g.iWon === true
                                              ? "#2ecc71"
                                              : g.iWon === false
                                              ? "#e74c3c"
                                              : undefined,
                                        }}
                                      >
                                        {g.deck && g.stake ? (
                                          <>
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={deckImage(g.deck)} alt="" width={14} height={14} style={{ borderRadius: 2 }} />
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={stakeImage(g.stake)} alt="" width={14} height={14} style={{ borderRadius: 2 }} />
                                            {g.deck}/{g.stake}
                                          </>
                                        ) : (
                                          g.lives != null ? `♥${g.lives}` : "—"
                                        )}
                                        {g.deck && g.stake && g.lives != null ? (
                                          <span style={{ opacity: 0.7 }}>&nbsp;♥{g.lives}</span>
                                        ) : null}
                                      </span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td data-label="Result"><span className="pill" style={{ background: outcomePill.bg, color: outcomePill.fg, fontSize: isDisputed ? 10 : undefined }}>{outcomePill.label}</span></td>
                            {isOwnProfile && h.isActive && isShootout && (
                              <td className="muted" style={{ fontSize: 11 }}>—</td>
                            )}
                            {isOwnProfile && h.isActive && !isShootout && (
                              <td>
                                <DisputeForm
                                  action={submitProfileDispute}
                                  pairingId={m.pairingId}
                                  opponentName={m.opponentDisplayName}
                                  isDisputed={isDisputed}
                                  hiddenFields={{ profileId: profile.player.id }}
                                />
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


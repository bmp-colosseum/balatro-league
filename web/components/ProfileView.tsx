import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { hasTier } from "@/lib/admin";
import { loadProfileExtras } from "@/lib/loaders/profile-extras";
import { loadPlayerTraitsCached } from "@/lib/loaders/player-traits-cache";
import { deckImage, stakeImage } from "@/lib/balatro-slugs";
import { getShowBmpMmr } from "@/lib/preferences";
import { loadPlayerHistory, type GamePlayed, type MatchEntry } from "@/lib/profile";
import { ProfileAnalyticsSection } from "@/components/ProfileAnalyticsSection";
import { tierColors, rarityIndex } from "@/lib/tier-colors";
import { RarityText } from "@/components/RarityText";
import {
  titleStickers,
  netLivesForGames,
  initialsFor,
  flattenMatchesNewestFirst,
} from "@/lib/profile-card-core";
import { SiteNav } from "@/components/SiteNav";
import { Callout } from "@/components/Callout";
import { DiscordId } from "@/components/DiscordId";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormSelect } from "@/components/FormSelect";
import { ReportForm } from "@/components/ReportForm";
import { MatchActionsPanel } from "@/components/MatchActionsPanel";
import { ConfirmButton } from "@/components/ConfirmButton";
import { DisputeForm } from "@/components/DisputeForm";
import { CANONICAL_DECKS, CANONICAL_STAKES } from "@/lib/balatro-info";
import { reportFromProfileAction, submitProfileDispute } from "@/app/profile/[id]/actions";
import { resetToDiscordNameAction, setCustomNameAction, setShowUsernameAction } from "@/app/me/actions";
import { dropPlayer, reinstatePlayer, movePlayer, setPlayerDiscordId } from "@/app/admin/players/actions";
import { TimezoneSetting } from "@/components/TimezoneSetting";
import { NextSeasonCard } from "@/components/NextSeasonCard";
import { SeasonWindow } from "@/components/SeasonWindow";
import { seasonCountdown } from "@/lib/season-countdown-core";
import { prisma } from "@/lib/prisma";
import { tourProfilePath, TOUR_PUBLIC_URL } from "@/lib/tour-profile";
import type { SeasonHistoryEntry } from "@/lib/profile";

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

// favRow/banRow/favBlock moved to ProfileAnalyticsSection (the deferred
// deck/stake/ban-stats section) alongside the data they render.

// The result pill's colors/label for one match -- shared by the v1 season
// table and the v2 "hand" cards so the two never drift. isVoid/isDisputed
// are passed in rather than recomputed here since both callers already
// derive them (isVoid from myGames/opponentGames, isDisputed from status).
function outcomeBadge(
  m: MatchEntry,
  isDisputed: boolean,
  isVoid: boolean,
): { bg: string; fg: string; label: string } {
  if (isDisputed) return { bg: "rgba(241,196,15,0.15)", fg: "var(--accent)", label: "DISPUTED" };
  if (isVoid) return { bg: "rgba(149,165,166,0.18)", fg: "var(--muted)", label: "V" };
  if (m.outcome === "WIN") return { bg: "rgba(46,204,113,0.15)", fg: "var(--success)", label: "W" };
  if (m.outcome === "LOSS") return { bg: "rgba(231,76,60,0.15)", fg: "var(--danger)", label: "L" };
  return { bg: "rgba(241,196,15,0.15)", fg: "var(--accent)", label: "D" };
}

// Unified profile view, rendered by BOTH /profile/[id] and /me (no redirect).
// It resolves the viewer itself (via auth) and branches the UI on the
// relationship: your own profile (settings + report form + next-season
// opt-ins), an admin (record / DQ tools), or anyone else (read-only + the
// "vs you" head-to-head).
// Expandable pick/ban history for a match: per game, the bans in the order they
// happened (who banned what) then the combo that got played. Native <details> so
// it needs no client JS, and the pool is already loaded (no extra request).
function picksBansDetails(games: GamePlayed[], opponentName: string) {
  const withPool = games.filter((g) => g.pool.length > 0);
  if (withPool.length === 0) return null;
  return (
    <details style={{ marginTop: 3 }}>
      <summary style={{ cursor: "pointer", fontSize: 10, color: "var(--accent-2-text)" }}>picks &amp; bans</summary>
      <div style={{ marginTop: 4, display: "grid", gap: 8 }}>
        {withPool.map((g) => {
          const bans = g.pool
            .filter((p) => p.banOrdinal != null)
            .sort((a, b) => (a.banOrdinal ?? 0) - (b.banOrdinal ?? 0));
          const picked = g.pool.find((p) => p.picked);
          return (
            <div key={g.num} style={{ fontSize: 11 }}>
              <div style={{ opacity: 0.55, marginBottom: 2 }}>Game {g.num} - pool of {g.pool.length}</div>
              {bans.map((b, i) => (
                <div key={i} style={{ color: "var(--danger)", opacity: 0.85 }}>
                  <span style={{ opacity: 0.6 }}>{b.banOrdinal}.</span> {b.deck}/{b.stake}
                  <span className="muted" style={{ marginLeft: 4 }}>
                    banned by {b.bannedByMe ? "you" : opponentName}
                  </span>
                </div>
              ))}
              {picked && (
                <div style={{ color: "var(--success)", marginTop: 2 }}>
                  Played: {picked.deck}/{picked.stake}
                  {g.lives != null && (
                    <span className="muted" style={{ marginLeft: 4 }}>
                      (winner had {g.lives} {g.lives === 1 ? "life" : "lives"})
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

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

  // v2 "Card Table" player card -- avatarUrl is read defensively since
  // another leaf is adding it to loadPlayerHistory's player selection in
  // parallel; until/unless it lands, this is always null and the hero falls
  // back to the initials circle below.
  const avatarUrl = (profile.player as { avatarUrl?: string | null }).avatarUrl ?? null;
  const heroInitials = initialsFor(profile.player.displayName);
  const titleStickerList = titleStickers(profile.history);
  const matchHands = flattenMatchesNewestFirst(profile.history);

  const viewerSession = await auth();
  const viewerDiscordId =
    (viewerSession?.user as { discordId?: string } | undefined)?.discordId ?? null;
  const viewerInGuild =
    (viewerSession?.user as { inGuild?: boolean } | undefined)?.inGuild === true;
  const showBmpMmr = await getShowBmpMmr();
  const isAdmin = await hasTier("ADMIN");
  const { viewer, bmpSeasonSnapshots, fallbackSnapshot, adminCtx, ownActiveDivision, adminDivisions } = await loadProfileExtras({
    profilePlayerId: profile.player.id,
    profileDiscordId: profile.player.discordId,
    viewerDiscordId,
    isViewerAdmin: isAdmin,
    showBmpMmr,
  });
  const isOwnProfile = viewer.isOwnProfile;
  const traits = await loadPlayerTraitsCached(profile.player.id);
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

  // Ban stats (most-banned decks/stakes) are a second full game-table scan —
  // deferred into ProfileAnalyticsSection, which fetches them only once the
  // "Your deck & stake stats" section is opened (see analytics-actions.ts).

  // Current-season standing. activeSeasonEntry covers a dropped member too (so the
  // admin reinstate control can show); activeSeason is the ACTIVE-only subset used
  // for the public "This season" block.
  const activeSeasonEntry = profile.history.find((h) => h.isActive);
  const activeSeason = activeSeasonEntry?.status === "ACTIVE" ? activeSeasonEntry : undefined;

  // v2 hero stat strip -- the active season's numbers when the player is
  // currently placed in a division; falls back to career totals (and net
  // lives across every recorded game) when they're not, so the strip is
  // never empty for a past or currently-unplaced player.
  const heroRarity = activeSeason ? rarityIndex(activeSeason.tierPosition) : undefined;
  const heroPoints = activeSeason ? activeSeason.points : t.points;
  const heroRecord = activeSeason
    ? { wins: activeSeason.wins, draws: activeSeason.draws, losses: activeSeason.losses }
    : { wins: t.wins, draws: t.draws, losses: t.losses };
  const heroGames = (activeSeason ? activeSeason.matches : profile.history.flatMap((h) => h.matches)).flatMap(
    (m) => m.games,
  );
  const heroNetLives = netLivesForGames(heroGames);

  // The league-wide active season's window/countdown, for the quick-actions
  // strip on your OWN profile (/me) -- independent of activeSeason above,
  // which only exists if you're currently placed in a division this season.
  const activeSeasonWindow = isOwnProfile
    ? await prisma.season.findFirst({
        where: { isActive: true },
        select: { startedAt: true, scheduledEndAt: true, endedAt: true },
      })
    : null;
  const activeSeasonCountdown = activeSeasonWindow
    ? seasonCountdown({
        startMs: activeSeasonWindow.startedAt.getTime(),
        scheduledEndMs: activeSeasonWindow.scheduledEndAt?.getTime() ?? null,
        endedMs: activeSeasonWindow.endedAt?.getTime() ?? null,
        nowMs: Date.now(),
      })
    : null;

  // Cross-link to this person's Team Tour profile, resolved server-side by Discord id (so the
  // raw id never lands in this page's source). Best-effort: null (no link) if the Tour is
  // unconfigured/unreachable or this person isn't in the Tour.
  const tourPath = await tourProfilePath(profile.player.discordId);

  return (
    <>
      <SiteNav activePath="" />
      <main>
        <p style={{ marginBottom: 4 }}>
          <Link href="/standings" className="muted" style={{ fontSize: 13 }}>← Standings</Link>
        </p>
        <h2 className="profile-header-v1">{profile.player.displayName}<DiscordId value={profile.player.discordId} username={profile.player.username} /></h2>
        {shownTimezone && (
          <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>🕐 {shownTimezone}</p>
        )}
        {tourPath && (
          <p style={{ fontSize: 13, marginTop: 2 }}>
            <a href={`${TOUR_PUBLIC_URL}${tourPath}`} className="link-action" style={{ color: "var(--accent-2-text)" }}>
              View on Team Tour ↗
            </a>
          </p>
        )}

        {/* v2 "Card Table" player card -- a Balatro-joker-style hero that
            replaces the plain name heading above under html[data-ui="v2"]
            (profile-header-v1 is hidden there; see app/v2/profile.css).
            Card border color = current-tier rarity, panel-edge when the
            player isn't currently placed in a division. */}
        <div className="profile-hero-v2">
          <div className="profile-hero-card" data-rarity={heroRarity}>
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="profile-hero-avatar" src={avatarUrl} alt="" width={72} height={72} />
            ) : (
              <div className="profile-hero-avatar-fallback" aria-hidden="true">{heroInitials}</div>
            )}
            <div className="profile-hero-name pixel">{profile.player.displayName}</div>
            <div className="profile-hero-handle">
              <DiscordId value={profile.player.discordId} username={profile.player.username} />
            </div>
            {activeSeason && (
              <span
                className="pill profile-hero-division"
                data-rarity={heroRarity}
                style={{ background: tierColors(activeSeason.tierPosition).bg, color: tierColors(activeSeason.tierPosition).fg }}
              >
                {activeSeason.divisionName}
              </span>
            )}
            <div className="profile-hero-stats">
              <div className="profile-hero-stat"><div className="label">Points</div><div className="value">{heroPoints}</div></div>
              <div className="profile-hero-stat"><div className="label">Record</div><div className="value">{heroRecord.wins}-{heroRecord.draws}-{heroRecord.losses}</div></div>
              <div className="profile-hero-stat"><div className="label">Net lives</div><div className="value">{heroNetLives > 0 ? `+${heroNetLives}` : heroNetLives}</div></div>
            </div>
            {titleStickerList.length > 0 && (
              <div className="profile-hero-stickers">
                {titleStickerList.map((s) => (
                  <span key={s.tierName} className="pill profile-sticker" data-rarity={s.rarity}>
                    {s.tierName} x{s.count}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {activeSeason && (
          <div className="card card-info" style={{ marginTop: 12 }}>
            <strong style={{ color: "var(--info)" }}>This season</strong>
            <div style={{ marginTop: 4 }}>
              In{" "}
              <Link href={`/divisions/${activeSeason.divisionId}`} style={{ color: "var(--text)", fontWeight: 600 }}>
                <RarityText position={activeSeason.tierPosition}>{activeSeason.divisionName}</RarityText>
              </Link>{" "}
              <span className="muted">(<RarityText position={activeSeason.tierPosition}>{activeSeason.tierName}</RarityText>)</span>
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "baseline" }}>
              <span>
                <strong style={{ fontSize: 18 }}>{activeSeason.rank > 0 ? `#${activeSeason.rank}` : "—"}</strong>{" "}
                <span className="muted">of {activeSeason.totalMembers}</span>
              </span>
              <span><strong>{activeSeason.points}</strong> <span className="muted">pts</span></span>
              <span>
                <span style={{ color: "var(--success)" }}>{activeSeason.wins}W</span>
                <span className="muted"> · {activeSeason.draws}D · </span>
                <span style={{ color: "var(--danger)" }}>{activeSeason.losses}L</span>
              </span>
              <span className="muted">{activeSeason.played} played</span>
            </div>
            {isOwnProfile && ownActiveDivision && ownActiveDivision.reportableOpponents.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                <strong>{ownActiveDivision.reportableOpponents.length}</strong>{" "}
                {ownActiveDivision.reportableOpponents.length === 1 ? "match" : "matches"} left to play —{" "}
                <Link href={`/divisions/${activeSeason.divisionId}`} style={{ color: "var(--info)" }}>see your matchups →</Link>
              </div>
            )}
          </div>
        )}

        {isOwnProfile && activeSeasonWindow && activeSeasonCountdown && (
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap", marginTop: 8 }}>
            <SeasonWindow start={activeSeasonWindow.startedAt} end={activeSeasonWindow.scheduledEndAt} />
            <span className="muted" style={{ fontSize: 12 }}>- {activeSeasonCountdown.label}</span>
          </div>
        )}

        {isAdmin && (
          <details className="card card-admin" style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", color: "var(--admin)", fontSize: 13, fontWeight: 700 }}>⚙ Admin · manage</summary>
            {activeSeasonEntry && (
              <div style={{ marginTop: 8 }}>
                {activeSeasonEntry.status === "ACTIVE" ? (
                  <>
                    <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
                      In <RarityText position={activeSeasonEntry.tierPosition}>{activeSeasonEntry.divisionName}</RarityText>. Drop if they&apos;ve left or gone inactive — unplayed matches are removed and opponents refilled.
                    </p>
                    <form action={dropPlayer}>
                      <input type="hidden" name="playerId" value={profile.player.id} />
                      <ConfirmButton message={`Drop ${profile.player.displayName} from ${activeSeasonEntry.divisionName}? Their unplayed matches are removed. You can reinstate them after.`} variant="secondary" style={{ fontSize: 12 }}>Drop from division</ConfirmButton>
                    </form>
                  </>
                ) : (
                  <>
                    <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
                      Dropped from <RarityText position={activeSeasonEntry.tierPosition}>{activeSeasonEntry.divisionName}</RarityText>. Reinstate to give them their schedule back.
                    </p>
                    <form action={reinstatePlayer}>
                      <input type="hidden" name="playerId" value={profile.player.id} />
                      <ConfirmButton message={`Reinstate ${profile.player.displayName} into ${activeSeasonEntry.divisionName}?`} variant="secondary" style={{ fontSize: 12 }}>Reinstate</ConfirmButton>
                    </form>
                  </>
                )}
              </div>
            )}
            {adminDivisions.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>Move to a division (or remove from the season):</p>
                <form action={movePlayer} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <input type="hidden" name="playerId" value={profile.player.id} />
                  <FormSelect
                    name="divisionId"
                    defaultValue={activeSeasonEntry?.divisionId ?? ""}
                    options={[{ value: "", label: "— remove from season —" }, ...adminDivisions.map((d) => ({ value: d.id, label: d.name }))]}
                  />
                  <ConfirmButton message={`Move ${profile.player.displayName} to the selected division (or remove from the season)?`} variant="secondary" style={{ fontSize: 12 }}>Apply</ConfirmButton>
                </form>
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>Discord ID (fix a wrong/typo&apos;d account):</p>
              <form action={setPlayerDiscordId} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <input type="hidden" name="playerId" value={profile.player.id} />
                <Input name="discordId" placeholder="17–20 digit Discord ID" defaultValue={profile.player.discordId} className="max-w-60" />
                <ConfirmButton message={`Change ${profile.player.displayName}'s Discord ID?`} variant="secondary" style={{ fontSize: 12 }}>Save ID</ConfirmButton>
              </form>
            </div>
          </details>
        )}

        {/* Career totals — one strip so the headline numbers (seasons, points,
            W/D/L) aren't scattered down the page. */}
        <div className="grid grid-3" style={{ marginTop: 12 }}>
          <div className="stat"><div className="label">Seasons</div><div className="value">{t.seasons}</div></div>
          <div className="stat"><div className="label">Total points</div><div className="value">{t.points}</div></div>
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
          <div className="muted" style={{ marginTop: 6, fontSize: 12 }} title="Game-level win rate.">
            Game win rate: <strong>{t.gameWinRatePct}%</strong> (across {t.totalGames} games)
          </div>
        )}

        {/* Fun traits derived from ban/pick behaviour — flavour only. */}
        {traits.length > 0 && (
          <div className="card" style={{ marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
              <strong style={{ fontSize: 13 }}>🎭 Traits</strong>
              <Link href="/traits" className="muted" style={{ fontSize: 12 }}>All traits</Link>
            </div>
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
            <strong>Report a match — <RarityText position={ownActiveDivision.tierPosition}>{ownActiveDivision.divisionName}</RarityText></strong>
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
            <h3 style={{ marginTop: 24, marginBottom: 8 }}>⚙ Your settings</h3>
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
                        <span className="pill" style={{ background: "rgba(118,199,255,0.15)", color: "var(--info)", fontSize: 11 }}>
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
                  <span className="pill" style={{ background: "rgba(118,199,255,0.15)", color: "var(--info)", fontSize: 11 }}>
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
              <span style={{ color: "var(--accent)" }}>⚙ Admin</span> — {profile.player.displayName}&apos;s matches in{" "}
              <strong><RarityText position={adminCtx.tierPosition}>{adminCtx.divisionName}</RarityText></strong>. Record, fix, void, or DQ any of them below.
            </p>
            <MatchActionsPanel
              divisionId={adminCtx.divisionId}
              returnTo={`/profile/${profile.player.id}`}
              decks={CANONICAL_DECKS.map((d) => d.name)}
              stakes={CANONICAL_STAKES.map((s) => s.name)}
              members={adminCtx.members}
              unplayed={adminCtx.unplayed}
              played={adminCtx.played}
            />
          </div>
        )}
        {disputeOk && (
          <Callout type="success">
            ✓ Dispute filed. A helper has been pinged in #results.
          </Callout>
        )}
        {disputeErr && (
          <Callout type="danger">
            {disputeErr}
          </Callout>
        )}

        {/* "Vs you" head-to-head — only when looking at someone else's
            profile and we have at least one match between us. */}
        {(() => {
          if (isOwnProfile || !viewer.playerId) return null;
          const h2h = profile.headToHeads.find(
            (h) => h.opponentPlayerId === viewer.playerId,
          );
          if (!h2h) return null;
          // headToHeads are stored from the PROFILE OWNER's perspective; this
          // card reads "from your (the viewer's) side", so invert W<->L and games.
          const yourWins = h2h.losses;
          const yourLosses = h2h.wins;
          const yourGamesWon = h2h.gamesLost;
          const yourGamesLost = h2h.gamesWon;
          const n = h2h.totalMatches;
          return (
            <div className="card card-info" style={{ marginTop: 16 }}>
              <strong style={{ color: "var(--info)" }}>vs you</strong>
              <p style={{ marginTop: 4, marginBottom: 0 }}>
                <strong>{yourWins}W</strong>
                {h2h.draws > 0 && <> &ndash; <strong>{h2h.draws}D</strong></>}
                {" "}&ndash; <strong>{yourLosses}L</strong>{" "}
                across {n} {n === 1 ? "match" : "matches"} (games {yourGamesWon}-{yourGamesLost}).{" "}
                <span className="muted" style={{ fontSize: 12 }}>From your side.</span>
              </p>
            </div>
          );
        })()}

        {/* Personal deck/stake analytics — collapsed so they don't bury the
            record above. These are YOUR numbers; league-wide stats live on
            /stats. Ban stats are fetched only once this section is opened
            (see ProfileAnalyticsSection) — deck/stake perf + favourites are
            already-loaded byproducts of the match history above, passed in
            directly. */}
        <ProfileAnalyticsSection
          playerId={profile.player.id}
          deckPerformance={profile.deckPerformance}
          stakePerformance={profile.stakePerformance}
          favorites={profile.favorites}
        />

        <h3 style={{ marginTop: 24 }}>Season history</h3>
        {profile.history.length === 0 ? (
          <div className="card muted profile-history-v1">No season history yet.</div>
        ) : (
          profile.history.map((h) => {
            const rankStr = h.rank > 0 ? `#${h.rank}/${h.totalMembers}` : "—";
            const color = tierColors(h.tierPosition);
            return (
              <div key={h.seasonId} className="card profile-history-v1">
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
                  <Link href={`/seasons/${h.seasonId}`} style={{ color: "var(--text)", fontWeight: 600, fontSize: 16 }}>
                    {h.seasonName}
                  </Link>
                  {h.isActive && <span className="pill" style={{ background: "rgba(46,204,113,0.15)", color: "var(--success)" }}>ACTIVE</span>}
                  <span className="pill" style={{ background: color.bg, color: color.fg }}>{h.tierName}</span>
                  <Link href={`/divisions/${h.divisionId}`} style={{ color: "var(--text)" }}>{h.divisionName}</Link>
                  {h.status === "DROPPED" && (
                    <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "var(--danger)" }}>DROPPED</span>
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
                                  ? "var(--success)"
                                  : h.finalGlobalRank > h.seedRank
                                  ? "var(--danger)"
                                  : "var(--muted)",
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
                        const outcomePill = outcomeBadge(m, isDisputed, isVoid);
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
                                              ? "var(--success)"
                                              : g.iWon === false
                                              ? "var(--danger)"
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
                              {picksBansDetails(m.games, m.opponentDisplayName)}
                            </td>
                            <td data-label="Result">
                              <span className="pill" style={{ background: outcomePill.bg, color: outcomePill.fg, fontSize: isDisputed ? 10 : undefined }}>{outcomePill.label}</span>
                              {m.uncounted && (
                                <div className="muted" style={{ fontSize: 10, marginTop: 2 }} title={m.uncounted.title}>
                                  {m.uncounted.label}
                                </div>
                              )}
                            </td>
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

        {/* v2 "Card Table" season-history grid -- a trophy-case summary per
            season (label, division chip, finish, points), replacing the
            per-season match tables above under html[data-ui="v2"]. The full
            match list moves to the flattened "Match history" below instead
            of staying nested per season. */}
        {profile.history.length === 0 ? (
          <div className="card muted profile-season-empty-v2">No season history yet.</div>
        ) : (
          <div className="profile-season-grid-v2">
            {profile.history.map((h) => {
              const won = h.rank === 1 && h.totalMembers > 0;
              const color = tierColors(h.tierPosition);
              return (
                <div
                  key={h.seasonId}
                  className="card profile-season-card-v2"
                  data-won={won ? "true" : undefined}
                >
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <Link href={`/seasons/${h.seasonId}`} style={{ color: "var(--text)", fontWeight: 600, fontSize: 14 }}>
                      {h.seasonName}
                    </Link>
                    <span
                      className="pill"
                      data-rarity={rarityIndex(h.tierPosition)}
                      style={{ background: color.bg, color: color.fg }}
                    >
                      {h.divisionName}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    {h.rank > 0 ? `#${h.rank} of ${h.totalMembers}` : "unranked"}
                  </div>
                  <div className="profile-season-points" style={{ marginTop: 4 }}>{h.points} pts</div>
                </div>
              );
            })}
          </div>
        )}

        {/* v2 "Card Table" match history -- every match across every season,
            newest first, as a "hand": two mini cards (this player vs the
            opponent) with the score between them. Keeps every v1 action/
            data point (dispute form, uncounted tag, pick/ban details,
            shootout marker, disputed/void styling) alongside the new look. */}
        <div className="profile-match-hands-v2">
          <h3>Match history</h3>
          {matchHands.length === 0 ? (
            <div className="card muted">No matches played yet.</div>
          ) : (
            matchHands.map((hand) => {
              const m = hand.match;
              const isDisputed = m.status === "DISPUTED";
              const isShootout = m.isShootout === true;
              const isVoid = m.myGames === 0 && m.opponentGames === 0;
              const badge = outcomeBadge(m, isDisputed, isVoid);
              const date = m.confirmedAt ? m.confirmedAt.toISOString().slice(0, 10) : "-";
              // One chip row per game: a match is two games with different
              // deck/stake combos, and players want to see both.
              const comboGames = m.games.filter((g) => g.deck && g.stake);
              return (
                <div
                  key={m.pairingId}
                  className="card profile-hand-v2"
                  data-outcome={m.outcome.toLowerCase()}
                  style={isDisputed ? { opacity: 0.75 } : undefined}
                >
                  <div className="muted" style={{ fontSize: 11 }}>
                    {date} - {hand.context.seasonName} - <RarityText position={hand.context.tierPosition}>{hand.context.divisionName}</RarityText>
                    {isShootout && <span style={{ marginLeft: 6 }}>(shootout)</span>}
                  </div>
                  <div className="profile-hand-players">
                    <div className="profile-hand-mini-card">
                      <div className="profile-hand-mini-name">{profile.player.displayName}</div>
                    </div>
                    <div className="profile-hand-vs">vs</div>
                    <div className="profile-hand-mini-card">
                      <div className="profile-hand-mini-name">
                        <Link href={`/profile/${m.opponentPlayerId}`} style={{ color: "inherit" }}>
                          {m.opponentDisplayName}
                        </Link>
                      </div>
                    </div>
                  </div>
                  <div className="profile-hand-score" style={{ textAlign: "center" }}>
                    {m.myGames}-{m.opponentGames}
                  </div>
                  {comboGames.length > 0 && (
                    <div className="profile-hand-chips">
                      {comboGames.map((g) => (
                        <span
                          key={g.num}
                          className="profile-hand-combo"
                          data-result={g.iWon === null ? "none" : g.iWon ? "won" : "lost"}
                          title={`Game ${g.num}: ${g.deck} / ${g.stake}${g.iWon === null ? "" : g.iWon ? " (won)" : " (lost)"}`}
                        >
                          <span className="profile-hand-combo-num">G{g.num}</span>
                          <span className="profile-hand-chip">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={deckImage(g.deck!)} alt="" width={14} height={14} style={{ borderRadius: 2 }} />
                            {g.deck}
                          </span>
                          <span className="profile-hand-chip">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={stakeImage(g.stake!)} alt="" width={14} height={14} style={{ borderRadius: 2 }} />
                            {g.stake}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="profile-hand-meta">
                    <span className="pill" style={{ background: badge.bg, color: badge.fg, fontSize: isDisputed ? 10 : undefined }}>
                      {badge.label}
                    </span>
                    {m.uncounted && <span title={m.uncounted.title}>{m.uncounted.label}</span>}
                    {picksBansDetails(m.games, m.opponentDisplayName)}
                    {isOwnProfile && hand.context.isActiveSeason && !isShootout && (
                      <DisputeForm
                        action={submitProfileDispute}
                        pairingId={m.pairingId}
                        opponentName={m.opponentDisplayName}
                        isDisputed={isDisputed}
                        hiddenFields={{ profileId: profile.player.id }}
                      />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
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


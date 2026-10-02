"use client";

// Collapsed "Your deck & stake stats" section on /profile/[id] and /me.
// deckPerformance/stakePerformance/favorites are already computed for free as
// a byproduct of the match-history query the page always runs (see
// lib/profile.ts's loadPlayerHistory) — passed in as plain props, no extra
// query. Ban stats (loadPlayerBanStats) are a SEPARATE full scan of every
// confirmed game's pick/ban pool, so that one is fetched on demand, the first
// time this <details> is opened, via loadDeckStakeAnalyticsAction.

import { useState, useTransition } from "react";
import { deckImage, stakeImage } from "@/lib/balatro-slugs";
import { loadDeckStakeAnalyticsAction } from "@/app/profile/[id]/analytics-actions";
import type { PerComboPerformance, Favorites, FavoriteEntry, PlayerBanStats, BanStatEntry } from "@/lib/profile";

// One "favourite" row — deck and/or stake thumbnail + name + a count
// (× plays, or W for wins). Combos carry "Deck · Stake" so we split + show both.
function favRow(r: FavoriteEntry, kind: "deck" | "stake" | "combo", metric: "played" | "won") {
  const [deckName, stakeName] = kind === "combo" ? r.name.split(" · ") : [r.name, r.name];
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
          color: winRate >= 50 ? "var(--success)" : "var(--danger)",
        }}
      >
        {winRate}%
      </span>
    </li>
  );
}

// One "most-banned" row: icon, name, ban rate (how often this player bans it
// when it appears) + the bans/appearances record.
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
      <span style={{ whiteSpace: "nowrap", fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right", color: "var(--admin)" }}>
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

export function ProfileAnalyticsSection({
  playerId,
  deckPerformance,
  stakePerformance,
  favorites,
}: {
  playerId: string;
  deckPerformance: PerComboPerformance[];
  stakePerformance: PerComboPerformance[];
  favorites: Favorites;
}) {
  const [banStats, setBanStats] = useState<PlayerBanStats | null>(null);
  const [isPending, startTransition] = useTransition();

  const qualifyingDecks = deckPerformance.filter((d) => d.gamesTotal >= 5);
  const qualifyingStakes = stakePerformance.filter((s) => s.gamesTotal >= 5);
  // Ban stats aren't known until the section opens, so visibility is decided
  // from the data we already have (deck perf / favourites) rather than
  // waiting on a query just to answer "is there anything to show". A player
  // with zero deck/stake data has, in practice, zero ban data too (both come
  // from the same per-game pick/ban pool rows).
  const hasAnythingToShow =
    qualifyingDecks.length > 0 || favorites.mostPlayed.decks.length > 0;

  if (!hasAnythingToShow) return null;

  const handleToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || banStats !== null || isPending) return;
    startTransition(async () => {
      const result = await loadDeckStakeAnalyticsAction(playerId);
      setBanStats(result);
    });
  };

  return (
    <details className="card" style={{ marginTop: 16 }} onToggle={handleToggle}>
      <summary style={{ cursor: "pointer" }}>
        <strong>Your deck &amp; stake stats</strong>
      </summary>

      {qualifyingDecks.length > 0 && (
        <div className="grid grid-2" style={{ marginTop: 16 }}>
          <div className="card">
            <strong>Deck performance</strong>
            <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
              Per deck. Min 5 games.
            </p>
            <table className="table-dense" style={{ width: "100%", fontSize: 12 }}>
              <tbody>
                {qualifyingDecks.slice(0, 10).map((d) => (
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
                      <strong style={{ color: d.winRatePct >= 50 ? "var(--success)" : "var(--danger)" }}>
                        {d.winRatePct}%
                      </strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {qualifyingStakes.length > 0 && (
            <div className="card">
              <strong>Stake performance</strong>
              <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
                Per stake. Min 5 games.
              </p>
              <table className="table-dense" style={{ width: "100%", fontSize: 12 }}>
                <tbody>
                  {qualifyingStakes.map((s) => (
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
                        <strong style={{ color: s.winRatePct >= 50 ? "var(--success)" : "var(--danger)" }}>
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

      {favorites.mostPlayed.decks.length > 0 && (
        <div className="grid grid-2" style={{ marginTop: 16 }}>
          <div className="card">
            <strong>⭐ Most played</strong>
            <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
              By games played.
            </p>
            {favBlock("Decks", favorites.mostPlayed.decks, "deck", "played")}
            {favBlock("Stakes", favorites.mostPlayed.stakes, "stake", "played")}
            {favBlock("Combos", favorites.mostPlayed.combos, "combo", "played")}
          </div>
          <div className="card">
            <strong>🏆 Most won</strong>
            <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
              By games won.
            </p>
            {favBlock("Decks", favorites.mostWon.decks, "deck", "won")}
            {favBlock("Stakes", favorites.mostWon.stakes, "stake", "won")}
            {favBlock("Combos", favorites.mostWon.combos, "combo", "won")}
          </div>
        </div>
      )}

      {banStats === null ? (
        isPending && (
          <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
            Loading ban stats…
          </p>
        )
      ) : (
        (banStats.decks.length > 0 || banStats.stakes.length > 0) && (
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
        )
      )}
    </details>
  );
}

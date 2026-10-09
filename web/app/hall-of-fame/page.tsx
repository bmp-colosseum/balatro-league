// /hall-of-fame — the champions of every completed season. Public, anyone can view.

import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import { loadHallOfFame, type HofMatch, type HofSeason, type HofDivisionChampion } from "@/lib/loaders/hall-of-fame";
import { rarityIndex } from "@/lib/tier-colors";
import { RarityText } from "@/components/RarityText";
import { CardAvatar } from "@/components/DivisionStandingsTable";

export const dynamic = "force-dynamic";

function endedLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", timeZone: "UTC" });
}

const OUTCOME: Record<HofMatch["outcome"], { tag: string; color: string }> = {
  win: { tag: "W", color: "var(--success)" },
  loss: { tag: "L", color: "var(--danger)" },
  draw: { tag: "D", color: "var(--muted)" },
  void: { tag: "–", color: "var(--muted)" },
};

export default async function HallOfFamePage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const [seasons, sp] = await Promise.all([loadHallOfFame(), searchParams]);
  // Legendary champions only by default; ?all=1 shows every division's winner.
  const showAll = sp.all === "1";
  const withChampions = seasons.filter((s) => s.champion);

  return (
    <>
      <SiteNav activePath="/hall-of-fame" />
      <main>
        {/* v1: unchanged -- hidden only when the v2 preview cookie sets
            html[data-ui="v2"] (app/globals.css). See the v2 trophy shelf
            below for the "Card Table" redesign of this same data. */}
        <div className="hof-v1">
          <h2>🏆 Hall of Fame</h2>
          <p className="muted" style={{ marginTop: -4, marginBottom: 16 }}>
            The top division&apos;s winner is the league champion.
          </p>

          {withChampions.length === 0 ? (
            <div className="card muted">
              No champions yet — the first season&apos;s winners will be enshrined here the moment it ends. Check back!
            </div>
          ) : (
            <div className="grid grid-2">
              {withChampions.map((s) => {
                const champ = s.champion!;
                return (
                  <section key={s.seasonId} className="card card-accent" style={{ marginBottom: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                      <strong className="pixel" style={{ fontSize: 18 }}>{s.seasonLabel}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>Ended {endedLabel(s.endedAt)}</span>
                    </div>

                    {/* Champion */}
                    <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 32 }}>🏆</span>
                      <div>
                        <div style={{ fontSize: 20, fontWeight: 700 }}>
                          <Link href={`/profile/${champ.playerId}`} prefetch={false} style={{ color: "var(--accent)", textDecoration: "none" }}>
                            {champ.playerName}
                          </Link>
                        </div>
                        <div className="muted" style={{ fontSize: 13 }}>
                          Champion · <RarityText position={champ.tierPosition}>{champ.divisionName}</RarityText> · <strong>{champ.record}</strong> (W-L-D) · {champ.points} pts
                        </div>
                      </div>
                    </div>

                    {/* Champion's match log */}
                    {s.championMatches.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                          Road to the title
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {s.championMatches.map((m) => {
                            const o = OUTCOME[m.outcome];
                            return (
                              <div key={m.opponentId} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                                <span style={{ width: 18, fontWeight: 700, color: o.color }}>{o.tag}</span>
                                <span style={{ width: 56, fontVariantNumeric: "tabular-nums" }}>{m.myGames}-{m.oppGames}</span>
                                <span className="muted">vs</span>
                                <Link href={`/profile/${m.opponentId}`} prefetch={false} style={{ color: "var(--text)" }}>{m.opponentName}</Link>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>

        {/* v2 "Card Table": the Hall of Fame as a trophy shelf, one shelf per
            season. Same data as the v1 block above, just always rendered and
            toggled by CSS (app/v2/hall-of-fame.css) so v1 never sees it. */}
        <div className="hof-v2">
          <HallOfFameTrophyShelf seasons={withChampions} showAll={showAll} />
        </div>
      </main>
    </>
  );
}

// Trophy shelf: one felt-deep band per season carrying its label/dates, with
// that season's champion(s) as cards standing on the shelf line beneath it.
function HallOfFameTrophyShelf({ seasons: allSeasons, showAll }: { seasons: HofSeason[]; showAll: boolean }) {
  // Default view: the Legendary (top-tier) champion per season only. Every
  // division's winner is a lot of cards; "All divisions" opts into them.
  const seasons = showAll
    ? allSeasons
    : allSeasons.map((s) => ({ ...s, divisionChampions: s.divisionChampions.filter((c) => rarityIndex(c.tierPosition) === 0) }));
  if (seasons.length === 0) {
    return (
      <div className="card muted hof-empty">
        No champions yet -- the first season&apos;s winners will be enshrined here the moment it ends. Check back!
      </div>
    );
  }

  const allDivisionChampions = seasons.flatMap((s) => s.divisionChampions);
  const titleCount = allDivisionChampions.length;
  const distinctChampions = new Set(allDivisionChampions.map((c) => c.playerId)).size;

  return (
    <>
      <div className="hof-header">
        <h2 className="pixel hof-title">Hall of Fame</h2>
        <p className="muted hof-count">
          {seasons.length} season{seasons.length === 1 ? "" : "s"}, {titleCount} {showAll ? "division" : "Legendary"} title
          {titleCount === 1 ? "" : "s"}, {distinctChampions} champion{distinctChampions === 1 ? "" : "s"}
        </p>
        <nav className="hof-toggle" aria-label="Which champions to show">
          <Link href="/hall-of-fame" className="tier-tab" data-rarity={0} data-active={!showAll} aria-current={!showAll ? "page" : undefined}>
            Legendary champions
          </Link>
          <Link href="/hall-of-fame?all=1" className="tier-tab hof-toggle-all" data-active={showAll} aria-current={showAll ? "page" : undefined}>
            All divisions
          </Link>
        </nav>
      </div>

      {showAll ? (
        <div className="hof-shelves">
          {seasons.map((s) => (
            <HallOfFameShelf key={s.seasonId} season={s} />
          ))}
        </div>
      ) : (
        <HallOfFameChampionGrid seasons={seasons} />
      )}
    </>
  );
}

// Legendary-only default view: one flat grid of every season's Legendary
// champion, newest season first (the loader already orders seasons that
// way), instead of one near-empty one-card shelf per season. Each card
// carries its season label (in place of the division name the All-divisions
// cards show -- every card here IS the Legendary division already) plus the
// champion's avatar and the same x2/x3 title sticker.
function HallOfFameChampionGrid({ seasons }: { seasons: HofSeason[] }) {
  const champions = seasons
    .map((s) => (s.divisionChampions[0] ? { season: s, champ: s.divisionChampions[0] } : null))
    .filter((e): e is { season: HofSeason; champ: HofDivisionChampion } => e !== null);

  if (champions.length === 0) {
    return (
      <div className="card muted hof-empty">
        No champions yet -- the first season&apos;s winners will be enshrined here the moment it ends. Check back!
      </div>
    );
  }

  return (
    <div className="hof-champ-grid">
      {champions.map(({ season, champ }, i) => (
        <HallOfFameChampionCard key={champ.playerId + season.seasonId} season={season} champion={champ} index={i} />
      ))}
    </div>
  );
}

function HallOfFameChampionCard({
  season,
  champion: champ,
  index,
}: {
  season: HofSeason;
  champion: HofDivisionChampion;
  index: number;
}) {
  // Always data-rarity=0 (Legendary) -- every card in this grid is that
  // season's top-division champion -- which reuses .hof-card's gold border
  // and glow from app/v2/hall-of-fame.css. Animation delay is set inline
  // (capped the same way as the nth-child stagger below .hof-shelf-row)
  // since these cards sit directly in .hof-champ-grid, not .hof-shelf-row.
  return (
    <Link
      href={`/profile/${champ.playerId}`}
      prefetch={false}
      className="hof-card hof-champ-card"
      data-rarity={0}
      style={{ animationDelay: `${Math.min(index, 11) * 25}ms` }}
    >
      <HofTrophyIcon />
      {champ.titleCount >= 2 && <span className="hof-card-sticker">x{champ.titleCount}</span>}
      <div className="pixel hof-card-division" data-rarity={0}>
        {season.seasonLabel}
      </div>
      <CardAvatar displayName={champ.playerName} avatarUrl={champ.avatarUrl} />
      <div className="hof-card-name">{champ.playerName}</div>
    </Link>
  );
}

function HallOfFameShelf({ season: s }: { season: HofSeason }) {
  return (
    <section className="hof-shelf">
      <div className="hof-shelf-band">
        <strong className="pixel hof-shelf-label">{s.seasonLabel}</strong>
        <span className="hof-shelf-dates">Ended {endedLabel(s.endedAt)}</span>
      </div>
      <div className="hof-shelf-deck">
        {/* One card per division champion, ladder order (tierPosition asc,
            then group number asc, from the loader) -- the Legendary/top-tier
            champion lands first and renders larger via data-rarity="0" (see
            app/v2/hall-of-fame.css). Wraps onto multiple shelf rows as needed;
            the deck's repeating background keeps a shelf line under every
            wrapped row, not just the last one. */}
        <div className="hof-shelf-row">
          {s.divisionChampions.map((champ) => (
            <HallOfFameCard key={champ.playerId + champ.divisionName} champion={champ} />
          ))}
        </div>
      </div>
    </section>
  );
}

function HallOfFameCard({ champion: champ }: { champion: HofDivisionChampion }) {
  const rarity = rarityIndex(champ.tierPosition);
  return (
    <Link href={`/profile/${champ.playerId}`} prefetch={false} className="hof-card" data-rarity={rarity}>
      <HofTrophyIcon />
      {champ.titleCount >= 2 && <span className="hof-card-sticker">x{champ.titleCount}</span>}
      <div className="pixel hof-card-division" data-rarity={rarity}>
        {champ.divisionName}
      </div>
      <div className="hof-card-name">{champ.playerName}</div>
    </Link>
  );
}

// Single-path gold trophy glyph -- see design-system/MASTER.md ("no emoji as
// icons in the UI; use inline SVG"). One <path> element (several subpaths:
// the cup/stem/base silhouette plus its two handles) instead of a multi-path
// icon set, per the trophy-shelf spec.
function HofTrophyIcon() {
  return (
    <svg
      className="hof-card-trophy"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="var(--gold)"
        d="M7 3h10v2h2a1 1 0 0 1 1 1v2a4 4 0 0 1-4 4.9A6 6 0 0 1 13 16.74V19h2a1 1 0 0 1 1 1v1H8v-1a1 1 0 0 1 1-1h2v-2.26A6 6 0 0 1 4 12.9 4 4 0 0 1 4 9V6a1 1 0 0 1 1-1h2V3Z
           M5 7v2a2 2 0 0 0 2 2 8 8 0 0 1-1-4H5Z
           M19 7h-1a8 8 0 0 1-1 4 2 2 0 0 0 2-2V7Z"
      />
    </svg>
  );
}

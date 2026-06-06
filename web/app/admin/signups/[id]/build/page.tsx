import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadBuildSeasonPage } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { TierEditor } from "@/components/TierEditor";
import { DraggableRatingTable, type RatingRow } from "@/components/DraggableRatingTable";
import { addSignupByDiscordId, addSignupByPlayerId, autoFillRatingsFromMmr, buildSeason, refreshSignupMmrSnapshots, saveRatings } from "./actions";
import { PlayerSearch } from "@/components/PlayerSearch";
import { nextSeasonNumber } from "@/lib/format-season";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function BuildSeasonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { err } = await searchParams;

  const result = await loadBuildSeasonPage(id);
  if (result === "NOT_FOUND") notFound();
  if (result === "BUILT_REDIRECT") redirect(`/admin/seasons`);
  const {
    round,
    sortedSignups,
    playerByDiscordId,
    snapshotByDiscordId,
    priorByPlayerId,
    skippedByPlayerId,
    templates,
    initialTiers,
    presets,
    totalSlots,
    playerCount,
  } = result;
  const nextNumber = await nextSeasonNumber(prisma);
  // Existing players for the "add by name" search picker.
  const allPlayers = await prisma.player.findMany({
    select: { id: true, displayName: true },
    orderBy: { displayName: "asc" },
  });

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Build season from "{round.name}"</h2>
          <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "#2ecc71" }}>
            {playerCount} signups
          </span>
          <Link href="/admin/seasons" className="muted" style={{ marginLeft: "auto" }}>
            ← Back to seasons
          </Link>
        </div>
        <p className="muted">
          Set ratings for everyone (returning + new), pick the tier shape and match preset, and
          click <strong>Build season</strong>. Auto-seed fills divisions in rank order — top of
          each tier goes into the lowest-numbered division (Rare 1 = strongest Rare, Rare 6 = weakest).
        </p>

        <details className="card" style={{ background: "rgba(118,199,255,0.06)", borderColor: "#76c7ff" }}>
          <summary style={{ cursor: "pointer" }}><strong style={{ color: "#76c7ff" }}>ℹ️ How this works — full season-build flow</strong></summary>
          <ol style={{ marginTop: 8, paddingLeft: 24, fontSize: 13, lineHeight: 1.6 }}>
            <li><strong>Set ratings</strong> below — drag rows to reorder, or use the sort/auto-fill buttons. Top of the list = strongest player, ratings get re-numbered on Save.</li>
            <li><strong>Pick the tier shape</strong> (Legendary / Rare / Uncommon / Common…) — use ✨ Suggest from N signups to auto-compute, or load a saved template.</li>
            <li><strong>Click Build season</strong> — auto-seeds top-rated players into the top tier and fills each tier's divisions in rank order (Rare 1 gets the top Rare ranks, Rare 6 gets the bottom). Keeps entering rank close to ending rank so ranks don't shuffle wildly between seasons.</li>
            <li><strong>Review &amp; tweak placements</strong> on the season detail page that opens — use the per-player "Move to…" dropdowns to nudge anyone between divisions.</li>
            <li><strong>Start the season</strong> — when placements look right, click <strong>Start season →</strong> at the bottom of the season detail page. The league goes live, players see standings, /start-match works.</li>
          </ol>
          <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            Returning players' ratings come from end-of-last-season's recompute, so good finishers naturally
            land in higher tiers and bottom finishers drop down. New signups fall in by BMP MMR.
          </p>
        </details>

        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        <div className="card">
          <strong>Add player by Discord ID</strong>
          <p className="muted">
            For late additions — bot looks up the member's guild display name; you can
            override before adding. The player will appear in the list below and be
            included when you Build season.
          </p>
          <form action={addSignupByDiscordId} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input type="hidden" name="roundId" value={round.id} />
            <input
              type="text"
              name="discordId"
              placeholder="Discord ID (17-20 digits)"
              required
              pattern="\d{17,20}"
              style={{ flex: "1 1 200px" }}
            />
            <input
              type="text"
              name="displayName"
              placeholder="Display name override (optional)"
              style={{ flex: "1 1 200px" }}
            />
            <button type="submit">Look up & add</button>
          </form>
          {allPlayers.length > 0 && (
            <form action={addSignupByPlayerId} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <input type="hidden" name="roundId" value={round.id} />
              <PlayerSearch players={allPlayers} name="playerId" placeholder="…or add an existing player by name" />
              <button type="submit" className="secondary">Add</button>
            </form>
          )}
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <strong>Player ratings ({playerCount} signed up)</strong>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <form action={autoFillRatingsFromMmr}>
                <input type="hidden" name="roundId" value={round.id} />
                <button type="submit" className="secondary" style={{ fontSize: 12 }} title="Sets rating = BMP MMR only for players who don't already have a rating. Leaves returners' league ratings alone.">
                  Fill missing ratings from BMP MMR
                </button>
              </form>
              <form action={refreshSignupMmrSnapshots}>
                <input type="hidden" name="roundId" value={round.id} />
                <button type="submit" className="secondary" style={{ fontSize: 12 }}>
                  Refresh BMP MMRs
                </button>
              </form>
            </div>
          </div>
          <p className="muted">
            Smart initial order: returners (with a league rating) first, ranked by their rating;
            then new players, ranked by BMP MMR. Drag rows to fine-tune, then Save &amp; lock —
            the final order becomes each player's rating.
          </p>
          {(() => {
            const ratingRows: RatingRow[] = sortedSignups.map((s) => {
              const player = playerByDiscordId.get(s.discordId);
              const prior = player ? priorByPlayerId.get(player.id) : undefined;
              const skipped = player ? skippedByPlayerId.get(player.id) ?? 0 : 0;
              const snapshot = snapshotByDiscordId.get(s.discordId);
              return {
                discordId: s.discordId,
                displayName: s.displayName,
                playerId: player?.id,
                status: !prior ? "NEW" : skipped >= 1 ? "GAP" : "RETURNING",
                skippedSeasons: skipped,
                prior: prior
                  ? {
                      divisionName: prior.divisionName,
                      tierName: prior.tierName,
                      rank: prior.rank,
                      totalMembers: prior.totalMembers,
                      seasonName: prior.seasonName,
                      finalGlobalRank: prior.finalGlobalRank,
                    }
                  : undefined,
                leagueRating: player?.rating ?? null,
                bmpMmr: snapshot?.rankedMmr ?? null,
                bmpTier: snapshot?.rankedTier ?? null,
                bmpTotalGames: snapshot?.totalGames ?? null,
                bmpWinRatePct: snapshot?.winRatePct ?? null,
                bmpFetchError: snapshot?.fetchError ?? null,
              };
            });
            // Remount-key derived from the data so the client component
            // resets its internal drag state whenever the server pushes
            // new ratings (e.g. after auto-fill / overwrite from BMP MMR).
            // Otherwise useState(initial) keeps the stale drag order even
            // though the server-rendered prop has changed.
            const remountKey = ratingRows
              .map((r) => `${r.discordId}:${r.leagueRating ?? "x"}:${r.bmpMmr ?? "x"}`)
              .join("|");
            return <DraggableRatingTable key={remountKey} initial={ratingRows} formAction={saveRatings} roundId={round.id} />;
          })()}
        </div>

        <div className="card">
          <strong>Season setup</strong>
          <p className="muted">
            {playerCount} signups · default tier layout = {totalSlots} slots. If signups exceed
            slots, the bottom tier absorbs the overflow.
          </p>
          <form action={buildSeason}>
            <input type="hidden" name="roundId" value={round.id} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label>
                Subtitle (optional) — will create <strong>Season {nextNumber}</strong>
                <input name="subtitle" placeholder="Optional subtitle (e.g. 'Launch')" style={{ width: "100%" }} />
              </label>
              <label>
                Group size
                <input name="targetGroupSize" type="number" min={2} max={20} defaultValue={5} style={{ width: "100%" }} />
              </label>
              <label>
                Min group
                <input name="minGroupSize" type="number" min={2} max={20} defaultValue={3} style={{ width: "100%" }} />
              </label>
              <label>
                Deck preset
                <select name="matchConfigPresetId" defaultValue="" style={{ width: "100%" }}>
                  <option value="">— Use Default —</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <strong>Tier layout</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  Pre-filled with your last-used layout (★)
                </span>
                <Link href="/admin/seasons/templates" style={{ marginLeft: "auto" }}>
                  <button type="button" className="secondary">Manage templates</button>
                </Link>
              </div>
              <TierEditor initial={initialTiers} templates={templates} signupCount={sortedSignups.length} />
            </div>

            <button type="submit" style={{ marginTop: 16 }}>
              Build season + place {playerCount} players
            </button>
          </form>
        </div>
      </main>
    </>
  );
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadBuildSeasonPage } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormSelect } from "@/components/FormSelect";
import { AdminNav } from "@/components/AdminNav";
import { TierEditor } from "@/components/TierEditor";
import { DraggableRatingTable, type RatingRow } from "@/components/DraggableRatingTable";
import { addSignupByDiscordId, addSignupByPlayerId, autoFillRatingsFromMmr, buildSeason, refreshSignupMmrSnapshots, saveRatings } from "./actions";
import { PlayerSearch } from "@/components/PlayerSearch";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";
import { loadAllPlayersForPicker } from "@/lib/loaders/players";
import { loadExistingSeasonForBuild, loadNextSeasonNumber } from "@/lib/loaders/admin-build";

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
  const nextNumber = await loadNextSeasonNumber();
  // If this round was opened from an EXISTING season, build into that one —
  // show its real number/name instead of "create Season <next>".
  const existingSeason = round.resultingSeasonId
    ? await loadExistingSeasonForBuild(round.resultingSeasonId)
    : null;
  // Existing players for the "add by name" search picker.
  const allPlayers = await loadAllPlayersForPicker();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Set up the season — "{round.name}"</h2>
          <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "#2ecc71" }}>
            {playerCount} signups
          </span>
          <Link href={`/admin/signups/${round.id}/preview`} style={{ marginLeft: "auto" }}>
            🔬 Preview placement →
          </Link>
          <Link href="/admin/seasons" className="muted">
            ← Back to seasons
          </Link>
        </div>
        <p className="muted">
          Set ratings for everyone (returning and new), pick the tier shape and match preset, then
          click <strong>Set up the season</strong>. Players sort into divisions in rank order — the top of
          each tier goes into the lowest-numbered division (Rare 1 = strongest Rare, Rare 6 = weakest).
        </p>

        <details className="card" style={{ background: "rgba(118,199,255,0.06)", borderColor: "#76c7ff" }}>
          <summary style={{ cursor: "pointer" }}><strong style={{ color: "#76c7ff" }}>ℹ️ How this works — setting up the season</strong></summary>
          <ol style={{ marginTop: 8, paddingLeft: 24, fontSize: 13, lineHeight: 1.6 }}>
            <li><strong>Set ratings</strong> below — drag rows to reorder, or use the sort/auto-fill buttons. Top of the list = strongest player, ratings get re-numbered on Save.</li>
            <li><strong>Pick the tier shape</strong> (Legendary / Rare / Uncommon / Common…) — use ✨ Suggest from N signups to auto-compute, or load a saved template.</li>
            <li><strong>Click Set up the season</strong> — sorts top-rated players into the top tier and fills each tier's divisions in rank order (Rare 1 gets the top Rare ranks, Rare 6 the bottom). Keeps each player's starting rank close to where they finished, so ranks don't shuffle wildly between seasons.</li>
            <li><strong>Review &amp; tweak placements</strong> on the season detail page that opens — use the per-player "Move to…" dropdowns to nudge anyone between divisions.</li>
            <li><strong>Start the season</strong> — when placements look right, click <strong>Start season →</strong> at the bottom of the season detail page. The league goes live, players see standings, /start-match works.</li>
          </ol>
          <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            Returning players' ratings come from how they finished last season, so strong finishers land
            in higher tiers and bottom finishers drop down. New signups fall in by their BMP MMR.
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
            included when you set up the season.
          </p>
          <form action={addSignupByDiscordId} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input type="hidden" name="roundId" value={round.id} />
            <Input
              type="text"
              name="discordId"
              placeholder="Discord ID (17-20 digits)"
              required
              pattern="\d{17,20}"
              style={{ flex: "1 1 200px" }}
            />
            <Input
              type="text"
              name="displayName"
              placeholder="Display name override (optional)"
              style={{ flex: "1 1 200px" }}
            />
            <Button type="submit">Look up & add</Button>
          </form>
          {allPlayers.length > 0 && (
            <form action={addSignupByPlayerId} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <input type="hidden" name="roundId" value={round.id} />
              <PlayerSearch players={allPlayers} name="playerId" placeholder="…or add an existing player by name" />
              <Button type="submit" variant="secondary">Add</Button>
            </form>
          )}
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <strong>Player ratings ({playerCount} signed up)</strong>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <form action={autoFillRatingsFromMmr}>
                <input type="hidden" name="roundId" value={round.id} />
                <Button type="submit" variant="secondary" size="sm" title="Sets rating = BMP MMR only for players who don't already have a rating. Leaves returners' league ratings alone.">
                  Fill missing ratings from BMP MMR
                </Button>
              </form>
              <form action={refreshSignupMmrSnapshots}>
                <input type="hidden" name="roundId" value={round.id} />
                <Button type="submit" variant="secondary" size="sm">
                  Refresh BMP MMRs
                </Button>
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
          {existingSeason && (
            <div
              className="card"
              style={{ borderColor: "#f1c40f", color: "#f1c40f", marginBottom: 12 }}
            >
              ⚠ <strong>Redoing Season {existingSeason.number}&apos;s setup.</strong> This replaces its current
              divisions and player placements with the layout below. Don&apos;t redo setup for a season that&apos;s
              already in progress — recorded results in those divisions can be lost.
            </div>
          )}
          <form action={buildSeason}>
            <input type="hidden" name="roundId" value={round.id} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label>
                {existingSeason ? (
                  <>Subtitle — setting up <strong>Season {existingSeason.number}</strong> (edit to rename)</>
                ) : (
                  <>Subtitle (optional) — will create <strong>Season {nextNumber}</strong></>
                )}
                <Input name="subtitle" defaultValue={existingSeason?.subtitle ?? ""} placeholder="Optional subtitle (e.g. 'Launch')" style={{ width: "100%" }} />
              </label>
              <label>
                Group size
                <Input name="targetGroupSize" type="number" min={2} max={20} defaultValue={5} style={{ width: "100%" }} />
              </label>
              <label>
                Min group
                <Input name="minGroupSize" type="number" min={2} max={20} defaultValue={3} style={{ width: "100%" }} />
              </label>
              <label>
                Deck preset
                <FormSelect
                  name="matchConfigPresetId"
                  defaultValue=""
                  triggerClassName="w-full"
                  options={[
                    { value: "", label: "— Use Default —" },
                    ...presets.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
              </label>
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <strong>Tier layout</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  Pre-filled with your last-used layout (★)
                </span>
                <Link href="/admin/seasons/templates" style={{ marginLeft: "auto" }}>
                  <Button type="button" variant="secondary">Manage templates</Button>
                </Link>
              </div>
              <TierEditor initial={initialTiers} templates={templates} signupCount={sortedSignups.length} />
            </div>

            {existingSeason ? (
              <ConfirmButton
                message={`Redo Season ${existingSeason.number}'s setup? This replaces its current divisions and player placements.`}
                style={{ marginTop: 16 }}
              >
                Redo Season {existingSeason.number} setup · place {playerCount} players
              </ConfirmButton>
            ) : (
              <SubmitButton className="mt-4">
                Set up the season · place {playerCount} players
              </SubmitButton>
            )}
          </form>
        </div>
      </main>
    </>
  );
}

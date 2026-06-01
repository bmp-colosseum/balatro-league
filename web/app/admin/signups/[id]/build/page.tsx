import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadBuildSeasonPage } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { TierEditor } from "@/components/TierEditor";
import { DraggableRatingTable, type RatingRow } from "@/components/DraggableRatingTable";
import { addSignupByDiscordId, autoFillRatingsFromMmr, buildSeason, refreshSignupMmrSnapshots, saveRatings } from "./actions";

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
    priorSnapshotByDiscordId,
    priorByPlayerId,
    skippedByPlayerId,
    templates,
    initialTiers,
    presets,
    totalSlots,
    playerCount,
  } = result;

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
          click <strong>Build season</strong>. Auto-seed snake-drafts top-ranked players into the
          top tier, balancing skill across divisions within each tier.
        </p>

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
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <strong>Player ratings ({playerCount} signed up)</strong>
            <div style={{ display: "flex", gap: 6 }}>
              <form action={autoFillRatingsFromMmr}>
                <input type="hidden" name="roundId" value={round.id} />
                <button type="submit" className="secondary" style={{ fontSize: 12 }}>
                  Auto-fill ratings from BMP MMR
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
              const priorSnap = priorSnapshotByDiscordId.get(s.discordId);
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
                    }
                  : undefined,
                bmpMmr: snapshot?.rankedMmr ?? null,
                bmpTier: snapshot?.rankedTier ?? null,
                bmpTotalGames: snapshot?.totalGames ?? null,
                bmpWinRatePct: snapshot?.winRatePct ?? null,
                priorBmpMmr: priorSnap?.rankedMmr ?? null,
                bmpFetchError: snapshot?.fetchError ?? null,
              };
            });
            return <DraggableRatingTable initial={ratingRows} formAction={saveRatings} roundId={round.id} />;
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
                Season name
                <input name="name" required placeholder={`Season ${new Date().getFullYear()}`} style={{ width: "100%" }} />
              </label>
              <label>
                Deadline (UTC, optional)
                <input name="deadline" type="datetime-local" style={{ width: "100%" }} />
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
                Visibility
                <select name="visibility" defaultValue="PUBLIC" style={{ width: "100%" }}>
                  <option value="PUBLIC">PUBLIC (visible to players)</option>
                  <option value="INTERNAL">INTERNAL (admin-only test)</option>
                </select>
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

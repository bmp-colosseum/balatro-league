import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadBuildSeasonPage } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { TierEditor } from "@/components/TierEditor";
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
            Sorted by BMP Ranked MMR (descending). For returners, "Last season"
            shows their finishing rank — the strongest single signal you have for
            placement. BMP MMR trend ("current → prior") flags players who improved
            or slipped between seasons. Save ratings before building.
          </p>
          <form action={saveRatings}>
            <input type="hidden" name="roundId" value={round.id} />
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Status</th>
                  <th>Last season</th>
                  <th>BMP Ranked MMR</th>
                  <th style={{ width: 120 }}>Rating</th>
                </tr>
              </thead>
              <tbody>
                {sortedSignups.length === 0 ? (
                  <tr><td colSpan={5} className="muted">No signups in this round.</td></tr>
                ) : sortedSignups.map((s) => {
                  const player = playerByDiscordId.get(s.discordId);
                  const isReturning = !!player;
                  const prior = player ? priorByPlayerId.get(player.id) : undefined;
                  const skipped = player ? skippedByPlayerId.get(player.id) ?? 0 : 0;
                  const snapshot = snapshotByDiscordId.get(s.discordId);
                  const priorSnap = priorSnapshotByDiscordId.get(s.discordId);
                  return (
                    <tr key={s.id}>
                      <td>
                        {/* Only returners have a Player record yet — new signups
                            get one written during build, so we can't link them
                            until then. */}
                        {player ? (
                          <Link href={`/profile/${player.id}`} style={{ color: "var(--text)" }}>
                            <strong>{s.displayName}</strong>
                          </Link>
                        ) : (
                          <strong>{s.displayName}</strong>
                        )}
                        {" "}
                        <span className="muted" style={{ fontSize: 11 }}>{s.discordId}</span>
                      </td>
                      <td>
                        {!isReturning ? (
                          <span className="pill" style={{ background: "rgba(241,196,15,0.2)", color: "#f1c40f" }}>
                            New
                          </span>
                        ) : skipped >= 1 ? (
                          <span
                            className="pill"
                            style={{ background: "rgba(241,196,15,0.2)", color: "#f1c40f" }}
                            title={`Played ${skipped + 1} season${skipped > 0 ? "s" : ""} ago, skipped the last ${skipped}`}
                          >
                            Gap · skipped {skipped}
                          </span>
                        ) : (
                          <span className="pill" style={{ background: "rgba(52,152,219,0.2)", color: "#76c7ff" }}>
                            Returning
                          </span>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {prior ? (
                          <span>
                            <strong>{prior.divisionName}</strong>{" "}
                            <span className="muted">
                              · #{prior.rank}/{prior.totalMembers}
                              {skipped >= 1 ? ` (${skipped + 1}s ago)` : ""}
                            </span>
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {snapshot && snapshot.rankedMmr != null ? (
                          <span>
                            <strong>{snapshot.rankedMmr}</strong>
                            {priorSnap && priorSnap.rankedMmr != null && priorSnap.rankedMmr !== snapshot.rankedMmr && (
                              <span className="muted" style={{ fontSize: 11 }}>
                                {" "}← {priorSnap.rankedMmr}
                              </span>
                            )}
                            {" "}
                            <span className="muted">
                              ({snapshot.rankedTier} · {snapshot.totalGames}g · {snapshot.winRatePct}%)
                            </span>
                          </span>
                        ) : snapshot?.fetchError ? (
                          <span className="muted" title={snapshot.fetchError}>
                            {snapshot.fetchError.length > 30
                              ? `${snapshot.fetchError.slice(0, 27)}…`
                              : snapshot.fetchError}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <input
                          type="number"
                          name={`rating:${s.discordId}`}
                          defaultValue={player?.rating ?? snapshot?.rankedMmr ?? ""}
                          placeholder={snapshot?.rankedMmr ? `${snapshot.rankedMmr}` : "unrated"}
                          style={{ width: 100 }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <button type="submit" style={{ marginTop: 12 }}>Save ratings</button>
          </form>
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
              <TierEditor initial={initialTiers} templates={templates} />
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

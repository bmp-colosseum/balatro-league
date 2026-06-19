import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadBuildSeasonPage } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { PlacementSandbox, type SandboxPlayer } from "@/components/PlacementSandbox";
import { MmrSeedingTable } from "@/components/MmrSeedingTable";
import { ContinuityPreview } from "@/components/ContinuityPreview";
import { owenLadder } from "@/lib/season-plan";
import { loadContinuityPlacement } from "@/lib/loaders/continuity";
import { buildContinuitySeason } from "./actions";

export const dynamic = "force-dynamic";

// Dry-run placement sandbox for an OPEN/CLOSED signup round. Runs the current
// signups through the real build math live in the browser so you can twist the
// structure and see where everyone lands — writing nothing. Two bases:
// "fresh" (sort everyone into Owen's ladder by MMR) or "current" (returners hold
// their current-season division, rookies slot in).
export default async function PlacementPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ basis?: string; err?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { basis, err } = await searchParams;
  const mode = basis === "current" ? "current" : "fresh";

  const result = await loadBuildSeasonPage(id);
  if (result === "NOT_FOUND") notFound();
  // Already built → the draft exists; go straight to the editable arrange page.
  if (result === "BUILT_REDIRECT") redirect(`/admin/signups/${id}/arrange`);

  const { round, sortedSignups, playerByDiscordId, snapshotByDiscordId } = result;
  const continuity = mode === "current" ? await loadContinuityPlacement(round.id) : null;

  const players: SandboxPlayer[] = sortedSignups.map((s) => {
    const p = playerByDiscordId.get(s.discordId);
    const snap = snapshotByDiscordId.get(s.discordId);
    // Automatic build: use the stored secret MMR, else auto-derive from BMP
    // peak ×1.5 so the preview is always complete without a manual seeding step.
    const peak = snap?.peakMmr ?? snap?.rankedMmr ?? null;
    const effectiveMmr = p?.hiddenMmr ?? (peak != null ? Math.round(peak * 1.5) : null);
    return {
      discordId: s.discordId,
      displayName: s.displayName,
      rating: p?.rating ?? null,
      mmr: snap?.rankedMmr ?? null,
      hiddenMmr: effectiveMmr,
    };
  });

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Placement preview — "{round.name}"</h2>
          <span className="pill" style={{ background: "rgba(118,199,255,0.2)", color: "#76c7ff" }}>
            {players.length} signups · dry run
          </span>
          <Link href={`/admin/signups/${round.id}`} className="muted" style={{ marginLeft: "auto" }}>
            ← Back to round
          </Link>
        </div>
        {/* Basis toggle */}
        <div style={{ display: "flex", gap: 8, margin: "8px 0 4px" }}>
          <Link
            href={`/admin/signups/${round.id}/preview`}
            className={mode === "fresh" ? "" : "muted"}
            style={{ fontSize: 13, fontWeight: mode === "fresh" ? 600 : 400, textDecoration: mode === "fresh" ? "underline" : "none" }}
          >
            Fresh sort (Owen&apos;s ladder)
          </Link>
          <span className="muted">·</span>
          <Link
            href={`/admin/signups/${round.id}/preview?basis=current`}
            className={mode === "current" ? "" : "muted"}
            style={{ fontSize: 13, fontWeight: mode === "current" ? 600 : 400, textDecoration: mode === "current" ? "underline" : "none" }}
          >
            Based on current season
          </Link>
        </div>
        <p className="muted">
          {mode === "fresh" ? (
            <>
              Everyone sorted fresh into Owen&apos;s ladder (Legendary · Rare/Uncommon/Common) by MMR —
              how a <strong>first</strong> season builds. Tweak the structure; flip on{" "}
              <strong>Show schedules</strong> for each player&apos;s 4 opponents + SoS spread. Nothing saved.
            </>
          ) : (
            <>
              How a <strong>returning</strong> season builds: players keep their current-season division,
              new signups slot in by MMR. Flip on <strong>Show schedules</strong> for opponents + SoS. Nothing saved.
            </>
          )}
        </p>

        {players.length === 0 ? (
          <div className="card">No signups yet — once people join, their projected placement shows here.</div>
        ) : mode === "current" ? (
          continuity === "NO_SEASON" ? (
            <div className="card">No active season to base this on — use the fresh sort, or activate a season first.</div>
          ) : continuity === "NO_ROUND" || continuity == null ? (
            <div className="card">Couldn&apos;t load the round.</div>
          ) : (
            <>
              {err && (
                <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c", fontSize: 13 }}>
                  {err === "already-built"
                    ? "This round was already built into a season."
                    : err === "no-season"
                      ? "No active season to base this on."
                      : "Couldn't build the season — try again."}
                </div>
              )}
              <ContinuityPreview
                divisions={continuity.divisions}
                returnerCount={continuity.returnerCount}
                rookieCount={continuity.rookieCount}
                basedOnSeason={continuity.basedOnSeason}
                roundId={round.id}
                onBuild={buildContinuitySeason}
              />
            </>
          )
        ) : (
          <>
            <MmrSeedingTable players={players} />
            <PlacementSandbox players={players} initialTiers={owenLadder(players.length)} initialTargetGroupSize={5} />
          </>
        )}
      </main>
    </>
  );
}

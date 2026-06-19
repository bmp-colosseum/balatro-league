import Link from "next/link";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { loadBuildSeasonPage } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { PlacementSandbox, type SandboxPlayer } from "@/components/PlacementSandbox";
import { MmrSeedingTable } from "@/components/MmrSeedingTable";
import { ContinuityPreview } from "@/components/ContinuityPreview";
import { DraftArranger } from "@/components/DraftArranger";
import { owenLadder } from "@/lib/season-plan";
import { loadContinuityPlacement } from "@/lib/loaders/continuity";
import { absorbSignupsIntoDraft } from "@/lib/build-season-continuity";
import { buildContinuitySeason, reopenSignupRound } from "./actions";

export const dynamic = "force-dynamic";

// Placement preview for a signup round. "Fresh" = sort everyone into Owen's
// ladder by MMR (first season). "Current" = build from the live season. Once a
// current-basis draft is created, THIS page becomes the editable arranger
// (standard drag-and-drop editor) — no separate page, no read-only dead end.
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

  const round = await prisma.signupRound.findUnique({
    where: { id },
    select: { id: true, name: true, resultingSeasonId: true, status: true },
  });
  if (!round) notFound();

  // Is there an editable, populated DRAFT for this round? If so, the current
  // basis shows the standard editor on it.
  let editableDraftSeasonId: string | null = null;
  if (round.resultingSeasonId) {
    const s = await prisma.season.findUnique({
      where: { id: round.resultingSeasonId },
      select: { id: true, isActive: true, endedAt: true },
    });
    if (s && !s.isActive && !s.endedAt) {
      const memberCount = await prisma.divisionMember.count({ where: { seasonId: s.id } });
      if (memberCount > 0) editableDraftSeasonId = s.id;
    }
  }

  let body: ReactNode;
  let pill: ReactNode;

  if (mode === "current" && editableDraftSeasonId) {
    // The page IS the editor now. First absorb any new sign-ups / drop withdrawn
    // ones so the draft always reflects the live roster (your placements stay).
    try {
      await absorbSignupsIntoDraft(round.id, editableDraftSeasonId);
    } catch (err) {
      console.warn("[preview] absorb sign-ups failed:", err);
    }
    pill = (
      <span className="pill" style={{ background: "rgba(46,204,113,0.18)", color: "#2ecc71" }}>
        editing draft
      </span>
    );
    body = <DraftArranger seasonId={editableDraftSeasonId} roundId={round.id} />;
  } else {
    const result = await loadBuildSeasonPage(id);
    if (result === "NOT_FOUND") notFound();
    if (result === "BUILT_REDIRECT") {
      redirect(round.resultingSeasonId ? `/seasons/${round.resultingSeasonId}` : "/admin/seasons");
    }
    const { sortedSignups, playerByDiscordId, snapshotByDiscordId } = result;
    const players: SandboxPlayer[] = sortedSignups.map((s) => {
      const p = playerByDiscordId.get(s.discordId);
      const snap = snapshotByDiscordId.get(s.discordId);
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
    pill = (
      <span className="pill" style={{ background: "rgba(118,199,255,0.2)", color: "#76c7ff" }}>
        {players.length} signups · dry run
      </span>
    );
    const continuity = mode === "current" ? await loadContinuityPlacement(round.id) : null;
    if (players.length === 0) {
      body = <div className="card">No signups yet — once people join, their projected placement shows here.</div>;
    } else if (mode === "current") {
      body =
        continuity === "NO_SEASON" ? (
          <div className="card">No active season to base this on — use the fresh sort, or activate a season first.</div>
        ) : continuity === "NO_ROUND" || continuity == null ? (
          <div className="card">Couldn&apos;t load the round.</div>
        ) : (
          <>
            {err && (
              <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c", fontSize: 13 }}>
                {err === "no-season" ? "No active season to base this on." : "Couldn't build the season — try again."}
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
        );
    } else {
      body = (
        <>
          <MmrSeedingTable players={players} />
          <PlacementSandbox players={players} initialTiers={owenLadder(players.length)} initialTargetGroupSize={5} />
        </>
      );
    }
  }

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Placement — &ldquo;{round.name}&rdquo;</h2>
          {pill}
          <Link href={`/admin/signups/${round.id}`} className="muted" style={{ marginLeft: "auto" }}>
            ← Back to round
          </Link>
        </div>
        {round.status !== "OPEN" && (
          <div className="card" style={{ borderColor: "#f1c40f", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ color: "#f1c40f", fontSize: 13 }}>
              ⚠ Sign-ups for this round are <strong>{round.status}</strong> — the Discord Sign Up button is
              disabled. Arranging a draft no longer closes sign-ups; re-open if this was a mistake.
            </span>
            <form action={reopenSignupRound} style={{ marginLeft: "auto" }}>
              <input type="hidden" name="roundId" value={round.id} />
              <button type="submit" style={{ fontSize: 12, padding: "4px 12px", fontWeight: 600 }}>
                Re-open sign-ups
              </button>
            </form>
          </div>
        )}
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
          {mode === "current" && editableDraftSeasonId ? (
            <>
              This is the draft for next season — <strong>drag players between divisions, it saves automatically</strong>.
              Share this page with whoever&apos;s arranging. Nothing is live until you activate.
            </>
          ) : mode === "fresh" ? (
            <>
              Everyone sorted fresh into Owen&apos;s ladder by MMR — how a <strong>first</strong> season builds.
              Tweak the structure; flip on <strong>Show schedules</strong> for opponents + SoS. Nothing saved.
            </>
          ) : (
            <>
              How a <strong>returning</strong> season builds: returners hold their finish, new signups slot in by MMR.
              Hit <strong>Edit these groupings</strong> to make it an editable draft. Nothing saved until you do.
            </>
          )}
        </p>

        {body}
      </main>
    </>
  );
}

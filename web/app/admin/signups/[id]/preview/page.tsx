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

  // Resolve the round's resulting season: a DRAFT we can edit, or LIVE/ended.
  let draftSeasonId: string | null = null;
  let seasonLive = false;
  if (round.resultingSeasonId) {
    const s = await prisma.season.findUnique({
      where: { id: round.resultingSeasonId },
      select: { isActive: true, endedAt: true },
    });
    if (s && (s.isActive || s.endedAt)) seasonLive = true;
    else if (s) draftSeasonId = round.resultingSeasonId;
  }
  // Only a genuinely LIVE/ended season sends you away — a built DRAFT stays
  // editable here (BUILT no longer means "done").
  if (seasonLive && round.resultingSeasonId) redirect(`/seasons/${round.resultingSeasonId}`);

  // Current basis + a populated draft → the editor (absorb new sign-ups first).
  let editorSeasonId: string | null = null;
  if (mode === "current" && draftSeasonId) {
    try {
      await absorbSignupsIntoDraft(round.id, draftSeasonId);
    } catch (e) {
      console.warn("[preview] absorb sign-ups failed:", e);
    }
    const memberCount = await prisma.divisionMember.count({ where: { seasonId: draftSeasonId } });
    if (memberCount > 0) editorSeasonId = draftSeasonId;
  }

  let body: ReactNode;
  let pill: ReactNode;

  if (editorSeasonId) {
    pill = <span className="pill" style={{ background: "rgba(46,204,113,0.18)", color: "#2ecc71" }}>editing draft</span>;
    body = <DraftArranger seasonId={editorSeasonId} roundId={round.id} />;
  } else if (mode === "current") {
    // Read-only continuity projection (no draft yet / empty). Doesn't touch loadBuildSeasonPage.
    const continuity = await loadContinuityPlacement(round.id);
    const ok = continuity !== "NO_ROUND" && continuity !== "NO_SEASON" && continuity != null;
    const count = ok ? continuity.returnerCount + continuity.rookieCount : 0;
    pill = <span className="pill" style={{ background: "rgba(118,199,255,0.2)", color: "#76c7ff" }}>{count} signups · dry run</span>;
    body =
      continuity === "NO_SEASON" ? (
        <div className="card">No active season to base this on — use the fresh sort, or activate a season first.</div>
      ) : !ok ? (
        <div className="card">Couldn&apos;t load the round.</div>
      ) : count === 0 ? (
        <div className="card">No signups yet — once people join, their projected placement shows here.</div>
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
    // Fresh basis — needs the player list.
    const result = await loadBuildSeasonPage(id);
    if (result === "NOT_FOUND") notFound();
    if (result === "BUILT_REDIRECT") {
      pill = <span className="pill" style={{ background: "rgba(118,199,255,0.2)", color: "#76c7ff" }}>draft exists</span>;
      body = (
        <div className="card">
          This round already has a draft — switch to{" "}
          <Link href={`/admin/signups/${round.id}/preview?basis=current`}>Based on current season</Link> to edit it.
        </div>
      );
    } else {
      const { sortedSignups, playerByDiscordId, snapshotByDiscordId } = result;
      const players: SandboxPlayer[] = sortedSignups.map((s) => {
        const p = playerByDiscordId.get(s.discordId);
        const snap = snapshotByDiscordId.get(s.discordId);
        const peak = snap?.peakMmr ?? snap?.rankedMmr ?? null;
        const effectiveMmr = p?.hiddenMmr ?? (peak != null ? Math.round(peak * 1.5) : null);
        return { discordId: s.discordId, displayName: s.displayName, rating: p?.rating ?? null, mmr: snap?.rankedMmr ?? null, hiddenMmr: effectiveMmr };
      });
      pill = <span className="pill" style={{ background: "rgba(118,199,255,0.2)", color: "#76c7ff" }}>{players.length} signups · dry run</span>;
      body =
        players.length === 0 ? (
          <div className="card">No signups yet — once people join, their projected placement shows here.</div>
        ) : (
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
        {round.status === "CLOSED" && (
          <div className="card" style={{ borderColor: "#f1c40f", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ color: "#f1c40f", fontSize: 13 }}>
              ⚠ Sign-ups are <strong>closed</strong> for this round — the Discord Sign Up button is off. Re-open to let
              people join again. (A built draft still takes sign-ups; only an explicit close stops them.)
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
          {mode === "current" && editorSeasonId ? (
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

import Link from "next/link";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadBuildSeasonPage } from "@/lib/loaders/admin";
import {
  loadPreviewRound,
  loadSeasonLifecycle,
  loadDraftMemberCount,
} from "@/lib/loaders/admin-preview";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlacementSandbox, type SandboxPlayer } from "@/components/PlacementSandbox";
import { MmrSeedingTable } from "@/components/MmrSeedingTable";
import { ContinuityPreview } from "@/components/ContinuityPreview";
import { DraftArranger } from "@/components/DraftArranger";
import { owenLadder } from "@/lib/season-plan";
import { loadContinuityPlacement } from "@/lib/loaders/continuity";
import { absorbSignupsIntoDraft } from "@/lib/build-season-continuity";
import { getPlacementRules } from "@/lib/placement-rules";
import { buildContinuitySeason, reopenSignupRound, savePlacementRules } from "./actions";

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

  const round = await loadPreviewRound(id);
  if (!round) notFound();

  const rules = await getPlacementRules();

  // Resolve the round's resulting season: a DRAFT we can edit, or LIVE/ended.
  let draftSeasonId: string | null = null;
  let seasonLive = false;
  if (round.resultingSeasonId) {
    const s = await loadSeasonLifecycle(round.resultingSeasonId);
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
    const memberCount = await loadDraftMemberCount(draftSeasonId);
    if (memberCount > 0) editorSeasonId = draftSeasonId;
  }

  let body: ReactNode;
  let pill: ReactNode;

  if (editorSeasonId) {
    pill = <span className="pill" style={{ background: "rgba(46,204,113,0.18)", color: "var(--success)" }}>editing draft</span>;
    body = <DraftArranger seasonId={editorSeasonId} roundId={round.id} />;
  } else if (mode === "current") {
    // Read-only continuity projection (no draft yet / empty). Doesn't touch loadBuildSeasonPage.
    const continuity = await loadContinuityPlacement(round.id);
    const ok = continuity !== "NO_ROUND" && continuity !== "NO_SEASON" && continuity != null;
    const count = ok ? continuity.returnerCount + continuity.rookieCount : 0;
    pill = <span className="pill" style={{ background: "rgba(118,199,255,0.2)", color: "var(--info)" }}>{count} signups · dry run</span>;
    body =
      continuity === "NO_SEASON" ? (
        <div className="card">No active season to base this on — use the fresh sort, or start a season first.</div>
      ) : !ok ? (
        <div className="card">Couldn&apos;t load the round.</div>
      ) : count === 0 ? (
        <div className="card">No signups yet — once people join, their projected placement shows here.</div>
      ) : (
        <>
          {err && (
            <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)", fontSize: 13 }}>
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
            roundRobinTop={rules.roundRobinTopDivisions}
          />
        </>
      );
  } else {
    // Fresh basis — needs the player list.
    const result = await loadBuildSeasonPage(id);
    if (result === "NOT_FOUND") notFound();
    if (result === "BUILT_REDIRECT") {
      pill = <span className="pill" style={{ background: "rgba(118,199,255,0.2)", color: "var(--info)" }}>draft exists</span>;
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
      pill = <span className="pill" style={{ background: "rgba(118,199,255,0.2)", color: "var(--info)" }}>{players.length} signups · dry run</span>;
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
          <div className="card" style={{ borderColor: "var(--accent)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ color: "var(--accent)", fontSize: 13 }}>
              ⚠ Signups are <strong>closed</strong> for this round — the Discord Sign Up button is off. Reopen to let
              people join again.
            </span>
            <form action={reopenSignupRound} style={{ marginLeft: "auto" }}>
              <input type="hidden" name="roundId" value={round.id} />
              <button type="submit" style={{ fontSize: 12, padding: "4px 12px", fontWeight: 600 }}>
                Reopen signups
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
              Share this page with whoever&apos;s arranging. Nothing goes live until you start the season.
            </>
          ) : mode === "fresh" ? (
            <>
              Everyone sorted fresh into Owen&apos;s ladder by MMR — how a <strong>first</strong> season builds.
              Tweak the structure; turn on <strong>Show schedules</strong> to see opponents and strength of schedule. Nothing is saved.
            </>
          ) : (
            <>
              How a <strong>returning</strong> season builds: returners keep their finish, new signups slot in by MMR.
              Click <strong>Edit these groupings</strong> to turn it into an editable draft. Nothing is saved until you do.
            </>
          )}
        </p>

        {mode === "current" && (
          <details className="card" style={{ padding: 12 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
              ⚙ Promotion &amp; relegation rules
              <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                top {rules.topFixedSize || "—"} · {rules.roundRobinTopDivisions} round-robin · swap {rules.baseSwap}/{rules.bigSwap}@≥{rules.swapThreshold} · {rules.tightenTopTiers ? "tightened top" : "symmetric top"}
              </span>
            </summary>
            <form action={savePlacementRules} style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
              <input type="hidden" name="roundId" value={round.id} />
              <label style={{ fontSize: 12, display: "grid", gap: 2 }} className="muted">
                Top division fixed size
                <Input type="number" name="topFixedSize" defaultValue={rules.topFixedSize} min={0} max={50} style={{ width: 80 }} />
              </label>
              <label style={{ fontSize: 12, display: "grid", gap: 2 }} className="muted">
                Round-robin top divisions
                <Input type="number" name="roundRobinTopDivisions" defaultValue={rules.roundRobinTopDivisions} min={0} max={10} style={{ width: 80 }} />
              </label>
              <label style={{ fontSize: 12, display: "grid", gap: 2 }} className="muted">
                Swap when both divisions ≥
                <Input type="number" name="swapThreshold" defaultValue={rules.swapThreshold} min={1} max={50} style={{ width: 80 }} />
              </label>
              <label style={{ fontSize: 12, display: "grid", gap: 2 }} className="muted">
                Normal swap
                <Input type="number" name="baseSwap" defaultValue={rules.baseSwap} min={0} max={20} style={{ width: 70 }} />
              </label>
              <label style={{ fontSize: 12, display: "grid", gap: 2 }} className="muted">
                Big swap (≥ threshold)
                <Input type="number" name="bigSwap" defaultValue={rules.bigSwap} min={0} max={20} style={{ width: 70 }} />
              </label>
              <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" name="tightenTopTiers" defaultChecked={rules.tightenTopTiers} />
                Tighten top tiers (1 up / 2 down on Rare 1↔2, 2↔3)
              </label>
              <Button type="submit" variant="secondary" size="sm">Save rules</Button>
            </form>
            <p className="muted" style={{ fontSize: 11, margin: "8px 0 0" }}>
              Saved league-wide. The projection above + the next build + the schedule lock at activation all use these.
              Lower boundaries swap <strong>{rules.bigSwap}</strong> when both divisions have ≥{rules.swapThreshold} finishers,
              else <strong>{rules.baseSwap}</strong>.
            </p>
          </details>
        )}

        {body}
      </main>
    </>
  );
}

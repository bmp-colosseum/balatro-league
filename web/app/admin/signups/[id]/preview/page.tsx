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
import { DEFAULT_SEED } from "@/lib/mmr-recompute";
import { loadContinuityPlacement } from "@/lib/loaders/continuity";
import { absorbSignupsIntoDraft } from "@/lib/build-season-continuity";
import { getPlacementRules } from "@/lib/placement-rules";
import { buildContinuitySeason, reopenSignupRound, savePlacementRules } from "./actions";
import { Callout } from "@/components/Callout";

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
  // Default to the current-season basis (returners keep their finish, new
  // signups slot in by MMR). The old "fresh sort" view was confusing now that
  // the league has history; it's still reachable via ?basis=fresh as an escape
  // hatch (e.g. a literal first season) but isn't surfaced in the UI.
  const mode = basis === "fresh" ? "fresh" : "current";

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
        // No active season to carry placement over from — this is a first
        // season (or a rebuild with no history). Continuity can't apply, so
        // send them to the manual setup (rate players + pick the tier shape).
        // This is the ONLY place /build is surfaced now — it's the first-season
        // fallback, not a competing "build" path.
        <div className="card" style={{ display: "grid", gap: 10 }}>
          <strong>No previous season to carry placement over from</strong>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            This looks like a first season (or there&apos;s no active season to base continuity on). Set the
            divisions up by hand — rate the players and pick the tier shape.
          </p>
          <Link href={`/admin/signups/${round.id}/build`}>
            <Button type="button"><strong>Set up divisions manually →</strong></Button>
          </Link>
        </div>
      ) : !ok ? (
        <div className="card">Couldn&apos;t load the round.</div>
      ) : count === 0 ? (
        <div className="card">No signups yet — once people join, their projected placement shows here.</div>
      ) : (
        <>
          {err && (
            <Callout type="danger" style={{ fontSize: 13 }}>
              {err === "no-season" ? "No active season to base this on." : "Couldn't build the season — try again."}
            </Callout>
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
        // Floor unseeded players to the engine's default (300) instead of null,
        // so they get a real "minimum rank" and sort sensibly rather than piling
        // at the bottom as "no MMR".
        const effectiveMmr = p?.hiddenMmr ?? (peak != null ? Math.round(peak * 1.5) : DEFAULT_SEED);
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
          <div className="card card-accent" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ color: "var(--accent)", fontSize: 13 }}>
              ⚠ Signups are <strong>closed</strong> for this round — the Discord Sign Up button is off. Reopen to let
              people join again.
            </span>
            <form action={reopenSignupRound} style={{ marginLeft: "auto" }}>
              <input type="hidden" name="roundId" value={round.id} />
              <Button type="submit" style={{ fontSize: 12, padding: "4px 12px", fontWeight: 600 }}>
                Reopen signups
              </Button>
            </form>
          </div>
        )}
        <p className="muted">
          {editorSeasonId ? (
            <>
              This is the draft for next season — <strong>drag players between divisions, it saves automatically</strong>.
              Share this page with whoever&apos;s arranging. Nothing goes live until you start the season.
            </>
          ) : (
            <>
              How next season builds from the current one: returners keep their finish, new signups slot in by MMR.
              Click <strong>Edit these groupings</strong> to turn it into an editable draft. Nothing is saved until you do.
            </>
          )}
        </p>

        {mode === "current" && (
          <details className="card" style={{ padding: 12 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
              ⚙ Promotion &amp; relegation rules
              <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                top {rules.topFixedSize || "—"} · {rules.roundRobinTopDivisions} round-robin · swap {rules.baseSwap}/{rules.bigSwap}@≥{rules.swapThreshold}
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
              <Button type="submit" variant="secondary" size="sm">Save rules</Button>
            </form>
            <p className="muted" style={{ fontSize: 11, margin: "8px 0 0" }}>
              Saved league-wide. The projection above + the next build + the schedule lock at activation all use these.
              <strong> Legendary is always 1 down / 1 up.</strong> Every other boundary is matched: it swaps
              <strong> {rules.bigSwap}</strong> up/down when both divisions have ≥{rules.swapThreshold} players, else
              <strong> {rules.baseSwap}</strong> — so what relegates down always equals what promotes up.
            </p>
          </details>
        )}

        {body}
      </main>
    </>
  );
}

import Link from "next/link";
import { ArrowLeft, Crown, Shuffle } from "lucide-react";
import { getViewer, isAdmin } from "@/lib/auth";
import { capabilitiesFor, captainTeamsFor, seasonIdByName } from "@/lib/permissions";
import { getDraftSetup, getDraft, getDraftEditData } from "@/lib/services/draft";
import { Callout } from "@/components/Callout";
import { NoAccess } from "@/components/NoAccess";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { FormSelect } from "@/components/FormSelect";
import { setupDraftAction, resetDraftAction, makePickAction, reassignPickAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function DraftAdmin({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);

  // DRAFT runner / TO run the board; a captain can view + pick when on the clock.
  const to = await isAdmin();
  const seasonId = to ? null : await seasonIdByName(seasonName);
  const viewer = to ? null : await getViewer();
  const isRunner = to || !!(viewer && (await capabilitiesFor(viewer, seasonId)).has("DRAFT"));
  const isCaptain = !isRunner && !!viewer && (await captainTeamsFor(viewer, seasonId)).size > 0;
  if (!isRunner && !isCaptain) return <NoAccess what="view the draft" />;

  const setup = await getDraftSetup(seasonName);

  const back = (
    <p>
      <Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
    </p>
  );

  if (!setup) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }

  // ── No draft yet → setup ──────────────────────────────────────────────────
  if (!setup.season.draft) {
    const teams = setup.captains.length;
    const rounds = setup.season.teamSize;
    return (
      <main>
        {back}
        <h1>Draft setup</h1>
        <p className="sub">
          {setup.approved.length} approved · {teams} willing captains. Building the draft creates a team per captain,
          splits them across conferences, and pre-fills each captain&apos;s round-1 self-pick.
        </p>
        {teams < 2 ? (
          <Callout type="admin">
            Need at least 2 approved, willing captains to build a draft — approve captains in{" "}
            <Link href={`/admin/seasons/${enc}/signups`}>signups</Link>.
          </Callout>
        ) : (
          <div className="card">
            <p className="sub">Plan: {teams} teams × {rounds} rounds = {teams * rounds} picks.</p>
            <ActionFlashForm action={setupDraftAction}>
              <input type="hidden" name="season" value={seasonName} />
              <SubmitButton pendingText="Building…"><Shuffle /> Build draft</SubmitButton>
            </ActionFlashForm>
          </div>
        )}
      </main>
    );
  }

  // ── Draft exists → live board ─────────────────────────────────────────────
  const board = await getDraft(seasonName);
  if (!board) {
    return (
      <main>
        {back}
        <h1>Draft</h1>
        <Callout type="danger">Draft exists but couldn&apos;t be loaded.</Callout>
      </main>
    );
  }
  const done = board.state === "DONE" || !board.current;
  const editData = done ? await getDraftEditData(seasonName) : null;

  return (
    <main>
      {back}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1>{seasonName} — Draft</h1>
        <form action={resetDraftAction}>
          <input type="hidden" name="season" value={seasonName} />
          <ConfirmButton
            message="Reset the draft? This deletes the teams, conferences, and all picks for this season."
            variant="destructive"
            size="sm"
          >
            Reset draft
          </ConfirmButton>
        </form>
      </div>
      <p className="sub">{board.madePicks}/{board.totalPicks} picks · {board.state}</p>

      {done ? (
        <Callout type="success">
          Draft complete. <Link href={`/seasons/${enc}/draft`}>View the public board →</Link>
        </Callout>
      ) : (
        <div className="card card-accent">
          <div className="bracket-title">On the clock</div>
          <div>
            Round {board.current!.round} · <strong>{board.current!.team?.name ?? "—"}</strong> — pick a player below.
          </div>
        </div>
      )}

      {/* Teams */}
      <div className="grid grid-3">
        {board.teams.map((t) => (
          <div className="card" key={t.id} style={{ marginBottom: 0, borderColor: t.onClock ? "var(--accent-2)" : undefined }}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{t.name}</span>
              <span className="badge">{t.conference}</span>
            </div>
            <ol className="mt-2 list-none p-0" style={{ margin: 0 }}>
              <li className="flex items-baseline gap-2 py-0.5">
                <span className="rank" style={{ width: "1.4rem" }}>C</span>
                <Crown className="size-3.5 shrink-0 text-[var(--accent)]" />
                <span className="font-semibold">{t.captainName}</span>
              </li>
              {[...t.picks].sort((a, b) => a.round - b.round).map((p) => (
                <li key={p.round} className="flex items-baseline gap-2 py-0.5">
                  <span className="rank" style={{ width: "1.4rem" }}>{p.round}</span>
                  <span>{p.name}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>

      {/* Fix a pick (imported / completed drafts) */}
      {done && editData && editData.picks.length > 0 && (
        <>
          <h2 className="mt-6 mb-1 text-[1.1rem]">Fix a pick</h2>
          <div className="card">
            <p className="sub px-0.5">Reassign a draft slot to the right player. This fixes the draft board, heatmap and each player&apos;s draft round — team membership + seeds are separate (use <Link href={`/admin/seasons/${enc}/roster`}>Roster ops</Link>).</p>
            <ActionFlashForm action={reassignPickAction}>
              <input type="hidden" name="season" value={seasonName} />
              <div className="flex flex-wrap items-end gap-2">
                <label className="block"><span className="sub">Pick</span><FormSelect name="pickId" options={[{ value: "", label: "— select pick —" }, ...editData.picks.map((p) => ({ value: p.id, label: p.label }))]} /></label>
                <label className="block"><span className="sub">Should be</span><FormSelect name="playerId" options={[{ value: "", label: "— player —" }, ...editData.players.map((p) => ({ value: p.id, label: p.name }))]} /></label>
                <SubmitButton size="sm" variant="secondary" pendingText="…">Reassign</SubmitButton>
              </div>
            </ActionFlashForm>
          </div>
        </>
      )}

      {/* Pool */}
      {!done && (
        <>
          <h2 className="mt-6 mb-1 text-[1.1rem]">Available players ({board.pool.length})</h2>
          <div className="card">
            <div className="flex flex-wrap gap-2">
              {board.pool.map((p) => (
                <form key={p.id} action={makePickAction} className="inline">
                  <input type="hidden" name="season" value={seasonName} />
                  <input type="hidden" name="playerId" value={p.id} />
                  <SubmitButton size="sm" variant="secondary" pendingText="…">{p.displayName}</SubmitButton>
                </form>
              ))}
              {board.pool.length === 0 && <p className="sub">Pool empty.</p>}
            </div>
          </div>
        </>
      )}
    </main>
  );
}

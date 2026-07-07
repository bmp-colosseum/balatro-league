import Link from "next/link";
import { ArrowLeft, LogIn, Crown } from "lucide-react";
import { getViewer } from "@/lib/auth";
import { getCaptainPairing } from "@/lib/services/pairing";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { SeedOrSub } from "@/components/SeedOrSub";
import { DeadlineChip } from "@/components/DeadlineChip";
import { LiveRefresh } from "@/components/LiveRefresh";
import { proposeAction, respondAction, cancelProposalAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function CaptainPairing({ params }: { params: Promise<{ matchupId: string }> }) {
  const { matchupId } = await params;
  const viewer = await getViewer();

  if (!viewer.playerId) {
    return (
      <main>
        <h1>Pair your week</h1>
        <p className="sub">Sign in with Discord to pair your team&apos;s sets.</p>
        <Link href="/auth/signin" className="inline-flex items-center gap-1.5"><LogIn className="size-4" /> Sign in</Link>
      </main>
    );
  }

  const c = await getCaptainPairing(matchupId, viewer.playerId);
  if (!c) {
    return (
      <main>
        <p><Link href="/me" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> my tour</Link></p>
        <h1>Matchup not found</h1>
      </main>
    );
  }
  if (!c.authorized) {
    return (
      <main>
        <p><Link href="/me" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> my tour</Link></p>
        <h1>Pairing</h1>
        <Callout type="admin">Only the two captains in this matchup can pair it.</Callout>
      </main>
    );
  }

  const teamCol = (t: { name: string; captainName: string; captainId: string; players: { playerId: string; name: string; seed: number; paired: boolean; pending: boolean }[] }, mine: boolean) => (
    <div className="card" style={{ marginBottom: 0, borderColor: mine ? "var(--accent-2)" : undefined }}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{t.name}</span>
        {mine && <span className="badge">you</span>}
      </div>
      <div className="sub flex items-center gap-1"><Crown className="size-3 text-[var(--accent)]" /> <Link href={`/players/${t.captainId}`}>{t.captainName}</Link></div>
      <ol className="mt-2 list-none p-0" style={{ margin: 0 }}>
        {t.players.map((p) => (
          <li key={p.playerId} className="flex items-baseline gap-2 py-0.5" style={{ opacity: p.paired ? 0.5 : 1 }}>
            <span className="rank" style={{ width: "1.4rem" }}>{p.seed}</span>
            <span style={{ textDecoration: p.paired ? "line-through" : undefined }}><Link href={`/players/${p.playerId}`}>{p.name}</Link></span>
            {p.pending && <span className="badge" style={{ color: "var(--accent-2)" }}>proposed</span>}
          </li>
        ))}
      </ol>
    </div>
  );

  return (
    <main>
      <LiveRefresh channel={`matchup:${matchupId}`} />
      <p>
        <Link href="/me" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> my tour</Link>
      </p>
      <h1>Week {c.weekNumber} — {c.myTeamName} vs {c.oppTeamName}</h1>
      <p className="sub inline-flex flex-wrap items-center gap-2">
        <span>Pair each of your players against one within ±{c.windowSize} seeds, alternating proposals with {c.oppTeamName}&apos;s captain.</span>
        <DeadlineChip deadline={c.deadlineAt} prefix="play by" />
      </p>

      {/* Completed pairs */}
      {c.pairs.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th className="rank">#</th><th>{c.teamA.name}</th><th>{c.teamB.name}</th><th>Status</th></tr></thead>
            <tbody>
              {c.pairs.map((p, i) => (
                <tr key={i}>
                  <td className="rank">{i + 1}</td>
                  <td><SeedOrSub seed={p.aSeed} isSub={p.aIsSub} /> <Link href={`/players/${p.aPlayerId}`}>{p.aName}</Link></td>
                  <td><SeedOrSub seed={p.bSeed} isSub={p.bIsSub} /> <Link href={`/players/${p.bPlayerId}`}>{p.bName}</Link></td>
                  <td className="sub">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The action box */}
      {c.complete ? (
        <Callout type="success">All players paired — {c.pairs.length} sets. Reach out to your opponents and play your sets; report on <Link href="/me">My Tour</Link>.</Callout>
      ) : c.deadlocked ? (
        <Callout type="danger">The remaining players can&apos;t complete a ±{c.windowSize} pairing — a TO needs to step in. Ping a TO.</Callout>
      ) : c.myTurnToRespond ? (
        <div className="card card-accent">
          <div className="bracket-title">{c.pending?.playerName} (seed {c.pending?.seed}) was proposed — answer within ±{c.windowSize}</div>
          <ActionFlashForm action={respondAction}>
            <input type="hidden" name="matchupId" value={matchupId} />
            <div className="flex flex-wrap items-end gap-2">
              <FormSelect name="playerId" options={[{ value: "", label: "— your player —" }, ...c.respondOptions.map((p) => ({ value: p.playerId, label: `#${p.seed} ${p.name}` }))]} placeholder="— your player —" />
              <SubmitButton pendingText="Pairing…">Respond</SubmitButton>
            </div>
          </ActionFlashForm>
        </div>
      ) : c.myTurnToPropose ? (
        <div className="card card-accent">
          <div className="bracket-title">Your turn — propose a player</div>
          <ActionFlashForm action={proposeAction}>
            <input type="hidden" name="matchupId" value={matchupId} />
            <div className="flex flex-wrap items-end gap-2">
              <FormSelect name="playerId" options={[{ value: "", label: "— your player —" }, ...c.proposeOptions.map((p) => ({ value: p.playerId, label: `#${p.seed} ${p.name}` }))]} placeholder="— your player —" />
              <SubmitButton pendingText="Proposing…">Propose</SubmitButton>
            </div>
          </ActionFlashForm>
        </div>
      ) : (
        <div className="card">
          <p className="sub">
            {c.pending?.byMe
              ? `You proposed ${c.pending.playerName} — waiting for ${c.oppTeamName}'s captain to respond.`
              : `Waiting for ${c.oppTeamName}'s captain to propose.`}
          </p>
          {c.pending?.byMe && (
            <form action={cancelProposalAction}>
              <input type="hidden" name="matchupId" value={matchupId} />
              <SubmitButton size="sm" variant="secondary" pendingText="…">Cancel my proposal</SubmitButton>
            </form>
          )}
        </div>
      )}

      {/* Rosters */}
      <div className="grid grid-2 mt-4">
        {teamCol(c.teamA, c.side === "A")}
        {teamCol(c.teamB, c.side === "B")}
      </div>
    </main>
  );
}

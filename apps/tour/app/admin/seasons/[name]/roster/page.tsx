import Link from "next/link";
import { ArrowLeft, Crown, X, RefreshCw } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getRosterOps } from "@/lib/services/roster-ops";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { substituteAction, dropAction, dqAction, removeEventAction } from "./actions";

export const dynamic = "force-dynamic";

const reasonInput = "w-44 rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5";
const noneFirst = (opts: { value: string; label: string }[]) => [{ value: "", label: "— select —" }, ...opts];

export default async function RosterOpsAdmin({ params }: { params: Promise<{ name: string }> }) {
  if (!isAdmin()) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Not authorized. Set <code>TOUR_DEV_ADMIN=1</code>.</Callout>
      </main>
    );
  }

  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);
  const data = await getRosterOps(seasonName);

  if (!data) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }

  const blockOpts = data.weekBlocks.map((b) => ({ value: b, label: b }));
  const faOpts = data.freeAgents.map((p) => ({ value: p.id, label: p.name }));
  const allRosterPlayers = data.teams.flatMap((t) => t.roster.map((p) => ({ value: p.playerId, label: `${p.name} (${t.name})` })));

  return (
    <main>
      <p>
        <Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
      </p>
      <h1>Roster ops</h1>
      <p className="sub">
        Substitutions change the lineup on a forward week-block (history is preserved). Drops and DQs are recorded as
        audit events with a reason. Free-agent pool: {data.freeAgents.length}.
      </p>

      {/* Teams: roster + sub + drop */}
      <div className="grid grid-2">
        {data.teams.map((t) => {
          const rosterOpts = t.roster.map((p) => ({ value: p.playerId, label: `#${p.seed} ${p.name}` }));
          return (
            <div className="card" key={t.teamSeasonId} style={{ marginBottom: 0 }}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{t.name}</span>
                <span className="badge">{t.activeBlock ?? "no roster"}</span>
              </div>
              <ol className="mt-2 list-none p-0" style={{ margin: 0 }}>
                {t.roster.map((p) => (
                  <li key={p.playerId} className="flex items-baseline gap-2 py-0.5">
                    <span className="rank" style={{ width: "1.4rem" }}>{p.seed}</span>
                    {p.isCaptain && <Crown className="size-3.5 shrink-0 text-[var(--accent)]" />}
                    <span>{p.name}</span>
                  </li>
                ))}
                {t.roster.length === 0 && <li className="sub">No roster yet.</li>}
              </ol>

              {t.roster.length > 0 && (
                <>
                  <div className="bracket-title mt-3">Substitute</div>
                  <ActionFlashForm action={substituteAction}>
                    <input type="hidden" name="season" value={seasonName} />
                    <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="block"><span className="sub">Out</span><FormSelect name="outPlayerId" options={noneFirst(rosterOpts)} /></label>
                      <label className="block"><span className="sub">In</span><FormSelect name="inPlayerId" options={noneFirst(faOpts)} placeholder="— pool —" /></label>
                      <label className="block"><span className="sub">Block</span><FormSelect name="weekBlock" options={blockOpts} defaultValue={t.activeBlock ?? data.weekBlocks[0]} /></label>
                      <input name="reason" placeholder="reason" className={reasonInput} />
                      <SubmitButton size="sm" variant="secondary" pendingText="…"><RefreshCw className="size-3.5" /> Sub</SubmitButton>
                    </div>
                  </ActionFlashForm>

                  <div className="bracket-title mt-3">Drop</div>
                  <ActionFlashForm action={dropAction}>
                    <input type="hidden" name="season" value={seasonName} />
                    <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="block"><span className="sub">Player</span><FormSelect name="playerId" options={noneFirst(rosterOpts)} /></label>
                      <input name="reason" placeholder="reason" className={reasonInput} />
                      <SubmitButton size="sm" variant="secondary" pendingText="…">Record drop</SubmitButton>
                    </div>
                  </ActionFlashForm>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* DQ */}
      <h2 className="mt-6 mb-1 text-[1.1rem]">Disqualification</h2>
      <div className="card">
        <ActionFlashForm action={dqAction}>
          <input type="hidden" name="season" value={seasonName} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="block"><span className="sub">Team (optional)</span><FormSelect name="teamSeasonId" options={noneFirst(data.teams.map((t) => ({ value: t.teamSeasonId, label: t.name })))} placeholder="— none —" /></label>
            <label className="block"><span className="sub">Player (optional)</span><FormSelect name="playerId" options={noneFirst(allRosterPlayers)} placeholder="— none —" /></label>
            <input name="reason" placeholder="reason (required)" className={reasonInput} />
            <SubmitButton variant="secondary" pendingText="…">Record DQ</SubmitButton>
          </div>
        </ActionFlashForm>
      </div>

      {/* Event log */}
      <h2 className="mt-6 mb-1 text-[1.1rem]">Event log ({data.events.length})</h2>
      <div className="card">
        {data.events.length === 0 ? (
          <p className="sub">No roster exceptions recorded.</p>
        ) : (
          <table>
            <thead><tr><th>Type</th><th>Detail</th><th>Reason</th><th></th></tr></thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td><span className="badge">{e.kindLabel}</span></td>
                  <td>
                    {e.kind === "SUBSTITUTION"
                      ? <>{e.player} <span className="muted">→</span> {e.relatedPlayer} <span className="sub">({e.team} · {e.weekBlock})</span></>
                      : <>{e.player ?? e.team ?? "—"} {e.player && e.team ? <span className="sub">({e.team})</span> : null}</>}
                  </td>
                  <td className="sub">{e.reason}</td>
                  <td style={{ textAlign: "right" }}>
                    <form action={removeEventAction}>
                      <input type="hidden" name="season" value={seasonName} />
                      <input type="hidden" name="eventId" value={e.id} />
                      <SubmitButton size="sm" variant="secondary" pendingText="…"><X className="size-3.5" /></SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

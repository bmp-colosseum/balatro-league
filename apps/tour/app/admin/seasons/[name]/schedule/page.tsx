import Link from "next/link";
import { ArrowLeft, CalendarDays, Pencil } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getScheduleSetup, getSchedule } from "@/lib/services/schedule";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { DeadlineChip } from "@/components/DeadlineChip";
import { utcToEtWall } from "@/lib/date";
import { generateScheduleAction, resetScheduleAction, setWeekDeadlineAction, applyCadenceAction, clearDeadlinesAction } from "./actions";

const dtInput = "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[13px]";

export const dynamic = "force-dynamic";

export default async function ScheduleAdmin({ params }: { params: Promise<{ name: string }> }) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only — you don&apos;t have access.</Callout>
      </main>
    );
  }

  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);
  const setup = await getScheduleSetup(seasonName);

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

  // ── No schedule yet → setup ───────────────────────────────────────────────
  if (!setup.hasSchedule) {
    const playable = setup.conferences.filter((c) => c.teams.length >= 2);
    return (
      <main>
        {back}
        <h1>Schedule setup</h1>
        <p className="sub">
          Generates each conference&apos;s round-robin into {setup.weekCount} weeks — every team plays everyone in its
          conference once (uneven conferences get byes in the trailing weeks). Special weeks (Rival / Cross-Conf /
          Seeded) are a later refinement.
        </p>
        {playable.length === 0 ? (
          <Callout type="admin">
            No conference has 2+ teams yet — build the{" "}
            <Link href={`/admin/seasons/${enc}/draft`}>draft</Link> first.
          </Callout>
        ) : (
          <>
            <div className="grid grid-3">
              {setup.conferences.map((c) => (
                <div className="card" key={c.id} style={{ marginBottom: 0 }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{c.name}</span>
                    <span className="badge">{c.teams.length} teams</span>
                  </div>
                  <ol className="mt-2 list-none p-0" style={{ margin: 0 }}>
                    {c.teams.map((t) => (
                      <li key={t.id} className="flex items-baseline gap-2 py-0.5">
                        <span className="rank" style={{ width: "1.4rem" }}>{t.seed}</span>
                        <span>{t.name}</span>
                      </li>
                    ))}
                    {c.teams.length === 0 && <li className="sub">No teams</li>}
                  </ol>
                </div>
              ))}
            </div>
            <div className="card">
              <p className="sub">Plan: {setup.totalTeams} teams across {playable.length} conferences → {setup.weekCount} weeks.</p>
              <ActionFlashForm action={generateScheduleAction}>
                <input type="hidden" name="season" value={seasonName} />
                <SubmitButton pendingText="Generating…"><CalendarDays /> Generate schedule</SubmitButton>
              </ActionFlashForm>
            </div>
          </>
        )}
      </main>
    );
  }

  // ── Schedule exists → board ───────────────────────────────────────────────
  const board = await getSchedule(seasonName);
  if (!board) {
    return (
      <main>
        {back}
        <h1>Schedule</h1>
        <Callout type="danger">Schedule exists but couldn&apos;t be loaded.</Callout>
      </main>
    );
  }
  const totalMatchups = board.weeks.reduce((n, w) => n + w.matchups.length, 0);

  return (
    <main>
      {back}
      <h1>{seasonName} — Schedule</h1>
      <p className="sub">{board.weeks.length} weeks · {totalMatchups} matchups</p>

      {/* Soft weekly targets. A nudge the TO sets, never enforced -- blank = nothing shown. */}
      <div className="card">
        <div className="bracket-title">Weekly targets <span className="sub" style={{ fontWeight: 400 }}>(soft - a nudge, never enforced)</span></div>
        <p className="sub" style={{ marginTop: 0 }}>
          Set every week at once on a cadence (default: same time each week, e.g. Sunday 11:59 PM ET), then tweak any week
          below. Times are ET.
        </p>
        <ActionFlashForm action={applyCadenceAction}>
          <input type="hidden" name="season" value={seasonName} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="block"><span className="sub">Week 1 target (ET)</span><input type="datetime-local" name="first" className={dtInput} required /></label>
            <label className="block"><span className="sub">Every</span>
              <span className="inline-flex items-center gap-1"><input type="number" name="interval" min={1} defaultValue={7} className={`${dtInput} w-16`} /><span className="sub">days</span></span>
            </label>
            <SubmitButton size="sm" variant="secondary" pendingText="…">Set all weeks</SubmitButton>
          </div>
        </ActionFlashForm>
        <ActionFlashForm action={clearDeadlinesAction} className="mt-2">
          <input type="hidden" name="season" value={seasonName} />
          <SubmitButton size="sm" variant="secondary" pendingText="…">Clear all targets</SubmitButton>
        </ActionFlashForm>
      </div>

      {board.weeks.map((w) => (
        <div className="card" key={w.id} style={{ marginBottom: "0.75rem" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="bracket-title" style={{ padding: 0 }}>Week {w.number}</div>
              <span className="badge">{w.kind}</span>
              <DeadlineChip deadline={w.deadlineAt} />
            </div>
            <details>
              <summary
                className="pill inline-flex items-center gap-1"
                style={{ cursor: "pointer", border: "1px solid var(--accent)", color: "var(--accent)" }}
              >
                <Pencil className="size-3" /> Set deadline
              </summary>
              <ActionFlashForm action={setWeekDeadlineAction} className="mt-1">
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="week" value={w.number} />
                <div className="flex flex-wrap items-end gap-2">
                  <input type="datetime-local" name="deadline" defaultValue={w.deadlineAt ? utcToEtWall(w.deadlineAt) : ""} className={dtInput} />
                  <SubmitButton size="sm" variant="secondary" pendingText="…">Save</SubmitButton>
                  <span className="sub">(blank = clear)</span>
                </div>
              </ActionFlashForm>
            </details>
          </div>
          <table>
            <tbody>
              {w.matchups.map((m) => {
                const reported = m.setsWonA != null && m.setsWonB != null;
                return (
                  <tr key={m.id}>
                    <td>{m.aName}</td>
                    <td className="num" style={{ width: "5rem" }}>
                      {reported ? `${m.setsWonA}–${m.setsWonB}` : <span className="sub">vs</span>}
                    </td>
                    <td>{m.bName}</td>
                    <td className="sub">{m.conference}</td>
                    <td style={{ textAlign: "right" }}>
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <Link href={`/admin/matchups/${m.id}`}>Pair →</Link>
                        <CopyLinkButton path={`/overlay/matchup/${m.id}`} label="Overlay link" />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <div className="card card-danger" style={{ marginTop: "1.5rem" }}>
        <div className="bracket-title" style={{ padding: 0, color: "var(--danger)" }}>Danger zone</div>
        <p className="sub" style={{ marginTop: "0.25rem" }}>
          Deletes every week, matchup, and any sets played under them. This can&apos;t be undone.
        </p>
        <form action={resetScheduleAction} className="mt-2">
          <input type="hidden" name="season" value={seasonName} />
          <ConfirmButton
            message="Reset the schedule? This deletes every week, matchup, and any sets played under them."
            variant="destructive"
            size="sm"
          >
            Reset schedule
          </ConfirmButton>
        </form>
      </div>
    </main>
  );
}

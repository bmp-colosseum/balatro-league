import Link from "next/link";
import { ArrowLeft, CalendarDays } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getScheduleSetup, getSchedule } from "@/lib/services/schedule";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { generateScheduleAction, resetScheduleAction } from "./actions";

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1>{seasonName} — Schedule</h1>
        <form action={resetScheduleAction}>
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
      <p className="sub">{board.weeks.length} weeks · {totalMatchups} matchups</p>

      {board.weeks.map((w) => (
        <div className="card" key={w.id} style={{ marginBottom: "0.75rem" }}>
          <div className="flex items-center justify-between">
            <div className="bracket-title">Week {w.number}</div>
            <span className="badge">{w.kind}</span>
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
                      <Link href={`/admin/matchups/${m.id}`}>Pair →</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </main>
  );
}

import Link from "next/link";
import { ArrowLeft, Trophy } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getPlayoffAdmin } from "@/lib/services/playoffs";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { startPlayoffsAction, reportSeriesAction, resetPlayoffsAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function PlayoffsAdmin({ params }: { params: Promise<{ name: string }> }) {
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
  const data = await getPlayoffAdmin(seasonName);

  const back = (
    <p>
      <Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
    </p>
  );

  if (!data) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }

  // ── Not started → projected field + start ─────────────────────────────────
  if (!data.started) {
    const field = data.projected;
    return (
      <main>
        {back}
        <h1>Playoffs setup</h1>
        <p className="sub">Qualifies the top teams from the standings (auto-berths per conference + wildcards), seeds them overall, and builds the single-elim bracket.</p>
        {!field ? (
          <Callout type="admin">No standings yet — generate the schedule and report results first.</Callout>
        ) : !field.valid ? (
          <Callout type="admin">
            The standings produced {field.seeded.length} qualifiers — a single-elim bracket needs a 2/4/8-team field.
            Adjust the season&apos;s playoff field size.
          </Callout>
        ) : (
          <>
            <div className="card">
              <div className="bracket-title">Projected field ({field.seeded.length})</div>
              <table>
                <thead><tr><th className="rank">Seed</th><th>Team</th><th>Conference</th><th>Via</th></tr></thead>
                <tbody>
                  {field.seeded.map((q) => (
                    <tr key={q.teamSeasonId}>
                      <td className="rank">{q.seed}</td>
                      <td>{q.name}</td>
                      <td className="sub">{q.conference}</td>
                      <td className="sub">{q.viaWildcard ? "wildcard" : "berth"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="bracket-title">First-round matchups</div>
              <ul className="list-none p-0" style={{ margin: 0 }}>
                {data.pairings.map((p, i) => (
                  <li key={i} className="py-0.5">{p.a} <span className="muted">vs</span> {p.b}</li>
                ))}
              </ul>
            </div>
            <div className="card">
              <ActionFlashForm action={startPlayoffsAction}>
                <input type="hidden" name="season" value={seasonName} />
                <SubmitButton pendingText="Starting…"><Trophy /> Start playoffs</SubmitButton>
              </ActionFlashForm>
            </div>
          </>
        )}
      </main>
    );
  }

  // ── Started → live bracket ────────────────────────────────────────────────
  return (
    <main>
      {back}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1>{seasonName} — Playoffs</h1>
        <form action={resetPlayoffsAction}>
          <input type="hidden" name="season" value={seasonName} />
          <ConfirmButton message="Reset playoffs? Deletes the bracket + seeds and returns the season to REGULAR." variant="destructive" size="sm">
            Reset playoffs
          </ConfirmButton>
        </form>
      </div>

      {data.champion && (
        <Callout type="success">
          <Trophy className="mr-1 inline size-4 align-text-bottom" /> Champion: <strong>{data.champion}</strong>
        </Callout>
      )}

      {data.rounds.map((r) => (
        <div className="card" key={r.round} style={{ marginBottom: "0.75rem" }}>
          <div className="bracket-title">{r.label}</div>
          <table>
            <tbody>
              {r.series.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: s.winnerLabel === s.aLabel ? 700 : undefined }}>{s.aLabel}</td>
                  <td style={{ fontWeight: s.winnerLabel === s.bLabel ? 700 : undefined }}>{s.bLabel}</td>
                  <td className="num" style={{ width: "4rem" }}>
                    {s.decided ? `${s.scoreA}–${s.scoreB}` : <span className="sub">—</span>}
                  </td>
                  <td>
                    {s.aId && s.bId ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <ActionFlashForm action={reportSeriesAction}>
                          <input type="hidden" name="season" value={seasonName} />
                          <input type="hidden" name="seriesId" value={s.id} />
                          <span className="inline-flex items-center gap-1">
                            <input type="number" name="scoreA" min={0} defaultValue={s.scoreA ?? undefined} className="w-12 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1 py-0.5 text-center" />
                            <span className="sub">–</span>
                            <input type="number" name="scoreB" min={0} defaultValue={s.scoreB ?? undefined} className="w-12 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1 py-0.5 text-center" />
                            <SubmitButton size="sm" variant="secondary" pendingText="…">{s.decided ? "Update" : "Report"}</SubmitButton>
                          </span>
                        </ActionFlashForm>
                        <CopyLinkButton path={`/overlay/series/${s.id}`} label="Overlay link" />
                      </span>
                    ) : (
                      <span className="sub">awaiting teams</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </main>
  );
}

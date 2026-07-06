// Dry-run preview for reconstructing an imported season's matchups. Read-only: shows
// exactly which matchups would be built and their rolled-up scores, so a TO can confirm
// the numbers look right BEFORE committing the write. The Apply button runs the real
// buildMatchupsFromSets (same grouping logic, so preview == result).
import Link from "next/link";
import { ArrowLeft, ClipboardList } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { previewMatchupsFromSets } from "@/lib/services/reconcile";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { rebuildImportedMatchupsAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function RebuildPreview({ params }: { params: Promise<{ name: string }> }) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only {"—"} you don&apos;t have access.</Callout>
      </main>
    );
  }

  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);
  const preview = await previewMatchupsFromSets(seasonName);
  const { totals, matchups } = preview;

  const byWeek = new Map<number, typeof matchups>();
  for (const m of matchups) {
    const arr = byWeek.get(m.week) ?? [];
    arr.push(m);
    byWeek.set(m.week, arr);
  }

  return (
    <main>
      <p>
        <Link href={`/admin/seasons/${enc}/audit`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> audit</Link>
      </p>
      <h1 className="inline-flex items-center gap-2"><ClipboardList className="size-6" /> Rebuild preview {"—"} {seasonName}</h1>

      {totals.matchups === 0 ? (
        <Callout type="admin">No imported games to rebuild from {"—"} nothing to preview.</Callout>
      ) : (
        <>
          <Callout type="admin">
            <div style={{ marginBottom: "0.6rem" }}>
              This would build <strong>{totals.matchups} matchups</strong> across <strong>{totals.weeks} weeks</strong> from{" "}
              <strong>{totals.sets} imported sets</strong> ({totals.decided} decided, {totals.flipped} sets re-oriented).
              Nothing is written until you click Apply. It&apos;s idempotent {"—"} safe to run again.
            </div>
            <ActionFlashForm action={rebuildImportedMatchupsAction}>
              <input type="hidden" name="season" value={seasonName} />
              <SubmitButton pendingText="Rebuilding…"><ClipboardList /> Apply {"—"} build these matchups</SubmitButton>
            </ActionFlashForm>
          </Callout>

          {[...byWeek.entries()].sort((a, b) => a[0] - b[0]).map(([week, rows]) => (
            <div className="card" key={week} style={{ marginBottom: "0.75rem" }}>
              <div className="bracket-title">Week {week} <span className="sub">({rows.length} matchups)</span></div>
              <table>
                <thead>
                  <tr><th></th><th className="num">Sets</th><th></th><th className="num">Games</th><th></th></tr>
                </thead>
                <tbody>
                  {rows.map((m, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: m.winnerName === m.teamAName ? 700 : undefined }}>{m.teamAName}</td>
                      <td className="num" style={{ width: "4rem" }}>
                        {m.decided ? `${m.setsWonA}${"–"}${m.setsWonB}` : <span className="sub">{m.setsWonA}{"–"}{m.setsWonB}?</span>}
                      </td>
                      <td style={{ fontWeight: m.winnerName === m.teamBName ? 700 : undefined }}>{m.teamBName}</td>
                      <td className="num sub" style={{ width: "4rem" }}>{m.gamesWonA}{"–"}{m.gamesWonB}</td>
                      <td className="sub" style={{ textAlign: "right" }}>{m.setCount} sets{m.decided ? "" : " · not decided"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </main>
  );
}

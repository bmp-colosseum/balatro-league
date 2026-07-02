import Link from "next/link";
import { ArrowLeft, ListOrdered, Trash2, Pencil } from "lucide-react";
import { listSeasonRankings, rankingPool } from "@/lib/services/rankings";
import { can, seasonIdByName } from "@/lib/permissions";
import { NoAccess } from "@/components/NoAccess";
import { FormSelect } from "@/components/FormSelect";
import { ConfirmButton } from "@/components/ConfirmButton";
import { createRankingAction, deleteRankingAction } from "./actions";

export const dynamic = "force-dynamic";

const inputCls = "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1";

export default async function RankingsAdmin({ params }: { params: Promise<{ name: string }> }) {
  const seasonName = decodeURIComponent((await params).name);
  if (!(await can("RANKINGS", { seasonId: await seasonIdByName(seasonName) }))) return <NoAccess what="manage power rankings" />;
  const enc = encodeURIComponent(seasonName);
  const [rankings, pool] = await Promise.all([listSeasonRankings(seasonName), rankingPool(seasonName)]);

  return (
    <main>
      <p><Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link></p>
      <h1 className="flex items-center gap-2"><ListOrdered className="size-5" /> Power rankings</h1>
      <p className="sub">Rank teams or players (with optional tiers), attributed to whoever made them, tagged to a week. Create one, then add its entries.</p>

      <div className="card">
        <div className="bracket-title">New ranking</div>
        <form action={createRankingAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="season" value={seasonName} />
          <label className="block"><span className="sub">Kind</span><FormSelect name="kind" options={[{ value: "TEAM", label: "Teams" }, { value: "PLAYER", label: "Players" }]} /></label>
          <label className="block"><span className="sub">Week</span><input type="number" name="week" min={1} placeholder="opt" className={`${inputCls} w-16`} /></label>
          <label className="block"><span className="sub">Date</span><input type="date" name="postedAt" className={`${inputCls} w-40`} /></label>
          <label className="block flex-1" style={{ minWidth: 200 }}><span className="sub">Title</span><input name="title" placeholder="Week 3 Team Power Rankings" className={`${inputCls} w-full`} /></label>
          <label className="block"><span className="sub">Author</span><input name="author" placeholder="TTNN" className={`${inputCls} w-28`} /></label>
          <label className="block"><span className="sub">Author profile (opt)</span><FormSelect name="authorPlayerId" options={[{ value: "", label: "— none —" }, ...pool.players.map((p) => ({ value: p.id, label: p.name }))]} /></label>
          <button type="submit" className="rounded bg-[var(--accent-2)] px-3 py-1.5 text-sm text-white">Create + add entries</button>
        </form>
      </div>

      {rankings.length === 0 ? (
        <p className="sub mt-4">No rankings yet.</p>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Title</th><th>Kind</th><th className="num">Week</th><th className="num">Entries</th><th></th></tr></thead>
            <tbody>
              {rankings.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/admin/seasons/${enc}/rankings/${r.id}`}>{r.title}</Link>{r.author ? <span className="sub"> · {r.author}</span> : ""}</td>
                  <td className="sub">{r.kind === "TEAM" ? "Teams" : "Players"}</td>
                  <td className="num">{r.week ?? "—"}</td>
                  <td className="num">{r.entries.length}</td>
                  <td style={{ textAlign: "right" }} className="flex items-center justify-end gap-1">
                    <Link href={`/admin/seasons/${enc}/rankings/${r.id}`} className="inline-flex items-center gap-1 text-sm"><Pencil className="size-3.5" /> Edit</Link>
                    <form action={deleteRankingAction} className="inline">
                      <input type="hidden" name="season" value={seasonName} />
                      <input type="hidden" name="id" value={r.id} />
                      <ConfirmButton message={`Delete "${r.title}"?`} variant="destructive" size="sm"><Trash2 className="size-3.5" /></ConfirmButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

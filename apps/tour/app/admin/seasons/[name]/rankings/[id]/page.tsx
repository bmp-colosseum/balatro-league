import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { listSeasonRankings, rankingPool } from "@/lib/services/rankings";
import { can, seasonIdByName } from "@/lib/permissions";
import { NoAccess } from "@/components/NoAccess";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { FormSelect } from "@/components/FormSelect";
import { updateRankingAction, addEntryAction, removeEntryAction } from "../actions";

export const dynamic = "force-dynamic";

const inputCls = "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1";
const toDateInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default async function RankingEdit({ params }: { params: Promise<{ name: string; id: string }> }) {
  const { name, id } = await params;
  const seasonName = decodeURIComponent(name);
  if (!(await can("RANKINGS", { seasonId: await seasonIdByName(seasonName) }))) return <NoAccess what="manage power rankings" />;
  const enc = encodeURIComponent(seasonName);
  const [all, pool] = await Promise.all([listSeasonRankings(seasonName), rankingPool(seasonName)]);
  const r = all.find((x) => x.id === id);
  if (!r) notFound();
  const targetOpts = r.kind === "TEAM" ? pool.teams : pool.players;

  return (
    <main>
      <p><Link href={`/admin/seasons/${enc}/rankings`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> rankings</Link></p>
      <h1>{r.title}</h1>
      <p className="sub">{r.kind === "TEAM" ? "Team" : "Player"} ranking{r.week != null ? ` · week ${r.week}` : ""}{r.author ? ` · ${r.author}` : ""}</p>

      {/* Meta */}
      <div className="card">
        <div className="bracket-title">Details</div>
        <ActionFlashForm action={updateRankingAction}>
          <input type="hidden" name="season" value={seasonName} />
          <input type="hidden" name="id" value={r.id} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="block"><span className="sub">Week</span><input type="number" name="week" min={1} defaultValue={r.week ?? undefined} className={`${inputCls} w-16`} /></label>
            <label className="block"><span className="sub">Date</span><input type="date" name="postedAt" defaultValue={toDateInput(r.postedAt)} className={`${inputCls} w-40`} /></label>
            <label className="block flex-1" style={{ minWidth: 200 }}><span className="sub">Title</span><input name="title" defaultValue={r.title} className={`${inputCls} w-full`} /></label>
            <label className="block"><span className="sub">Author</span><input name="author" defaultValue={r.author ?? ""} className={`${inputCls} w-28`} /></label>
            <label className="block"><span className="sub">Author profile</span><FormSelect name="authorPlayerId" options={[{ value: "", label: "— none —" }, ...pool.players.map((p) => ({ value: p.id, label: p.name }))]} /></label>
            <SubmitButton size="sm" variant="secondary" pendingText="…">Save</SubmitButton>
          </div>
        </ActionFlashForm>
      </div>

      {/* Add entry */}
      <div className="card">
        <div className="bracket-title">Add {r.kind === "TEAM" ? "team" : "player"}</div>
        <ActionFlashForm action={addEntryAction}>
          <input type="hidden" name="season" value={seasonName} />
          <input type="hidden" name="rankingId" value={r.id} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="block"><span className="sub">#</span><input type="number" name="position" min={1} placeholder="auto" className={`${inputCls} w-16`} /></label>
            <label className="block"><span className="sub">Tier</span><input name="tier" placeholder="S / A / 1" className={`${inputCls} w-16`} /></label>
            <label className="block"><span className="sub">{r.kind === "TEAM" ? "Team" : "Player"}</span><FormSelect name="targetId" options={[{ value: "", label: "— select —" }, ...targetOpts.map((t) => ({ value: t.id, label: t.name }))]} /></label>
            <label className="block flex-1" style={{ minWidth: 200 }}><span className="sub">Note (opt)</span><input name="note" placeholder="blurb" className={`${inputCls} w-full`} /></label>
            <SubmitButton size="sm" pendingText="…">Add</SubmitButton>
          </div>
        </ActionFlashForm>
      </div>

      {/* Entries */}
      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th className="num">#</th><th>Tier</th><th>{r.kind === "TEAM" ? "Team" : "Player"}</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {r.entries.length === 0 ? (
              <tr><td colSpan={5} className="sub">No entries yet — add above.</td></tr>
            ) : (
              r.entries.map((e) => (
                <tr key={e.id}>
                  <td className="num">{e.position}</td>
                  <td>{e.tier ? <span className="badge">{e.tier}</span> : ""}</td>
                  <td>{e.name}</td>
                  <td className="sub">{e.note ?? ""}</td>
                  <td style={{ textAlign: "right" }}>
                    <form action={removeEntryAction} className="inline">
                      <input type="hidden" name="season" value={seasonName} />
                      <input type="hidden" name="rankingId" value={r.id} />
                      <input type="hidden" name="entryId" value={e.id} />
                      <ConfirmButton message="Remove this entry?" variant="destructive" size="sm"><Trash2 className="size-3.5" /></ConfirmButton>
                    </form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

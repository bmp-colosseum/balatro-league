import Link from "next/link";
import { ArrowLeft, Newspaper, Trash2, Pencil } from "lucide-react";
import { listSeasonNews } from "@/lib/services/news";
import { can, seasonIdByName } from "@/lib/permissions";
import { NoAccess } from "@/components/NoAccess";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { createNewsAction, updateNewsAction, deleteNewsAction } from "./actions";

export const dynamic = "force-dynamic";

const inputCls = "w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1";
const toDateInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// Gate + admin shell come from app/admin/layout.tsx.
export default async function NewsAdmin({ params }: { params: Promise<{ name: string }> }) {
  const seasonName = decodeURIComponent((await params).name);
  if (!(await can("NEWS", { seasonId: await seasonIdByName(seasonName) }))) return <NoAccess what="manage news" />;
  const enc = encodeURIComponent(seasonName);
  const posts = await listSeasonNews(seasonName);

  return (
    <main>
      <p><Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link></p>
      <h1 className="flex items-center gap-2"><Newspaper className="size-5" /> News Network</h1>
      <p className="sub">Previews, recaps, power rankings for {seasonName}. Paste from Discord — line breaks are kept. Leave the week blank for a season-wide post.</p>

      {/* New post */}
      <div className="card">
        <div className="bracket-title">New post</div>
        <ActionFlashForm action={createNewsAction}>
          <input type="hidden" name="season" value={seasonName} />
          <div className="flex flex-wrap items-end gap-2 mb-2">
            <label className="block"><span className="sub">Week (optional)</span><input type="number" name="week" min={1} className={`${inputCls} w-20`} /></label>
            <label className="block"><span className="sub">Date</span><input type="date" name="postedAt" className={`${inputCls} w-40`} /></label>
            <label className="block flex-1" style={{ minWidth: 240 }}><span className="sub">Title</span><input name="title" placeholder="Week 3 previews — Sock Conference" className={inputCls} /></label>
          </div>
          <label className="block mb-1"><span className="sub">Body</span><textarea name="body" rows={10} className={inputCls} placeholder="Paste the writeup here (Markdown supported)" /></label>
          <p className="sub mb-2" style={{ fontSize: "0.8rem" }}>Markdown supported: **bold**, *italic*, ~~strike~~, `code`, &gt; quotes, and - lists. Paste straight from Discord. Leave the date blank for today, or set it to keep an archival post&apos;s original date.</p>
          <SubmitButton pendingText="Posting…">Post</SubmitButton>
        </ActionFlashForm>
      </div>

      {/* Existing posts */}
      {posts.length === 0 ? (
        <p className="sub mt-4">No posts yet.</p>
      ) : (
        posts.map((p) => (
          <div className="card" key={p.id}>
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold flex items-center gap-2">{p.week != null && <span className="badge">Wk {p.week}</span>}{p.title}<span className="sub" style={{ fontWeight: 400 }}>· {fmtDate(p.postedAt)}</span></div>
              <form action={deleteNewsAction}>
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="id" value={p.id} />
                <ConfirmButton message={`Delete "${p.title}"?`} variant="destructive" size="sm"><Trash2 className="size-3.5" /></ConfirmButton>
              </form>
            </div>
            <details className="mt-2">
              <summary className="sub" style={{ cursor: "pointer" }}><Pencil className="size-3.5 inline" /> Edit</summary>
              <ActionFlashForm action={updateNewsAction} className="mt-2">
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="id" value={p.id} />
                <div className="flex flex-wrap items-end gap-2 mb-2">
                  <label className="block"><span className="sub">Week</span><input type="number" name="week" min={1} defaultValue={p.week ?? undefined} className={`${inputCls} w-20`} /></label>
                  <label className="block"><span className="sub">Date</span><input type="date" name="postedAt" defaultValue={toDateInput(p.postedAt)} className={`${inputCls} w-40`} /></label>
                  <label className="block flex-1" style={{ minWidth: 240 }}><span className="sub">Title</span><input name="title" defaultValue={p.title} className={inputCls} /></label>
                </div>
                <label className="block mb-2"><span className="sub">Body</span><textarea name="body" rows={10} defaultValue={p.body} className={inputCls} /></label>
                <SubmitButton size="sm" variant="secondary" pendingText="Saving…">Save</SubmitButton>
              </ActionFlashForm>
            </details>
          </div>
        ))
      )}
    </main>
  );
}

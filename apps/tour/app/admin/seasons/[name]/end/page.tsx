import Link from "next/link";
import { ArrowLeft, Trophy, X, Award as AwardIcon } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonEnd } from "@/lib/services/season-end";
import { AWARD_KINDS, AWARD_KIND_LABEL } from "@/lib/awards";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Input } from "@/components/ui/input";
import { crownChampionAction, uncrownChampionAction, createAwardAction, addRecipientAction, removeRecipientAction, removeAwardAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function SeasonEndAdmin({ params }: { params: Promise<{ name: string }> }) {
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
  const data = await getSeasonEnd(seasonName);

  if (!data) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }

  return (
    <main>
      <p>
        <Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
      </p>
      <h1>Season end</h1>
      <p className="sub">Crown the playoff champion and record the season&apos;s awards. Crowning marks the season DONE.</p>

      {/* Champion */}
      <div className="card">
        <div className="bracket-title">Champion</div>
        {data.crowned ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Callout type="success">
              <Trophy className="mr-1 inline size-4 align-text-bottom" /> <strong>{data.championTeamName}</strong> — crowned · season {data.state}
            </Callout>
            <form action={uncrownChampionAction}>
              <input type="hidden" name="season" value={seasonName} />
              <ConfirmButton message="Uncrown the champion and return the season to PLAYOFFS?" variant="destructive" size="sm">
                Uncrown
              </ConfirmButton>
            </form>
          </div>
        ) : data.finalDecided ? (
          <>
            <p className="sub">Final winner: <strong>{data.championTeamName}</strong>. Crown to record the championship + finish the season.</p>
            <ActionFlashForm action={crownChampionAction}>
              <input type="hidden" name="season" value={seasonName} />
              <SubmitButton pendingText="Crowning…"><Trophy /> Crown champion</SubmitButton>
            </ActionFlashForm>
          </>
        ) : (
          <Callout type="admin">
            No decided final yet — finish the{" "}
            <Link href={`/admin/seasons/${enc}/playoffs`}>playoff bracket</Link> first.
          </Callout>
        )}
      </div>

      {/* Awards */}
      <div className="card">
        <div className="bracket-title flex items-center gap-2"><AwardIcon className="size-4" /> Awards</div>
        {data.awards.length === 0 ? (
          <p className="sub" style={{ marginTop: 0 }}>No awards recorded yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {data.awards.map((a) => (
              <div key={a.id} className="rounded border border-[var(--border)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">{a.label}</div>
                    {a.description && <div className="sub" style={{ marginTop: 2 }}>{a.description}</div>}
                  </div>
                  <form action={removeAwardAction}>
                    <input type="hidden" name="season" value={seasonName} />
                    <input type="hidden" name="awardId" value={a.id} />
                    <ConfirmButton message={`Remove the "${a.label}" award and its recipients?`} variant="destructive" size="sm"><X className="size-3.5" /></ConfirmButton>
                  </form>
                </div>

                <div className="mt-2 flex flex-wrap gap-2">
                  {a.recipients.length === 0 && <span className="sub">No recipients yet - add one below.</span>}
                  {a.recipients.map((r, i) => {
                    const who = r.player ?? r.team ?? "-";
                    return (
                      <span key={r.id ?? i} className="badge inline-flex items-center gap-1.5">
                        {who}{r.note ? ` (${r.note})` : ""}
                        {r.id && (
                          <form action={removeRecipientAction} className="inline">
                            <input type="hidden" name="season" value={seasonName} />
                            <input type="hidden" name="recipientId" value={r.id} />
                            <button type="submit" className="opacity-70 hover:opacity-100" title="Remove recipient"><X className="size-3" /></button>
                          </form>
                        )}
                      </span>
                    );
                  })}
                </div>

                <form action={addRecipientAction} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="season" value={seasonName} />
                  <input type="hidden" name="awardId" value={a.id} />
                  <label className="block">
                    <span className="sub">Player</span>
                    <FormSelect name="playerId" options={[{ value: "", label: "- none -" }, ...data.playerOptions.map((p) => ({ value: p.id, label: p.name }))]} placeholder="- none -" size="sm" />
                  </label>
                  <label className="block">
                    <span className="sub">or Team</span>
                    <FormSelect name="teamId" options={[{ value: "", label: "- none -" }, ...data.teamOptions.map((t) => ({ value: t.teamId, label: t.name }))]} placeholder="- none -" size="sm" />
                  </label>
                  <label className="block">
                    <span className="sub">Note</span>
                    <Input name="note" placeholder="optional" maxLength={40} className="w-36" />
                  </label>
                  <SubmitButton size="sm" variant="secondary" pendingText="Adding...">Add slot</SubmitButton>
                </form>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <div className="sub" style={{ marginBottom: 6 }}>Create an award</div>
          <ActionFlashForm action={createAwardAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="season" value={seasonName} />
            <label className="block">
              <span className="sub">Preset</span>
              <FormSelect name="kind" defaultValue="MVP" options={[{ value: "", label: "Custom (use title)" }, ...AWARD_KINDS.map((k) => ({ value: k, label: AWARD_KIND_LABEL[k] ?? k }))]} triggerClassName="w-52" />
            </label>
            <label className="block">
              <span className="sub">Title (for custom)</span>
              <Input name="title" placeholder="e.g. All-Tournament Team" maxLength={60} className="w-56" />
            </label>
            <label className="block">
              <span className="sub">Description</span>
              <Input name="description" placeholder="optional blurb" maxLength={200} className="w-64" />
            </label>
            <SubmitButton pendingText="Creating...">Create award</SubmitButton>
          </ActionFlashForm>
          <p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>Pick a preset, or leave it on Custom and give a title. Then add recipient slots above.</p>
        </div>
      </div>
    </main>
  );
}

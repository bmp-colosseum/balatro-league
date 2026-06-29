import Link from "next/link";
import { ArrowLeft, Trophy, X } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonEnd, AWARD_KINDS } from "@/lib/services/season-end";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { crownChampionAction, uncrownChampionAction, addAwardAction, removeAwardAction } from "./actions";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  MVP: "MVP",
  ROOKIE: "Rookie of the Season",
  COMEBACK: "Comeback Player",
  CAPTAIN: "Captain of the Season",
  MOST_IMPROVED: "Most Improved",
  BEST_SET: "Best Set",
  BIGGEST_STEAL: "Biggest Steal",
};

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
        <div className="bracket-title">Awards</div>
        {data.awards.length > 0 ? (
          <table>
            <thead><tr><th>Award</th><th>Winner</th><th></th></tr></thead>
            <tbody>
              {data.awards.map((a) => (
                <tr key={a.id}>
                  <td>{a.label}</td>
                  <td>{a.player ?? a.team ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <form action={removeAwardAction}>
                      <input type="hidden" name="season" value={seasonName} />
                      <input type="hidden" name="awardId" value={a.id} />
                      <SubmitButton size="sm" variant="secondary" pendingText="…"><X className="size-3.5" /></SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="sub">No awards recorded yet.</p>
        )}

        <ActionFlashForm action={addAwardAction}>
          <input type="hidden" name="season" value={seasonName} />
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="sub">Award</span>
              <FormSelect name="kind" options={AWARD_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] ?? k }))} defaultValue="MVP" />
            </label>
            <label className="block">
              <span className="sub">Player</span>
              <FormSelect name="playerId" options={[{ value: "", label: "— none —" }, ...data.playerOptions.map((p) => ({ value: p.id, label: p.name }))]} placeholder="— none —" />
            </label>
            <label className="block">
              <span className="sub">or Team</span>
              <FormSelect name="teamId" options={[{ value: "", label: "— none —" }, ...data.teamOptions.map((t) => ({ value: t.teamId, label: t.name }))]} placeholder="— none —" />
            </label>
            <SubmitButton variant="secondary" pendingText="Adding…">Add award</SubmitButton>
          </div>
        </ActionFlashForm>
      </div>
    </main>
  );
}

import Link from "next/link";
import { ArrowLeft, Crown } from "lucide-react";
import { getSeasonDraft } from "@/lib/draft-history";
import { PlayerName } from "@/components/PlayerName";

export const dynamic = "force-dynamic";

export default async function SeasonDraft({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);
  const draft = await getSeasonDraft(seasonName);

  if (!draft) {
    return (
      <main>
        <p><Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link></p>
        <h1>Draft</h1>
        <p className="sub">No draft on record for {seasonName}.</p>
      </main>
    );
  }

  // Teams are rows (in draft order = seed); rounds are columns. Snake order: odd rounds pick
  // top→bottom (seed 1 first), even rounds bottom→top, so the overall pick # zig-zags.
  const teams = draft.teams;
  const T = teams.length;
  const rounds = Array.from({ length: draft.rounds }, (_, i) => i + 1);
  const overall = (ti: number, round: number) => (round - 1) * T + (round % 2 === 1 ? ti + 1 : T - ti);

  return (
    <main>
      <p><Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link></p>
      <h1>{seasonName} — Draft board</h1>
      <p className="sub">{T} teams · {draft.rounds} rounds · snake order. Seed 1 is the captain; the small number is the overall pick. Hover a name to see it in full.</p>

      <div className="card" style={{ padding: 0 }}>
        <div className="draftboard-wrap">
          <table className="draftboard">
            <thead>
              <tr>
                <th className="c-seed">#</th>
                <th className="c-team">Team</th>
                <th className="c-capt"><span className="inline-flex items-center gap-1"><Crown className="size-3.5 text-[var(--accent)]" /> Captain</span></th>
                {rounds.map((r) => (
                  <th key={r}>R{r}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {teams.map((t, ti) => (
                <tr key={t.teamSeasonId}>
                  <td className="c-seed rank">{t.seed}</td>
                  <td className="c-team" title={`${t.teamName} · ${t.conference}`}>
                    <Link href={`/teams/${t.teamSeasonId}`} className="font-semibold">{t.teamName}</Link>
                    <div className="sub" style={{ fontWeight: 400, fontSize: "0.85em", overflow: "hidden", textOverflow: "ellipsis" }}>{t.conference}</div>
                  </td>
                  <td className="c-capt" title={t.captainName ?? undefined}>
                    <PlayerName id={t.captainId} name={t.captainName} discordId={t.captainDiscordId} className="font-semibold" />
                  </td>
                  {rounds.map((r) => {
                    const pick = t.picks.find((p) => p.round === r);
                    return (
                      <td key={r} title={pick?.name ?? undefined}>
                        {pick ? (
                          <>
                            <span className="pickno">{overall(ti, r)}</span>
                            <PlayerName id={pick.playerId} name={pick.name} discordId={pick.discordId} />
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

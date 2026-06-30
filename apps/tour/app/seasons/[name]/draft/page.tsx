import Link from "next/link";
import { ArrowLeft, Crown } from "lucide-react";
import { getSeasonDraft } from "@/lib/draft-history";

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

  return (
    <main>
      <p><Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link></p>
      <h1>{seasonName} — Draft</h1>
      <p className="sub">{draft.teams.length} teams · {draft.rounds} rounds. Captains are seed 1; picks are in draft order.</p>

      <div className="grid grid-3">
        {draft.teams.map((t) => (
          <div className="card" key={t.teamSeasonId} style={{ marginBottom: 0 }}>
            <div className="flex items-center justify-between gap-2">
              <Link href={`/teams/${t.teamSeasonId}`} className="font-semibold">{t.teamName}</Link>
              <span className="badge">{t.conference}</span>
            </div>
            <ol className="mt-2 list-none p-0" style={{ margin: 0 }}>
              <li className="flex items-baseline gap-2 py-0.5">
                <span className="rank" style={{ width: "1.4rem" }}>C</span>
                <Crown className="size-3.5 shrink-0 text-[var(--accent)]" />
                <span className="font-semibold"><Link href={`/players/${t.captainId}`}>{t.captainName}</Link></span>
              </li>
              {t.picks.map((p) => (
                <li key={p.round} className="flex items-baseline gap-2 py-0.5">
                  <span className="rank" style={{ width: "1.4rem" }}>{p.round}</span>
                  <Link href={`/players/${p.playerId}`}>{p.name}</Link>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </main>
  );
}

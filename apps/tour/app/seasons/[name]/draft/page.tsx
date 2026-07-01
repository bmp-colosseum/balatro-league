import Link from "next/link";
import { ArrowLeft, Crown, ArrowRight, ArrowLeft as ArrowLeftIcon } from "lucide-react";
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

  // Columns = teams in draft order (by seed). Snake: odd rounds L→R, even rounds reverse,
  // so the overall pick number zig-zags down the board.
  const teams = draft.teams;
  const T = teams.length;
  const rounds = Array.from({ length: draft.rounds }, (_, i) => i + 1);
  const pickByTeamRound = (ti: number, round: number) => teams[ti].picks.find((p) => p.round === round) ?? null;
  const overall = (ti: number, round: number) => (round - 1) * T + (round % 2 === 1 ? ti + 1 : T - ti);

  const thBase: React.CSSProperties = { padding: "6px 10px", textAlign: "left", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
  const stickyCol: React.CSSProperties = { position: "sticky", left: 0, background: "var(--surface)", zIndex: 1 };
  const cell: React.CSSProperties = { padding: "5px 10px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", verticalAlign: "top" };

  return (
    <main>
      <p><Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link></p>
      <h1>{seasonName} — Draft board</h1>
      <p className="sub">{T} teams · {draft.rounds} rounds · snake order. Captains (seed 1) are pre-assigned; each cell shows the pick and its overall number. Odd rounds run left→right, even rounds reverse.</p>

      <div className="card" style={{ overflowX: "auto", padding: 0 }}>
        <table style={{ borderCollapse: "collapse", width: "max-content", minWidth: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...thBase, ...stickyCol, zIndex: 2 }}>Round</th>
              {teams.map((t) => (
                <th key={t.teamSeasonId} style={thBase}>
                  <Link href={`/teams/${t.teamSeasonId}`}>{t.teamName}</Link>
                  <div className="sub" style={{ fontWeight: 400 }}>#{t.seed} · {t.conference}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Captains */}
            <tr>
              <th style={{ ...cell, ...stickyCol, fontWeight: 600 }}>
                <span className="inline-flex items-center gap-1"><Crown className="size-3.5 text-[var(--accent)]" /> C</span>
              </th>
              {teams.map((t) => (
                <td key={t.teamSeasonId} style={{ ...cell, background: "rgba(241, 196, 15, 0.06)" }}>
                  <Link href={`/players/${t.captainId}`} className="font-semibold">{t.captainName}</Link>
                </td>
              ))}
            </tr>
            {/* Snake rounds */}
            {rounds.map((r) => {
              const ltr = r % 2 === 1;
              return (
                <tr key={r}>
                  <th style={{ ...cell, ...stickyCol }}>
                    <span className="inline-flex items-center gap-1">
                      {r}
                      {ltr ? <ArrowRight className="size-3 text-[var(--muted)]" /> : <ArrowLeftIcon className="size-3 text-[var(--muted)]" />}
                    </span>
                  </th>
                  {teams.map((t, ti) => {
                    const pick = pickByTeamRound(ti, r);
                    return (
                      <td key={t.teamSeasonId} style={cell}>
                        {pick ? (
                          <span className="inline-flex items-baseline gap-1.5">
                            <span className="sub num" style={{ minWidth: "1.7rem" }}>{overall(ti, r)}.</span>
                            <Link href={`/players/${pick.playerId}`}>{pick.name}</Link>
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}

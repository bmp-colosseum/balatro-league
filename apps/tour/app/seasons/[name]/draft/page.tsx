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

  // Teams are rows (in draft order = seed); rounds are columns. Snake order: odd rounds pick
  // top→bottom (seed 1 first), even rounds bottom→top, so the overall pick # zig-zags.
  const teams = draft.teams;
  const T = teams.length;
  const rounds = Array.from({ length: draft.rounds }, (_, i) => i + 1);
  const overall = (ti: number, round: number) => (round - 1) * T + (round % 2 === 1 ? ti + 1 : T - ti);

  const th: React.CSSProperties = { padding: "6px 8px", textAlign: "left", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "5px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
  const seedCol: React.CSSProperties = { position: "sticky", left: 0, width: 40, textAlign: "center", background: "var(--surface)", zIndex: 1 };
  const teamCol: React.CSSProperties = { position: "sticky", left: 40, background: "var(--surface)", zIndex: 1, boxShadow: "1px 0 0 var(--border)" };
  const pickNo: React.CSSProperties = { fontSize: "0.7rem", color: "var(--muted)", marginRight: 5, fontVariantNumeric: "tabular-nums" };

  return (
    <main>
      <p><Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link></p>
      <h1>{seasonName} — Draft board</h1>
      <p className="sub">{T} teams · {draft.rounds} rounds · snake order. Seed 1 is the captain; the small number is the overall pick.</p>

      <div className="card" style={{ overflowX: "auto", padding: 0 }}>
        <table style={{ borderCollapse: "collapse", width: "max-content", minWidth: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...th, ...seedCol, zIndex: 2 }}>#</th>
              <th style={{ ...th, ...teamCol, zIndex: 2 }}>Team</th>
              <th style={th}><span className="inline-flex items-center gap-1"><Crown className="size-3.5 text-[var(--accent)]" /> Captain</span></th>
              {rounds.map((r) => (
                <th key={r} style={th}>R{r}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {teams.map((t, ti) => (
              <tr key={t.teamSeasonId}>
                <td style={{ ...td, ...seedCol }} className="rank">{t.seed}</td>
                <td style={{ ...td, ...teamCol }}>
                  <Link href={`/teams/${t.teamSeasonId}`} className="font-semibold">{t.teamName}</Link>
                  <div className="sub" style={{ fontWeight: 400 }}>{t.conference}</div>
                </td>
                <td style={{ ...td, background: "rgba(241, 196, 15, 0.06)" }}>
                  <Link href={`/players/${t.captainId}`} className="font-semibold">{t.captainName}</Link>
                </td>
                {rounds.map((r) => {
                  const pick = t.picks.find((p) => p.round === r);
                  return (
                    <td key={r} style={td}>
                      {pick ? (
                        <span className="inline-flex items-baseline">
                          <span style={pickNo}>{overall(ti, r)}</span>
                          <Link href={`/players/${pick.playerId}`}>{pick.name}</Link>
                        </span>
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
    </main>
  );
}

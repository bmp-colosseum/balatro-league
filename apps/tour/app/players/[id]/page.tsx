import Link from "next/link";
import { ArrowLeft, Trophy, Award, ExternalLink } from "lucide-react";
import { getPlayer, getPlayerCareerStat } from "@/lib/stats";

const LEAGUE_URL = process.env.NEXT_PUBLIC_LEAGUE_URL || "https://balatroleague.com";
import { getPlayerDrafts } from "@/lib/draft-history";
import { getPlayerAwards } from "@/lib/awards";
import { SetPctChart, type SetPctPoint } from "@/components/SetPctChart";
import { H2HTable } from "@/components/H2HTable";

export const dynamic = "force-dynamic";

const pct = (w: number, l: number) => (w + l ? `${((100 * w) / (w + l)).toFixed(1)}%` : "—");
const seasonNum = (name: string) => Number(name.match(/(\d+)/)?.[1] ?? 0);
const shortSeason = (name: string) => name.replace(/^Team Tour\s*/i, "TT").replace(/\s+/g, " ").trim();

export default async function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [p, drafts, awards, career] = await Promise.all([
    getPlayer(id),
    getPlayerDrafts(id),
    getPlayerAwards(id),
    getPlayerCareerStat(id),
  ]);
  const draftBySeason = new Map(drafts.map((d) => [d.season, d]));

  if (!p) {
    return (
      <main>
        <p>
          <Link href="/players" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> leaderboard</Link>
        </p>
        <h1>Player not found</h1>
      </main>
    );
  }

  const chartData: SetPctPoint[] = [...p.perSeason]
    .sort((a, b) => seasonNum(a.seasonName) - seasonNum(b.seasonName))
    .map((s) => ({
      season: shortSeason(s.seasonName),
      full: s.seasonName,
      setPct: s.setW + s.setL ? (100 * s.setW) / (s.setW + s.setL) : 0,
      record: `${s.setW}–${s.setL}`,
    }));

  return (
    <main>
      <p>
        <Link href="/players">← leaderboard</Link>
      </p>
      <h1 className="flex items-center gap-2">
        {p.name}
        {p.rings > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[var(--accent)]" title={`${p.rings}× champion`}>
            {Array.from({ length: p.rings }).map((_, i) => (
              <Trophy key={i} className="size-4" />
            ))}
          </span>
        )}
      </h1>
      {!p.discordId.startsWith("legacy:") && (
        <p className="sub">
          <a href={`${LEAGUE_URL}/u/${p.discordId}`} className="inline-flex items-center gap-1">
            <ExternalLink className="size-3.5" /> View on Balatro League
          </a>
        </p>
      )}
      <div className="grid grid-3 mb-4">
        <div className="stat">
          <div className="label">Seasons</div>
          <div className="value">{p.seasons}</div>
        </div>
        <div className="stat">
          <div className="label">Rings</div>
          <div className="value">{p.rings}</div>
        </div>
        <div className="stat">
          <div className="label">Set record</div>
          <div className="value">{p.setW}–{p.setL}</div>
          <div className="muted">{pct(p.setW, p.setL)} win</div>
        </div>
        <div className="stat">
          <div className="label">Game record</div>
          <div className="value">{p.gameW}–{p.gameL}</div>
          <div className="muted">{pct(p.gameW, p.gameL)} win</div>
        </div>
        {career && (
          <>
            <div className="stat">
              <div className="label">Finals made</div>
              <div className="value">{career.finalsMade}</div>
            </div>
            <div className="stat">
              <div className="label">Playoffs made</div>
              <div className="value">{career.playoffsMade}</div>
            </div>
            <div className="stat">
              <div className="label">Avg seed</div>
              <div className="value">{career.avgSeed != null ? career.avgSeed.toFixed(1) : "—"}</div>
            </div>
          </>
        )}
      </div>
      {awards.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {awards.map((a, i) => (
            <span key={i} className="badge inline-flex items-center gap-1" style={{ color: "var(--accent)", borderColor: "var(--accent)" }}>
              <Award className="size-3.5" /> {a.label} · {shortSeason(a.season)}
            </span>
          ))}
        </div>
      )}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Season</th>
              <th>Team</th>
              <th className="num">Draft</th>
              <th className="num">Sets</th>
              <th className="num">Set %</th>
              <th className="num">Games</th>
              <th className="num">Game %</th>
            </tr>
          </thead>
          <tbody>
            {p.perSeason.map((s) => {
              const d = draftBySeason.get(s.seasonName);
              return (
              <tr key={s.seasonName}>
                <td>{s.seasonName}</td>
                <td>{s.teamName}</td>
                <td className="num">
                  {d ? (d.isCaptain ? <span className="text-[var(--accent)]" title="Captain">C</span> : `R${d.round}`) : "—"}
                </td>
                <td className="num">
                  {s.setW}–{s.setL}
                </td>
                <td className="num">{pct(s.setW, s.setL)}</td>
                <td className="num">
                  {s.gameW}–{s.gameL}
                </td>
                <td className="num">{pct(s.gameW, s.gameL)}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <SetPctChart data={chartData} />

      {p.h2h.length > 0 && (
        <>
          <h2 className="mt-6 mb-2 text-[1.1rem]">
            Head-to-head <span className="sub">· {p.h2h.length} opponents</span>
          </h2>
          <H2HTable rows={p.h2h} />
        </>
      )}
    </main>
  );
}

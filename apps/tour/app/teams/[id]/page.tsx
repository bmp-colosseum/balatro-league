import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getTeamSeason, getTeamPlacement, getTeamWeeks } from "@/lib/team";

export const dynamic = "force-dynamic";

const pct = (w: number, l: number) => (w + l ? `${((100 * w) / (w + l)).toFixed(1)}%` : "—");
const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTeamSeason(id);

  if (!t) {
    return (
      <main>
        <p>
          <Link href="/" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> home</Link>
        </p>
        <h1>Team not found</h1>
      </main>
    );
  }

  const place = await getTeamPlacement(id, t.seasonName);
  const weeks = await getTeamWeeks(id);

  return (
    <main>
      <p>
        <Link href={`/seasons/${encodeURIComponent(t.seasonName)}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {t.seasonName}</Link>
      </p>
      <h1>{t.teamName}</h1>
      <p className="sub">
        {t.seasonName} · {t.conferenceName}
      </p>
      <div className="grid grid-3 mb-4">
        {place && (
          <>
            <div className="stat">
              <div className="label">Finish</div>
              <div className="value">{ordinal(place.placement)}</div>
              <div className="muted">of {place.groupSize} · {place.conference}</div>
            </div>
            <div className="stat">
              <div className="label">Week record</div>
              <div className="value">{place.matchupsW}–{place.matchupsL}</div>
              <div className="muted">{pct(place.matchupsW, place.matchupsL)} win</div>
            </div>
          </>
        )}
        <div className="stat">
          <div className="label">Set record</div>
          <div className="value">{t.setW}–{t.setL}</div>
          <div className="muted">{pct(t.setW, t.setL)} win</div>
        </div>
        <div className="stat">
          <div className="label">Game record</div>
          <div className="value">{t.gameW}–{t.gameL}</div>
          <div className="muted">{pct(t.gameW, t.gameL)} win</div>
        </div>
        <div className="stat">
          <div className="label">Roster</div>
          <div className="value">{t.players.length}</div>
          <div className="muted">players</div>
        </div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th className="rank">Seed</th>
              <th>Player</th>
              <th className="num">Sets</th>
              <th className="num">Set %</th>
              <th className="num">Games</th>
              <th className="num">Game %</th>
            </tr>
          </thead>
          <tbody>
            {t.players.map((p) => (
              <tr key={p.playerId}>
                <td className="rank">{p.seed}</td>
                <td>
                  <Link href={`/players/${p.playerId}`}>{p.name}</Link>
                  {p.isCaptain && <span className="sub"> (C)</span>}
                </td>
                <td className="num">
                  {p.setW}–{p.setL}
                </td>
                <td className="num">{pct(p.setW, p.setL)}</td>
                <td className="num">
                  {p.gameW}–{p.gameL}
                </td>
                <td className="num">{pct(p.gameW, p.gameL)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {weeks.length > 0 && (
        <>
          <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 0.5rem" }}>Week by week</h2>
          <div className="card">
            {weeks.map((w) => {
              const res = w.setsFor > w.setsAgainst ? "W" : w.setsFor < w.setsAgainst ? "L" : "T";
              return (
                <details key={w.week} className="week-row">
                  <summary className="flex items-center gap-2" style={{ cursor: "pointer", padding: "0.4rem 0" }}>
                    <span className="muted" style={{ width: 64 }}>Week {w.week}</span>
                    <span style={{ width: 18, fontWeight: 600, color: res === "W" ? "var(--success)" : res === "L" ? "var(--accent-2)" : undefined }}>{res}</span>
                    <span className="num" style={{ width: 44 }}>{w.setsFor}–{w.setsAgainst}</span>
                    <span className="muted">vs</span>
                    {w.opponentTeamSeasonId ? (
                      <Link href={`/teams/${w.opponentTeamSeasonId}`}>{w.opponent}</Link>
                    ) : (
                      <span>{w.opponent}</span>
                    )}
                  </summary>
                  <table style={{ margin: "0.25rem 0 0.5rem" }}>
                    <tbody>
                      {w.sets.map((s, j) => (
                        <tr key={j}>
                          <td>{s.player}</td>
                          <td className="num" style={{ width: 56, textAlign: "center", color: s.win ? "var(--success)" : s.win === false ? "var(--accent-2)" : undefined }}>{s.scoreFor}–{s.scoreAgainst}</td>
                          <td style={{ textAlign: "right" }} className="muted">{s.oppPlayer}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}

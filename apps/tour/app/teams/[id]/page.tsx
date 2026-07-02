import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getTeamSeason, getTeamPlacement, getTeamWeeks, getTeamMoves } from "@/lib/team";
import { PlayerName } from "@/components/PlayerName";

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
  const moves = await getTeamMoves(id);

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
          <div className="muted">{pct(t.setW, t.setL)} win · regular season</div>
        </div>
        <div className="stat">
          <div className="label">Game record</div>
          <div className="value">{t.gameW}–{t.gameL}</div>
          <div className="muted">{pct(t.gameW, t.gameL)} win · regular season</div>
        </div>
        {(t.playoff.setW + t.playoff.setL) > 0 && (
          <div className="stat">
            <div className="label">Playoffs</div>
            <div className="value">{t.playoff.setW}–{t.playoff.setL}</div>
            <div className="muted">{pct(t.playoff.setW, t.playoff.setL)} win · {t.playoff.gameW}–{t.playoff.gameL} games</div>
          </div>
        )}
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
                <td className="rank">
                  {p.seed}
                  {p.seedChain.length > 1 && (
                    <div className="sub" style={{ fontWeight: 400, fontSize: "0.72rem" }} title={`Drafted at seed ${p.seedChain[0]}, now seed ${p.seed}`}>
                      {p.seedChain.join(" → ")}
                    </div>
                  )}
                </td>
                <td>
                  <PlayerName id={p.playerId} name={p.name} discordId={p.discordId} />
                  {p.isCaptain && <span className="sub"> (C)</span>}
                  {p.isCoCaptain && <span className="sub" title="Co-captain"> (CC)</span>}
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

      {moves.length > 0 && (
        <>
          <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 0.5rem" }}>Roster moves</h2>
          <div className="card">
            <table>
              <tbody>
                {moves.map((m, i) => {
                  const color = m.kind === "ADDED" || m.kind === "REINSTATED" ? "var(--success)" : m.kind === "QUIT" || m.kind === "BANNED" ? "var(--accent-2)" : "var(--muted)";
                  return (
                    <tr key={i}>
                      <td className="muted num" style={{ width: 52 }}>Wk {m.week}</td>
                      <td style={{ width: 84 }}><span className="pill" style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color }}>{m.label}</span></td>
                      <td><Link href={`/players/${m.playerId}`}>{m.player}</Link></td>
                      <td className="sub" style={{ textAlign: "right" }}>{m.detail ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

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
                          <td className="muted num" style={{ width: 28 }}>{s.seed != null ? s.seed : ""}</td>
                          <td><Link href={`/players/${s.playerId}`}>{s.player}</Link></td>
                          <td className="num" style={{ width: 56, textAlign: "center", color: s.win ? "var(--success)" : s.win === false ? "var(--accent-2)" : undefined }}>{s.scoreFor}–{s.scoreAgainst}</td>
                          <td style={{ textAlign: "right" }}><Link href={`/players/${s.oppPlayerId}`}>{s.oppPlayer}</Link></td>
                          <td className="muted num" style={{ width: 28, textAlign: "right" }}>{s.oppSeed != null ? s.oppSeed : ""}</td>
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

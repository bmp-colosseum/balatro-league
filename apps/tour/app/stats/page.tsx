import Link from "next/link";
import { getDraftSteals, getDraftValueByRound } from "@/lib/draft-stats";
import { getRecords, getRivalries, getRookieRankings } from "@/lib/records";

export const dynamic = "force-dynamic";

const pctStr = (x: number) => `${(x * 100).toFixed(1)}%`;

export default async function Stats() {
  const [steals, byRound, records, rivalries, rookies] = await Promise.all([
    getDraftSteals(),
    getDraftValueByRound(),
    getRecords(),
    getRivalries(),
    getRookieRankings(),
  ]);
  const maxPct = Math.max(0.01, ...byRound.map((r) => r.pct));

  return (
    <main>
      <h1>Fun Stats</h1>
      <p className="sub">All-time records, rivalries, and whether the draft paid off — derived from every imported set + pick.</p>

      <h2 className="mt-2 mb-1 text-[1.1rem]">All-time records</h2>
      <div className="grid grid-3">
        {records.map((r) => (
          <div className="stat" key={r.label}>
            <div className="label">{r.label}</div>
            <div className="value" style={{ fontSize: 22 }}>
              <Link href={`/players/${r.playerId}`}>{r.name}</Link>
            </div>
            <div className="muted">{r.value} · {r.detail}</div>
          </div>
        ))}
      </div>

      <h2 className="mt-6 mb-1 text-[1.1rem]">Biggest steals</h2>
      <p className="sub">Late-round picks who overperformed (min 8 sets) — score rewards a high set % drafted late.</p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th className="rank">#</th>
              <th>Player</th>
              <th>Season</th>
              <th className="num">Round</th>
              <th className="num">Sets</th>
              <th className="num">Set %</th>
            </tr>
          </thead>
          <tbody>
            {steals.map((s, i) => (
              <tr key={s.playerId + s.season}>
                <td className="rank">{i + 1}</td>
                <td>
                  <Link href={`/players/${s.playerId}`}>{s.name}</Link>
                </td>
                <td className="sub">{s.season}</td>
                <td className="num">R{s.round}</td>
                <td className="num">{s.setW}–{s.setL}</td>
                <td className="num">{pctStr(s.pct)}</td>
              </tr>
            ))}
            {steals.length === 0 && (
              <tr><td colSpan={6} className="sub">No draft data yet — run the import.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="mt-6 mb-1 text-[1.1rem]">Rookie rankings</h2>
      <p className="sub">Best debut seasons — a player&apos;s set win % in their first season on record (min 6 sets).</p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th className="rank">#</th>
              <th>Player</th>
              <th>Debut</th>
              <th className="num">Sets</th>
              <th className="num">Set %</th>
            </tr>
          </thead>
          <tbody>
            {rookies.map((r, i) => (
              <tr key={r.playerId}>
                <td className="rank">{i + 1}</td>
                <td><Link href={`/players/${r.playerId}`}>{r.name}</Link></td>
                <td className="sub">{r.season}</td>
                <td className="num">{r.setW}–{r.setL}</td>
                <td className="num">{pctStr(r.pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-6 mb-1 text-[1.1rem]">Draft value by round</h2>
      <p className="sub">
        Average set win % of everyone drafted at each pick number — do early picks really win more? ·{" "}
        <Link href="/stats/draft-heatmap">Per-pick heatmap →</Link>
      </p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Round</th>
              <th className="num">Picks</th>
              <th className="num">Set %</th>
              <th style={{ width: "45%" }}>Win rate</th>
            </tr>
          </thead>
          <tbody>
            {byRound.map((r) => (
              <tr key={r.round}>
                <td>Round {r.round}</td>
                <td className="num">{r.count}</td>
                <td className="num">{pctStr(r.pct)}</td>
                <td>
                  <div style={{ background: "var(--surface-2)", borderRadius: 4, height: 10, width: "100%" }}>
                    <div
                      style={{
                        background: "var(--accent)",
                        borderRadius: 4,
                        height: 10,
                        width: `${(r.pct / maxPct) * 100}%`,
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-6 mb-1 text-[1.1rem]">Biggest rivalries</h2>
      <p className="sub">
        The player matchups that have been played the most across every season. ·{" "}
        <Link href="/stats/h2h">Full H2H matrix →</Link>
      </p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th className="rank">#</th>
              <th>Matchup</th>
              <th className="num">Sets</th>
              <th className="num">Head-to-head</th>
            </tr>
          </thead>
          <tbody>
            {rivalries.map((r, i) => (
              <tr key={`${r.aId}-${r.bId}`}>
                <td className="rank">{i + 1}</td>
                <td>
                  <Link href={`/players/${r.aId}`}>{r.aName}</Link>
                  <span className="muted"> vs </span>
                  <Link href={`/players/${r.bId}`}>{r.bName}</Link>
                </td>
                <td className="num">{r.total}</td>
                <td className="num">{r.aWins}–{r.bWins}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

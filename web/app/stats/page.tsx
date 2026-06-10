// /stats — league-wide fun stats. Public, anyone can view.

import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import { BanRateChart } from "@/components/BanRateChart";
import { loadStatsPageData, type StatsLeaderRow, type StatsDeckRow, type StatsBanRow } from "@/lib/loaders/stats";

export const dynamic = "force-dynamic";

export default async function StatsPage() {
  const data = await loadStatsPageData();
  return (
    <>
      <SiteNav activePath="/stats" />
      <main>
        <h2>League stats</h2>
        <p className="muted">Career numbers across every season. Live updates as matches confirm.</p>

        <div className="grid grid-3" style={{ marginTop: 16 }}>
          <LeaderCard
            title="Top global rank"
            subtitle="Lower = better"
            rows={data.topByRating}
            valueFormat={(v) => `#${v}`}
          />
          <LeaderCard
            title="Most match wins"
            subtitle="2-0 results, all-time"
            rows={data.topByMatchWins}
            valueFormat={(v) => `${v}`}
          />
          <LeaderCard
            title="Most games won"
            subtitle="Game-level, all-time"
            rows={data.topByGameWins}
            valueFormat={(v) => `${v}`}
          />
        </div>

        <h3 style={{ marginTop: 24 }}>Streaks</h3>
        {data.longestActiveStreaks.length === 0 ? (
          <div className="card muted">
            No streaks of 3+ wins yet. (Streaks only count players currently in the active season.)
          </div>
        ) : (
          <div className="card">
            <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
              Consecutive match wins ending at the player's most recent confirmed match. ✓ = currently active.
            </p>
            <table className="table-dense" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th></th>
                  <th>Player</th>
                  <th style={{ textAlign: "right" }}>Streak</th>
                </tr>
              </thead>
              <tbody>
                {data.longestActiveStreaks.map((r, i) => (
                  <tr key={r.playerId}>
                    <td>{i + 1}.</td>
                    <td>
                      <Link href={`/profile/${r.playerId}`} style={{ color: "var(--text)" }}>
                        {r.displayName}
                      </Link>
                      {r.isActive && (
                        <span style={{ marginLeft: 6, color: "#2ecc71", fontSize: 11 }}>● active</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <strong>{r.streak}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 style={{ marginTop: 24 }}>Most-played decks + stakes</h3>
        <div className="grid grid-2">
          <ComboCard title="Most-played decks" rows={data.mostPlayedDecks} />
          <ComboCard title="Most-played stakes" rows={data.mostPlayedStakes} />
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Per-player deck + stake win rates live on each <Link href="/players">player's profile</Link>.
        </p>

        <h3 style={{ marginTop: 24 }}>Most-banned decks + stakes</h3>
        {data.mostBannedDecks.length >= 2 && (
          <div className="card">
            <strong>Deck ban rate</strong>
            <BanRateChart data={data.mostBannedDecks.map((r) => ({ name: r.name, rate: r.banRatePct }))} />
          </div>
        )}
        <div className="grid grid-2">
          <BanCard title="Most-banned decks" rows={data.mostBannedDecks} />
          <BanCard title="Most-banned stakes" rows={data.mostBannedStakes} />
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Ban rate = bans ÷ pool appearances. Decks with fewer than 5 appearances are filtered out.
        </p>
      </main>
    </>
  );
}

function LeaderCard({
  title,
  subtitle,
  rows,
  valueFormat,
}: {
  title: string;
  subtitle: string;
  rows: StatsLeaderRow[];
  valueFormat: (v: number) => string;
}) {
  return (
    <div className="card">
      <strong>{title}</strong>
      <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>{subtitle}</p>
      {rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>No data yet.</div>
      ) : (
        <table className="table-dense" style={{ width: "100%", fontSize: 13 }}>
          <tbody>
            {rows.map((r, i) => {
              const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
              return (
                <tr key={r.playerId}>
                  <td style={{ width: 24 }}>{medal}</td>
                  <td>
                    <Link href={`/profile/${r.playerId}`} style={{ color: "var(--text)" }}>
                      {r.displayName}
                    </Link>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <strong>{valueFormat(r.value)}</strong>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function BanCard({ title, rows }: { title: string; rows: StatsBanRow[] }) {
  return (
    <div className="card">
      <strong>{title}</strong>
      {rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>No data yet.</div>
      ) : (
        <table className="table-dense" style={{ width: "100%", fontSize: 13, marginTop: 8 }}>
          <thead>
            <tr>
              <th></th>
              <th>Name</th>
              <th style={{ textAlign: "right" }}>Bans</th>
              <th style={{ textAlign: "right" }}>Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name}>
                <td style={{ width: 24 }} className="muted">{i + 1}.</td>
                <td>{r.name}</td>
                <td style={{ textAlign: "right" }}>
                  <strong>{r.bansTotal}</strong>
                  <span className="muted" style={{ fontSize: 11 }}> / {r.appearancesTotal}</span>
                </td>
                <td style={{ textAlign: "right" }} className="muted">{r.banRatePct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ComboCard({ title, rows }: { title: string; rows: StatsDeckRow[] }) {
  return (
    <div className="card">
      <strong>{title}</strong>
      {rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>No data yet.</div>
      ) : (
        <table className="table-dense" style={{ width: "100%", fontSize: 13, marginTop: 8 }}>
          <thead>
            <tr>
              <th></th>
              <th>Name</th>
              <th style={{ textAlign: "right" }}>Games</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name}>
                <td style={{ width: 24 }} className="muted">{i + 1}.</td>
                <td>{r.name}</td>
                <td style={{ textAlign: "right" }}>
                  <strong>{r.gamesTotal}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}


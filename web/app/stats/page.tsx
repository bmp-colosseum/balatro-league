// /stats — league-wide fun stats. Public, anyone can view.

import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import { DiscordId } from "@/components/DiscordId";
import { deckImage, stakeImage } from "@/lib/balatro-slugs";
import {
  loadStatsPageData,
  type StatsLeaderRow,
  type StatsItemRow,
  type StatsComboRow,
} from "@/lib/loaders/stats";

export const dynamic = "force-dynamic";

// Below this many pool appearances a ban rate isn't meaningful — show "—".
const MIN_BAN_APPEARANCES = 5;

export default async function StatsPage() {
  const data = await loadStatsPageData();
  return (
    <>
      <SiteNav activePath="/stats" />
      <main>
        <h2>League stats</h2>
        <p className="muted">Career numbers, all seasons.</p>

        <div className="grid grid-2" style={{ marginTop: 16 }}>
          <LeaderCard title="Most match wins" subtitle="2-0 results, all-time" rows={data.topByMatchWins} valueFormat={(v) => `${v}`} />
          <LeaderCard title="Most games won" subtitle="Game-level, all-time" rows={data.topByGameWins} valueFormat={(v) => `${v}`} />
        </div>

        <h3 style={{ marginTop: 24 }}>Streaks</h3>
        {data.longestActiveStreaks.length === 0 ? (
          <div className="card muted">
            No streaks of 2+ wins yet.
          </div>
        ) : (
          <div className="card">
            <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
              Match wins in a row. ● = still live.
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
                      <Link href={`/profile/${r.playerId}`} style={{ color: "var(--text)" }}>{r.displayName}</Link>
                      <DiscordId value={r.discordId} username={r.username} />
                      {r.isActive && <span style={{ marginLeft: 6, color: "#2ecc71", fontSize: 11 }}>● active</span>}
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

        <h3 style={{ marginTop: 24 }}>Decks &amp; stakes</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          The standard pool, by games played. <strong>Ban rate</strong> = how often it gets banned when it shows up. Per-player rates on each <Link href="/players">profile</Link>.
        </p>
        <div className="grid grid-2">
          <ItemTable title="Decks" rows={data.decks} imageFor={deckImage} />
          <ItemTable title="Stakes" rows={data.stakes} imageFor={stakeImage} />
        </div>

        <h3 style={{ marginTop: 24 }}>Deck + stake combos</h3>
        <div className="grid grid-2">
          <ComboCard
            title="Most-played combos"
            subtitle="Share of all games played"
            rows={data.mostPlayedCombos}
            valueLabel={(r) => `${r.sharePct}% · ${r.gamesTotal}g`}
          />
          <ComboCard
            title="Most-banned combos"
            subtitle={`Top ban rate (min ${8})`}
            rows={data.mostBannedCombos}
            valueLabel={(r) => `${r.banRatePct}%`}
          />
        </div>
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
                    <Link href={`/profile/${r.playerId}`} style={{ color: "var(--text)" }}>{r.displayName}</Link>
                    <DiscordId value={r.discordId} username={r.username} />
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

// Inline ban-rate bar — readable label (the deck/stake name + icon) lives in the
// row, so the bar just needs the magnitude. Replaces the old cramped bar chart.
function BanBar({ pct, appearances }: { pct: number; appearances: number }) {
  if (appearances < MIN_BAN_APPEARANCES) {
    return <span className="muted" style={{ fontSize: 11 }}>—</span>;
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, minWidth: 48, height: 8, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--danger)" }} />
      </div>
      <span className="muted" style={{ fontSize: 11, width: 30, textAlign: "right" }}>{pct}%</span>
    </div>
  );
}

function ItemTable({
  title,
  rows,
  imageFor,
}: {
  title: string;
  rows: StatsItemRow[];
  imageFor: (name: string) => string;
}) {
  return (
    <div className="card">
      <strong>{title}</strong>
      <div className="table-scroll">
        <table className="table-dense" style={{ width: "100%", fontSize: 13, marginTop: 8 }}>
          <thead>
            <tr>
              <th></th>
              <th>Name</th>
              <th style={{ textAlign: "right" }}>Games</th>
              <th style={{ minWidth: 90 }}>Ban rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td style={{ width: 28 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageFor(r.name)} alt="" width={22} height={22} style={{ borderRadius: 3, display: "block" }} />
                </td>
                <td>{r.name}</td>
                <td style={{ textAlign: "right" }}>{r.gamesTotal > 0 ? r.gamesTotal : <span className="muted">—</span>}</td>
                <td>
                  <BanBar pct={r.banRatePct} appearances={r.appearancesTotal} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ComboCard({
  title,
  subtitle,
  rows,
  valueLabel,
}: {
  title: string;
  subtitle?: string;
  rows: StatsComboRow[];
  valueLabel: (r: StatsComboRow) => string;
}) {
  return (
    <div className="card">
      <strong>{title}</strong>
      {subtitle && <p className="muted" style={{ fontSize: 11, marginTop: 2, marginBottom: 0 }}>{subtitle}</p>}
      {rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>No data yet.</div>
      ) : (
        <div className="table-scroll">
          <table className="table-dense" style={{ width: "100%", fontSize: 13, marginTop: 8 }}>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.deck}·${r.stake}`}>
                  <td style={{ width: 24 }} className="muted">{i + 1}.</td>
                  <td style={{ width: 44 }}>
                    <span style={{ display: "inline-flex", gap: 2 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={deckImage(r.deck)} alt="" width={20} height={20} style={{ borderRadius: 3 }} />
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={stakeImage(r.stake)} alt="" width={20} height={20} style={{ borderRadius: 3 }} />
                    </span>
                  </td>
                  <td>{r.deck} <span className="muted">·</span> {r.stake}</td>
                  <td style={{ textAlign: "right" }}>
                    <strong>{valueLabel(r)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

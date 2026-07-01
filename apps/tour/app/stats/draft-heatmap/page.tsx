import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { CSSProperties } from "react";
import { getDraftHeatmap, seasonsWithDraft } from "@/lib/draft-stats";

export const dynamic = "force-dynamic";

// Diverging green↔red by delta. ±35% set-win% vs the round average = full intensity.
function heat(delta: number | null): CSSProperties {
  if (delta == null) return { background: "var(--surface-2)" };
  const a = Math.min(1, Math.abs(delta) / 0.35);
  const rgb = delta >= 0 ? "46, 204, 113" : "231, 76, 60";
  return { background: `rgba(${rgb}, ${0.12 + a * 0.5})` };
}
const fmtDelta = (d: number | null) => (d == null ? "" : `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(0)}%`);
const pctStr = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);

const cellBox: CSSProperties = {
  borderRadius: 6,
  padding: "4px 6px",
  width: 86,
  maxWidth: 86,
  overflow: "hidden",
};
const nameLine: CSSProperties = { fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

export default async function DraftHeatmap({ searchParams }: { searchParams: Promise<{ season?: string }> }) {
  const seasons = await seasonsWithDraft();
  const sp = await searchParams;
  const seasonName = sp.season && seasons.includes(sp.season) ? sp.season : seasons[0];
  const data = seasonName ? await getDraftHeatmap(seasonName) : null;

  return (
    <main>
      <p>
        <Link href="/stats" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> stats</Link>
      </p>
      <h1>Draft Value Heatmap</h1>
      <p className="sub">
        Every pick colored by how the player actually performed vs. the average set win % for that draft round —
        <span style={{ color: "var(--success)" }}> green = steal</span> (overperformed),
        <span style={{ color: "var(--danger)" }}> red = bust</span>.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {seasons.map((s) => (
          <Link
            key={s}
            href={`/stats/draft-heatmap?season=${encodeURIComponent(s)}`}
            className="badge"
            style={s === seasonName ? { background: "var(--accent-2)", color: "#fff", borderColor: "var(--accent-2)" } : undefined}
          >
            {s.replace(/^Team Tour/i, "TT")}
          </Link>
        ))}
        <span className="ml-auto flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
          Bust
          <span
            style={{
              display: "inline-block",
              width: 110,
              height: 10,
              borderRadius: 5,
              background: "linear-gradient(to right, rgba(231,76,60,0.62), var(--surface-2), rgba(46,204,113,0.62))",
            }}
          />
          Steal
        </span>
      </div>

      {!data ? (
        <p className="sub">No draft on record for this season.</p>
      ) : (
        <div className="card table-scroll">
          <table style={{ borderCollapse: "separate", borderSpacing: 4 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Team</th>
                <th style={{ textAlign: "left" }}>Captain</th>
                {Array.from({ length: data.maxRound }, (_, i) => (
                  <th key={i} className="num" style={{ textAlign: "center" }}>R{i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.teams.map((t) => (
                <tr key={t.teamSeasonId}>
                  <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>
                    <Link href={`/teams/${t.teamSeasonId}`}>{t.name}</Link>
                  </td>
                  <td>
                    <div style={{ ...cellBox, ...(t.captain.delta != null ? heat(t.captain.delta) : { background: "var(--surface-2)" }) }} title={`${t.captain.name} (captain${t.captain.seed != null ? `, seed ${t.captain.seed}` : ""}) · ${pctStr(t.captain.pct)} sets${t.captain.delta != null ? ` · ${fmtDelta(t.captain.delta)} vs seed avg` : ""}`}>
                      <div style={nameLine}><Link href={`/players/${t.captain.captainId}`}>{t.captain.name}</Link></div>
                      <div style={{ fontSize: 11, opacity: 0.9 }}>{pctStr(t.captain.pct)} <span style={{ color: "var(--muted)" }}>C{t.captain.seed != null ? `·#${t.captain.seed}` : ""}</span></div>
                    </div>
                  </td>
                  {t.cells.map((c, i) => (
                    <td key={i}>
                      {c ? (
                        <div
                          style={{ ...cellBox, ...heat(c.delta) }}
                          title={`${c.name}: ${pctStr(c.pct)} sets (${c.sets} played) · ${fmtDelta(c.delta)} vs R${c.round} avg`}
                        >
                          <div style={nameLine}><Link href={`/players/${c.playerId}`}>{c.name}</Link></div>
                          <div style={{ fontSize: 11, opacity: 0.9 }}>
                            {pctStr(c.pct)} {c.delta != null && <span style={{ color: "var(--muted)" }}>{fmtDelta(c.delta)}</span>}
                          </div>
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

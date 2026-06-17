import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadSignupMmrOverview } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Button } from "@/components/ui/button";
import { refreshSignupMmrs } from "./actions";

export const dynamic = "force-dynamic";

// "season6" → "S6"; raw tag otherwise.
function bmpSeasonLabel(tag: string | null): string {
  if (!tag) return "—";
  const m = /^season(\d+)$/.exec(tag);
  return m ? `S${m[1]}` : tag;
}

export default async function SignupMmrPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ refreshing?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { refreshing } = await searchParams;
  const data = await loadSignupMmrOverview(id);
  if (!data) notFound();

  const { round, rows, withData, withoutData, min, max, median, avg, byTier, bmpCurrentSeason } = data;
  const maxTierCount = Math.max(1, ...byTier.map((t) => t.count));

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>📊 Signup MMR</h2>
          <span style={{ fontSize: 16 }}>{round.name}</span>
          <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "#c0c8cb" }}>{round.status}</span>
          <span className="muted" style={{ fontSize: 12 }}>{round.signupCount} signed up</span>
          {round.status !== "BUILT" && (
            <Link href={`/admin/signups/${round.id}/build`} style={{ marginLeft: "auto", fontSize: 13 }}>
              Build season →
            </Link>
          )}
        </div>
        <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
          Each signup&apos;s best balatromp.com ranked MMR (current BMP season, falling back to their most
          recent prior one). Use it to gauge how strong the pool is before you build divisions.
        </p>

        {refreshing && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ Queued an MMR fetch for {refreshing} signup(s). It runs in the background (~1 every few
            seconds) — refresh this page in a minute to see updated numbers.
          </div>
        )}

        {/* Summary */}
        <div className="grid grid-3" style={{ marginTop: 12 }}>
          <div className="stat"><div className="label">Signups</div><div className="value">{round.signupCount}</div></div>
          <div className="stat">
            <div className="label">With BMP data</div>
            <div className="value">{withData}{withoutData > 0 && <span className="muted" style={{ fontSize: 13 }}> · {withoutData} none</span>}</div>
          </div>
          <div className="stat"><div className="label">Median MMR</div><div className="value">{median ?? "—"}</div></div>
          <div className="stat"><div className="label">Average MMR</div><div className="value">{avg ?? "—"}</div></div>
          <div className="stat"><div className="label">Range</div><div className="value">{min != null && max != null ? `${min} – ${max}` : "—"}</div></div>
        </div>

        {/* Refresh */}
        <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Numbers come from snapshots captured at signup-close. Fetch fresh ones now if signups are
            still open or you want the latest.
          </span>
          <form action={refreshSignupMmrs}>
            <input type="hidden" name="roundId" value={round.id} />
            <Button type="submit" variant="secondary" size="sm">↻ Refresh MMR from balatromp.com</Button>
          </form>
        </div>

        {/* Tier distribution */}
        <div className="card">
          <strong>Tier distribution</strong>
          {byTier.length === 0 ? (
            <p className="muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
              No ranked-tier data yet for these signups. Try Refresh above.
            </p>
          ) : (
            <div style={{ marginTop: 10 }}>
              {byTier.map((t) => (
                <div key={t.tier} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span className="muted" style={{ width: 110, fontSize: 12, flexShrink: 0 }}>{t.tier}</span>
                  <div style={{ flex: 1, background: "var(--surface-2)", borderRadius: 4, height: 18 }}>
                    <div style={{ width: `${(t.count / maxTierCount) * 100}%`, minWidth: 3, height: "100%", background: "var(--accent-2)", borderRadius: 4 }} />
                  </div>
                  <span style={{ width: 120, fontSize: 12, textAlign: "right", flexShrink: 0 }}>
                    {t.count} · <span className="muted">avg {t.avgMmr}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Roster */}
        <div className="card">
          <strong>Roster ({rows.length})</strong>
          <div className="table-scroll" style={{ marginTop: 8 }}>
            <table className="table-dense">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>MMR</th>
                  <th title="Peak ranked MMR">Peak</th>
                  <th>Tier</th>
                  <th title="BMP season these numbers are from">Season</th>
                  <th>Games</th>
                  <th>Win%</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={8} className="muted">No signups.</td></tr>
                ) : (
                  rows.map((r, i) => {
                    const isPrev = r.bmpSeason != null && bmpCurrentSeason != null && r.bmpSeason !== bmpCurrentSeason;
                    return (
                      <tr key={r.discordId}>
                        <td className="muted">{r.mmr != null ? i + 1 : ""}</td>
                        <td>
                          <strong>{r.globalName ?? `@${r.username}`}</strong>
                          {r.globalName && <span className="muted"> @{r.username}</span>}
                          <div className="muted" style={{ fontSize: 11 }}>
                            <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.discordId}</span>
                            {" · "}
                            <a href={`https://balatromp.com/players/${r.discordId}`} target="_blank" rel="noopener">balatromp ↗</a>
                            {r.inGuild === false && <span> · not in server</span>}
                          </div>
                        </td>
                        <td>{r.mmr != null ? <strong>{r.mmr}</strong> : <span className="muted">—</span>}</td>
                        <td>{r.peakMmr != null ? r.peakMmr : <span className="muted">—</span>}</td>
                        <td>{r.tier ?? <span className="muted">—</span>}</td>
                        <td>
                          {r.bmpSeason == null ? (
                            <span className="muted">—</span>
                          ) : isPrev ? (
                            <span style={{ color: "#f1c40f" }} title="Hasn't played the current BMP season — showing their most recent one">
                              {bmpSeasonLabel(r.bmpSeason)} · prev
                            </span>
                          ) : (
                            bmpSeasonLabel(r.bmpSeason)
                          )}
                        </td>
                        <td>{r.totalGames ?? <span className="muted">—</span>}</td>
                        <td>{r.winRatePct != null ? `${r.winRatePct}%` : <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </>
  );
}

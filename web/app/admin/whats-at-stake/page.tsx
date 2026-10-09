import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { loadWhatsAtStake } from "@/lib/loaders/whats-at-stake";
import type { PPPlayerResult, PPMatchResult, MatchImportance } from "@/lib/playoff-picture";
import { RarityText } from "@/components/RarityText";

export const dynamic = "force-dynamic";

// One "stake" label per player from their promo/releg status (promotion race
// takes visual priority over the drop, then mid-table).
function stakeBadge(p: PPPlayerResult): { label: string; bg: string; fg: string } | null {
  if (p.promo === "clinched") return { label: "🔒 Promoted", bg: "rgba(46,204,113,0.2)", fg: "var(--success)" };
  if (p.releg === "clinched") return { label: "🔻 Relegated", bg: "rgba(231,76,60,0.2)", fg: "var(--danger)" };
  if (p.promo === "contested") return { label: "↑ Promotion hunt", bg: "rgba(118,199,255,0.2)", fg: "var(--info)" };
  if (p.releg === "contested") return { label: "⚠ Drop zone", bg: "rgba(241,196,15,0.2)", fg: "var(--accent)" };
  if (p.releg === "safe" || p.promo === "eliminated") return { label: "mid-table", bg: "rgba(149,165,166,0.16)", fg: "var(--muted)" };
  return null;
}

const MATCH_STYLE: Record<MatchImportance, { tag: string; bg: string; fg: string }> = {
  promotion: { tag: "PROMOTION", bg: "rgba(118,199,255,0.18)", fg: "var(--info)" },
  relegation: { tag: "RELEGATION", bg: "rgba(231,76,60,0.18)", fg: "var(--danger)" },
  influences: { tag: "IN PLAY", bg: "rgba(241,196,15,0.16)", fg: "var(--accent)" },
  "dead-rubber": { tag: "dead rubber", bg: "rgba(149,165,166,0.14)", fg: "var(--muted)" },
};

function MatchRow({ m }: { m: PPMatchResult }) {
  const s = MATCH_STYLE[m.importance];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 13 }}>
      <span className="pill" style={{ fontSize: 10, minWidth: 88, textAlign: "center", background: s.bg, color: s.fg }}>{s.tag}</span>
      <span style={{ fontWeight: 500 }}>{m.playerAName}</span>
      <span className="muted">vs</span>
      <span style={{ fontWeight: 500 }}>{m.playerBName}</span>
      <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>{m.note}</span>
    </div>
  );
}

export default async function WhatsAtStakePage() {
  await requireAdmin();
  const data = await loadWhatsAtStake();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/whats-at-stake" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>🎯 What&apos;s at stake</h2>
          {data !== "NO_SEASON" && <span className="muted" style={{ fontSize: 13 }}>{data.seasonLabel}</span>}
        </div>
        <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
          Given what&apos;s been played and what&apos;s left, who has <strong>clinched</strong>, who&apos;s still{" "}
          <strong>contested</strong>, and which remaining matches actually decide promotion / relegation. Computed by
          checking every possible combination of remaining results, so it&apos;s exact — a{" "}
          <strong>dead rubber</strong> genuinely can&apos;t change anything. ⚔ marks a spot that could still come down
          to a tie (a shootout).
        </p>

        {data === "NO_SEASON" ? (
          <div className="card">No active season.</div>
        ) : data.divisions.length === 0 ? (
          <div className="card">This season has no divisions.</div>
        ) : (
          data.divisions.map((d) => {
            const pic = d.picture;
            const liveMatches = pic.matches.filter((m) => m.importance !== "dead-rubber");
            const deadCount = pic.matches.length - liveMatches.length;
            const settled = pic.matches.length === 0;
            return (
              <div key={d.divisionId} className="card" style={{ marginTop: 12 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                  <strong style={{ fontSize: 15 }}><RarityText position={d.tierPosition}>{d.divisionName}</RarityText></strong>
                  <span className="muted" style={{ fontSize: 12 }}>
                    ↑{pic.promote} promote · ↓{pic.relegate} relegate · {pic.matches.length} left
                    {d.locked ? " · locked schedule" : " · round-robin"}
                  </span>
                  {!pic.exact && (
                    <span className="pill" style={{ fontSize: 10, background: "rgba(241,196,15,0.2)", color: "var(--accent)" }}>
                      estimate — {pic.variableMatches} open matches too many to solve exactly
                    </span>
                  )}
                </div>

                {/* Standings with each player's stake. */}
                <table style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 24 }}>#</th>
                      <th>Player</th>
                      <th style={{ textAlign: "right" }}>Pts</th>
                      <th style={{ textAlign: "right" }}>If wins out</th>
                      <th style={{ textAlign: "right" }}>If loses out</th>
                      <th>Stake</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pic.players.map((p, idx) => {
                      const badge = stakeBadge(p);
                      return (
                        <tr key={p.playerId}>
                          <td className="muted">{idx + 1}</td>
                          <td style={{ fontWeight: 500 }}>
                            {p.displayName}
                            {p.couldTieBoundary && <span title="Could come down to a tie / shootout" style={{ marginLeft: 5 }}>⚔</span>}
                          </td>
                          <td style={{ textAlign: "right", fontWeight: 600 }}>{p.pointsNow}</td>
                          <td style={{ textAlign: "right" }} className="muted">{p.pointsMax}</td>
                          <td style={{ textAlign: "right" }} className="muted">{p.pointsMin}</td>
                          <td>
                            {badge && (
                              <span className="pill" style={{ fontSize: 11, background: badge.bg, color: badge.fg }}>{badge.label}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* Remaining matches by importance. */}
                <div style={{ marginTop: 10 }}>
                  {settled ? (
                    <Callout type="success">Every match is played — this division is settled.</Callout>
                  ) : liveMatches.length === 0 ? (
                    <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                      All {deadCount} remaining match(es) are dead rubbers — the table can&apos;t change now.
                    </p>
                  ) : (
                    <>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Matches that matter</div>
                      {liveMatches.map((m, i) => (
                        <MatchRow key={i} m={m} />
                      ))}
                      {deadCount > 0 && (
                        <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
                          + {deadCount} dead rubber(s) that can no longer change anything.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </main>
    </>
  );
}

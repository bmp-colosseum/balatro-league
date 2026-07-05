import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Button } from "@/components/ui/button";
import { loadParticipation, type MemberStatus } from "@/lib/loaders/participation";
import { banPlayerAction, addStrikeAction } from "@/app/admin/bans/actions";

export const dynamic = "force-dynamic";

const RETURN_TO = "/admin/participation";

const STATUS_PILL: Record<MemberStatus, { label: string; bg: string; fg: string }> = {
  "no-show": { label: "NO-SHOW", bg: "rgba(231,76,60,0.18)", fg: "var(--danger)" },
  incomplete: { label: "incomplete", bg: "rgba(241,196,15,0.16)", fg: "var(--accent)" },
  done: { label: "done", bg: "rgba(46,204,113,0.16)", fg: "var(--success)" },
};

export default async function ParticipationPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const { ok, err } = await searchParams;
  const data = await loadParticipation();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/participation" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>🎮 Participation</h2>
          {data.seasonLabel && <span className="muted" style={{ fontSize: 13 }}>{data.seasonLabel}</span>}
        </div>
        <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
          How many of their scheduled sets each active player has played. <strong>No-shows</strong> (played none)
          and <strong>incomplete</strong> players are shown first. Use <strong>Ban 1 season</strong> to season-ban a
          ghost (auto-lifts next season) or <strong>Strike</strong> to log it. A ban doesn&apos;t remove them from
          the current season — pair it with the division <strong>DQ / void</strong> tools if you want their matches
          forfeited too.
        </p>

        {err && <Callout type="danger">{err}</Callout>}
        {ok && <Callout type="success">{ok}</Callout>}

        {data.seasonLabel == null ? (
          <div className="card">No active season.</div>
        ) : (
          <>
            <div className="card" style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
              <span><strong style={{ color: "var(--danger)" }}>{data.counts.noShow}</strong> no-show</span>
              <span><strong style={{ color: "var(--accent)" }}>{data.counts.incomplete}</strong> incomplete</span>
              <span><strong style={{ color: "var(--success)" }}>{data.counts.done}</strong> done</span>
              <span className="muted">· {data.counts.total} active players</span>
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <table style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Division</th>
                    <th style={{ textAlign: "center" }}>Sets</th>
                    <th>Status</th>
                    <th style={{ textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((m) => {
                    const pill = STATUS_PILL[m.status];
                    return (
                      <tr key={m.playerId}>
                        <td style={{ fontWeight: 500 }}>
                          <Link href={`/profile/${m.playerId}`} style={{ color: "var(--text)" }}>{m.displayName}</Link>
                          {m.strikeCount > 0 && (
                            <span className="pill" style={{ fontSize: 10, marginLeft: 6, background: "rgba(241,196,15,0.18)", color: "var(--accent)" }}>
                              {m.strikeCount}⚠
                            </span>
                          )}
                        </td>
                        <td className="muted" style={{ fontSize: 13 }}>{m.divisionName}</td>
                        <td style={{ textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                          {m.played}/{m.total}
                        </td>
                        <td>
                          <span className="pill" style={{ fontSize: 11, background: pill.bg, color: pill.fg }}>{pill.label}</span>
                        </td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {m.banned ? (
                            <span className="pill" style={{ fontSize: 11, background: "rgba(231,76,60,0.18)", color: "var(--danger)" }}>banned</span>
                          ) : (
                            <>
                              <form action={addStrikeAction} style={{ display: "inline", marginRight: 6 }}>
                                <input type="hidden" name="playerId" value={m.playerId} />
                                <input type="hidden" name="returnTo" value={RETURN_TO} />
                                <input type="hidden" name="reason" value={`Didn't play scheduled sets (${m.played}/${m.total})`} />
                                <Button type="submit" variant="secondary" size="sm" style={{ fontSize: 11, padding: "2px 8px" }}>Strike</Button>
                              </form>
                              <form action={banPlayerAction} style={{ display: "inline" }}>
                                <input type="hidden" name="playerId" value={m.playerId} />
                                <input type="hidden" name="duration" value="1" />
                                <input type="hidden" name="returnTo" value={RETURN_TO} />
                                <input type="hidden" name="reason" value={`No-show / incomplete season (played ${m.played}/${m.total})`} />
                                <ConfirmButton
                                  message={`Ban ${m.displayName} for 1 season? They can't sign up for the next season (auto-lifts after). This does NOT forfeit their current matches — DQ them separately if you want that.`}
                                  style={{ fontSize: 11, padding: "2px 8px" }}
                                >
                                  Ban 1 season
                                </ConfirmButton>
                              </form>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </>
  );
}

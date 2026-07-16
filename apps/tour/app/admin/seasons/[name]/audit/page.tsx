// Reporting audit -- which matchups are settled, which still need something, and
// which teams are behind. Report sets INLINE here (shared SetReportControls, same as
// the matchup console) so the TO can clear stragglers without hopping pages. Every
// row also links to the full console. Live-refreshes on any set activity ("sets").
import Link from "next/link";
import { ArrowLeft, ClipboardList, Grid3x3 } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonAudit, type PendingCategory } from "@/lib/services/audit";
import { Callout } from "@/components/Callout";
import { LiveRefresh } from "@/components/LiveRefresh";
import { SetReportControls } from "@/components/SetReportControls";
import { SeedOrSub } from "@/components/SeedOrSub";

export const dynamic = "force-dynamic";

const CATEGORY_LABEL: Record<PendingCategory, string> = {
  DISPUTED: "Disputed: needs a TO ruling",
  AWAITING_CONFIRM: "Awaiting confirm: result in, opponent has not confirmed",
  UNPAIRED: "Not fully paired: captains still owe lineups",
  UNPLAYED: "Paired, not played: sets awaiting results",
  NOT_STARTED: "Not started: no lineups paired yet (future weeks)",
};

const CATEGORY_TONE: Record<PendingCategory, string> = {
  DISPUTED: "var(--danger, #e5484d)",
  AWAITING_CONFIRM: "var(--accent)",
  UNPAIRED: "var(--warning, #f5a524)",
  UNPLAYED: "var(--muted)",
  NOT_STARTED: "var(--muted)",
};

const CATEGORY_ORDER: PendingCategory[] = ["DISPUTED", "AWAITING_CONFIRM", "UNPAIRED", "UNPLAYED", "NOT_STARTED"];
const OPEN_BY_DEFAULT = new Set<PendingCategory>(["DISPUTED", "AWAITING_CONFIRM"]);

export default async function AuditPage({ params }: { params: Promise<{ name: string }> }) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only {"—"} you don&apos;t have access.</Callout>
      </main>
    );
  }

  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);
  const audit = await getSeasonAudit(seasonName);

  if (!audit) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }

  const { totals, weeks, pending, teams, hasSeries, pendingSeries, importedSetCount } = audit;
  const pct = totals.matchups ? Math.round((totals.decided / totals.matchups) * 100) : 0;
  const byCategory = new Map<PendingCategory, typeof pending>();
  for (const p of pending) {
    const arr = byCategory.get(p.category) ?? [];
    arr.push(p);
    byCategory.set(p.category, arr);
  }

  return (
    <main>
      <LiveRefresh channel="sets" />
      <p>
        <Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
      </p>
      <h1 className="inline-flex items-center gap-2"><ClipboardList className="size-6" /> {seasonName} {"—"} Reporting audit</h1>
      <p className="sub">
        {totals.decided} of {totals.matchups} matchups settled ({pct}%) {"·"} {totals.pending} outstanding
        {hasSeries && <> {"·"} {pendingSeries.length} playoff series undecided</>}
      </p>
      <p>
        <Link href={`/admin/seasons/${enc}/grid`} className="inline-flex items-center gap-1">
          <Grid3x3 className="size-4" /> Coverage grid {"—"} who played whom, where the holes are {"→"}
        </Link>
      </p>

      {totals.matchups === 0 && importedSetCount > 0 ? (
        <Callout type="admin">
          <div style={{ marginBottom: "0.5rem" }}>
            This season was <strong>imported</strong> {"—"} {importedSetCount} played games are in the data, but they
            aren&apos;t grouped into matchups yet, so the audit (and overlays) can&apos;t see them. Preview rebuilding
            the matchups from those results (nothing is written until you confirm):
          </div>
          <Link href={`/admin/seasons/${enc}/audit/rebuild`} className="inline-flex items-center gap-1">
            <ClipboardList className="size-4" /> Preview matchup rebuild {"→"}
          </Link>
        </Callout>
      ) : totals.matchups === 0 ? (
        <Callout type="admin">No schedule yet {"—"} generate the schedule first.</Callout>
      ) : totals.pending === 0 && !pendingSeries.length ? (
        <Callout type="success">Everything is settled {"—"} every matchup{hasSeries ? " and playoff series" : ""} has a result.</Callout>
      ) : null}

      {weeks.length > 0 && (
        <div className="card">
          <div className="bracket-title">Week by week</div>
          <table>
            <thead><tr><th>Week</th><th>Kind</th><th className="num">Settled</th><th style={{ width: "40%" }}></th></tr></thead>
            <tbody>
              {weeks.map((w) => {
                const done = w.total > 0 && w.decided === w.total;
                return (
                  <tr key={w.weekId}>
                    <td>Week {w.number}</td>
                    <td className="sub">{w.kind}</td>
                    <td className="num" style={{ color: done ? "var(--accent-2)" : undefined }}>
                      {w.decided}/{w.total}{done ? " ✓" : ""}
                    </td>
                    <td>
                      <div style={{ background: "var(--surface-2)", borderRadius: 4, height: "0.5rem", overflow: "hidden" }}>
                        <div style={{ width: `${w.total ? (w.decided / w.total) * 100 : 0}%`, height: "100%", background: done ? "var(--accent-2)" : "var(--accent)" }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const rows = byCategory.get(cat);
        if (!rows?.length) return null;
        return (
          <div className="card" key={cat}>
            <div className="bracket-title" style={{ color: CATEGORY_TONE[cat] }}>
              {CATEGORY_LABEL[cat]} ({rows.length})
            </div>
            {rows.map((p) => (
              <details key={p.matchupId} open={OPEN_BY_DEFAULT.has(cat)} style={{ borderTop: "1px solid var(--border)", padding: "0.45rem 0" }}>
                <summary style={{ cursor: "pointer", listStyle: "revert" }}>
                  <span className="sub">W{p.week}</span>{" "}
                  <span style={{ fontWeight: 600 }}><Link href={`/teams/${p.aTeamSeasonId}`} style={{ color: "inherit" }}>{p.aName}</Link></span>{" "}
                  <span className="muted">vs</span>{" "}
                  <span style={{ fontWeight: 600 }}><Link href={`/teams/${p.bTeamSeasonId}`} style={{ color: "inherit" }}>{p.bName}</Link></span>
                  <span className="sub">
                    {"  ·  "}{p.confirmed}/{p.expected} confirmed
                    {p.awaitingConfirm > 0 && <>{"  ·  "}{p.awaitingConfirm} to confirm</>}
                    {p.disputed > 0 && <>{"  ·  "}{p.disputed} disputed</>}
                    {p.paired < p.expected && <>{"  ·  "}{p.expected - p.paired} unpaired</>}
                    {"  "}<Link href={`/admin/matchups/${p.matchupId}`}>console {"→"}</Link>
                  </span>
                </summary>
                {p.sets.length > 0 ? (
                  <table style={{ marginTop: "0.4rem" }}>
                    <tbody>
                      {p.sets.map((s) => (
                        <tr key={s.setId}>
                          <td style={{ whiteSpace: "nowrap" }}><SeedOrSub seed={s.aSeed} isSub={s.aIsSub} /> <Link href={`/players/${s.aPlayerId}`} style={{ color: "inherit" }}>{s.aName}</Link></td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <SeedOrSub seed={s.bSeed} isSub={s.bIsSub} /> <Link href={`/players/${s.bPlayerId}`} style={{ color: "inherit" }}>{s.bName}</Link>
                            {!s.aIsSub && !s.bIsSub && s.bSeed !== s.aSeed && (
                              <span className="sub" style={{ color: "var(--warning, #f5a524)" }} title={`Not seed-for-seed: #${s.aSeed} vs #${s.bSeed}`}>
                                {" "}({s.bSeed > s.aSeed ? "+" : ""}{s.bSeed - s.aSeed})
                              </span>
                            )}
                          </td>
                          <td style={{ width: "100%" }}>
                            <SetReportControls
                              matchupId={p.matchupId}
                              setId={s.setId}
                              aName={s.aName}
                              bName={s.bName}
                              bestOf={s.bestOf}
                              reported={s.reported}
                              outcome={s.outcome}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="sub" style={{ marginTop: "0.3rem" }}>
                    No lineups paired yet {"—"} <Link href={`/admin/matchups/${p.matchupId}`}>pair them in the console {"→"}</Link>
                  </p>
                )}
              </details>
            ))}
          </div>
        );
      })}

      {pendingSeries.length > 0 && (
        <div className="card">
          <div className="bracket-title">Playoff series undecided ({pendingSeries.length})</div>
          <table>
            <tbody>
              {pendingSeries.map((s) => (
                <tr key={s.seriesId}>
                  <td className="sub" style={{ width: "8rem" }}>{s.round}</td>
                  <td>{s.aName} <span className="muted">vs</span> {s.bName}</td>
                  <td className="num">{s.scoreA ?? 0}{"–"}{s.scoreB ?? 0}</td>
                  <td style={{ textAlign: "right" }}>
                    <Link href={`/admin/seasons/${enc}/playoffs`}>Report {"→"}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {teams.length > 0 && (
        <div className="card">
          <div className="bracket-title">Teams with outstanding matchups ({teams.length})</div>
          <table>
            <thead><tr><th>Team</th><th className="num">Pending</th><th>Weeks</th></tr></thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.teamSeasonId}>
                  <td><Link href={`/teams/${t.teamSeasonId}`} style={{ color: "inherit" }}>{t.name}</Link></td>
                  <td className="num">{t.count}</td>
                  <td className="sub">{t.weeks.map((w) => `W${w}`).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

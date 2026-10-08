// Read-only admin audit for /admin/season-audit: lets a TO check that an
// ENDED season (or the active one) was closed out properly -- no open
// matches, ties resolved, champions recorded, final ranks consistent with
// the cached standings, Discord leftovers cleaned. Every finding links to
// the place that fixes it; nothing on this page mutates anything.

import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import {
  loadSeasonAudit,
  loadSeasonAuditOverview,
  type SeasonAuditOverviewRow,
} from "@/lib/loaders/season-audit";
import type { Finding, FindingSeverity } from "@/lib/season-audit-core";

export const dynamic = "force-dynamic";

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  error: "Error",
  warn: "Warning",
  info: "Info",
};

const SEVERITY_COLOR: Record<FindingSeverity, string> = {
  error: "var(--danger)",
  warn: "var(--accent)",
  info: "var(--info)",
};

function SeverityPill({ severity }: { severity: FindingSeverity }) {
  const color = SEVERITY_COLOR[severity];
  return (
    <span
      className="pill"
      style={{ background: `color-mix(in oklch, ${color} 18%, transparent)`, color, fontSize: 11 }}
    >
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

function CountsCell({ counts }: { counts: SeasonAuditOverviewRow["countsBySeverity"] }) {
  if (counts.error + counts.warn + counts.info === 0) {
    return <span style={{ color: "var(--success)" }}>OK -- clean</span>;
  }
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {counts.error > 0 && <SeverityPill severity="error" />}
      {counts.error > 0 && <span>{counts.error}</span>}
      {counts.warn > 0 && <SeverityPill severity="warn" />}
      {counts.warn > 0 && <span>{counts.warn}</span>}
      {counts.info > 0 && <SeverityPill severity="info" />}
      {counts.info > 0 && <span>{counts.info}</span>}
    </div>
  );
}

export default async function SeasonAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  await requireAdmin();
  const { season: seasonParam } = await searchParams;

  const overview = await loadSeasonAuditOverview();
  const selectedSeasonId = seasonParam || overview.defaultSeasonId;
  const data = selectedSeasonId ? await loadSeasonAudit(selectedSeasonId) : null;

  const findingsByDivisionId = new Map<string, Finding[]>();
  const seasonLevelFindings: Finding[] = [];
  if (data) {
    for (const f of data.report.findings) {
      if (f.divisionId) {
        const arr = findingsByDivisionId.get(f.divisionId) ?? [];
        arr.push(f);
        findingsByDivisionId.set(f.divisionId, arr);
      } else {
        seasonLevelFindings.push(f);
      }
    }
  }

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/season-audit" />
      <main>
        <h2>Season audit</h2>
        <p className="muted">
          Checks that an ended season was closed out properly -- no open matches, ties resolved, champions
          recorded, final ranks consistent with the standings, Discord leftovers cleaned. A finding is shown
          even when it no longer affects anything; that&apos;s the point of an audit trail.
        </p>

        {overview.seasons.length === 0 ? (
          <Callout type="info">No ended or active seasons to audit yet.</Callout>
        ) : (
          <div className="table-scroll">
            <table className="table-dense">
              <thead>
                <tr>
                  <th>Season</th>
                  <th>Ended</th>
                  <th>Findings</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {overview.seasons.map((s) => (
                  <tr key={s.seasonId} style={s.seasonId === selectedSeasonId ? { background: "var(--admin-bg, rgba(255,255,255,0.04))" } : undefined}>
                    <td>{s.seasonLabel}</td>
                    <td className="muted">{s.ended ? "yes" : "active"}</td>
                    <td>
                      <CountsCell counts={s.countsBySeverity} />
                    </td>
                    <td>
                      <Link href={`/admin/season-audit?season=${s.seasonId}`}>Audit</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && (
          <>
            <h3 style={{ margin: "18px 0 4px" }}>{data.seasonLabel}</h3>
            {data.report.findings.length === 0 ? (
              <Callout type="success">No findings -- season fully closed out.</Callout>
            ) : (
              <>
                {seasonLevelFindings.length > 0 && (
                  <FindingGroup title="Season" findings={seasonLevelFindings} />
                )}
                {data.divisions.map((d) => {
                  const findings = findingsByDivisionId.get(d.divisionId) ?? [];
                  if (findings.length === 0) return null;
                  return <FindingGroup key={d.divisionId} title={d.name} findings={findings} />;
                })}
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}

function FindingGroup({ title, findings }: { title: string; findings: Finding[] }) {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "8px 12px", fontWeight: 600, borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))" }}>
        {title}
      </div>
      <table style={{ margin: 0 }}>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Finding</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f, i) => (
            <tr key={`${f.code}-${i}`}>
              <td>
                <SeverityPill severity={f.severity} />
              </td>
              <td>{f.message}</td>
              <td>{f.href && <Link href={f.href}>Fix</Link>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

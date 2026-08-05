// Owner/admin-facing HOST status page -- machine-level detail (uptime, load,
// memory, disk, plus the bot's own health snapshot fetched cross-container).
// This is deliberately SEPARATE from the player-facing bot status
// (#league-bot-status / /league-bot-status), which stays intentionally
// simple ("is the bot working"). This page is the technical counterpart for
// whoever operates the box.

import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { readHostMetrics } from "@/lib/host-metrics";
import {
  botLevelSeverity,
  formatBytes,
  formatRelativeTime,
  formatUptime,
  pctSeverity,
  type Severity,
} from "@/lib/host-metrics-parsers";
import { loadBotHealthSnapshot } from "@/lib/loaders/host-bot-snapshot";

export const dynamic = "force-dynamic";

function severityColor(severity: Severity): string | undefined {
  switch (severity) {
    case "danger":
      return "var(--danger)";
    case "warn":
      return "var(--admin)";
    case "normal":
      return undefined;
  }
}

export default async function HostStatusPage() {
  await requireAdmin();
  const [metrics, botResult] = await Promise.all([readHostMetrics(), loadBotHealthSnapshot()]);
  const now = new Date();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/host" />
      <main>
        <h2>Host status</h2>
        <p className="muted">
          Machine-level detail for the box this app runs on -- owner/admin only. The player-facing bot
          status (Discord&apos;s #league-bot-status / /league-bot-status) stays deliberately simple; this
          page is the deeper, technical counterpart.
        </p>

        <Callout type="info">
          This page runs ON the box -- if the box itself is down or off the network, this page will not
          load either. That blind spot is exactly what the external GitHub Actions uptime watchdog (
          <code>.github/workflows/uptime.yml</code>) covers: it probes balatroleague.com from
          GitHub&apos;s own runners every ~5 minutes and posts to Discord when nothing answers, because a
          check running on the box can never report &quot;the box is unreachable&quot;.
        </Callout>

        <h3 style={{ marginTop: 20 }}>Host</h3>
        <p className="muted" style={{ marginTop: -4, fontSize: 13 }}>
          As seen from the web container. Under Docker (no lxcfs here) uptime/load/memory reflect the
          real host kernel -- but this container&apos;s own cgroup memory limit can make its usable
          memory smaller than the host total shown below.
        </p>
        <div className="grid grid-3">
          <div className="stat">
            <div className="label">Uptime</div>
            <div className="value" style={{ fontSize: 20 }}>
              {metrics.uptime ? formatUptime(metrics.uptime.uptimeSeconds) : <span className="muted">unavailable</span>}
            </div>
          </div>
          <div className="stat">
            <div className="label">Load avg (1m / 5m / 15m)</div>
            <div className="value" style={{ fontSize: 20 }}>
              {metrics.loadavg ? (
                `${metrics.loadavg.load1.toFixed(2)} / ${metrics.loadavg.load5.toFixed(2)} / ${metrics.loadavg.load15.toFixed(2)}`
              ) : (
                <span className="muted">unavailable</span>
              )}
            </div>
          </div>
          <div className="stat">
            <div className="label">Memory used</div>
            <div
              className="value"
              style={{
                fontSize: 20,
                color: metrics.memory ? severityColor(pctSeverity(metrics.memory.usedPercent)) : undefined,
              }}
            >
              {metrics.memory ? (
                `${formatBytes(metrics.memory.usedKb * 1024)} / ${formatBytes(metrics.memory.totalKb * 1024)} (${metrics.memory.usedPercent.toFixed(0)}%)`
              ) : (
                <span className="muted">unavailable</span>
              )}
            </div>
          </div>
          <div className="stat">
            <div className="label">Disk used (/)</div>
            <div
              className="value"
              style={{
                fontSize: 20,
                color: metrics.disk ? severityColor(pctSeverity(metrics.disk.usedPercent)) : undefined,
              }}
            >
              {metrics.disk ? (
                `${formatBytes(metrics.disk.usedBytes)} / ${formatBytes(metrics.disk.totalBytes)} (${metrics.disk.usedPercent.toFixed(0)}%)`
              ) : (
                <span className="muted">unavailable</span>
              )}
            </div>
          </div>
        </div>

        <h3 style={{ marginTop: 24 }}>Bot</h3>
        {botResult.error && <Callout type="danger">Could not fetch the bot&apos;s health snapshot: {botResult.error}</Callout>}

        {botResult.snapshot && (
          <>
            <div className="grid grid-3">
              <div className="stat">
                <div className="label">Overall level</div>
                <div
                  className="value"
                  style={{ fontSize: 20, color: severityColor(botLevelSeverity(botResult.snapshot.level)) }}
                >
                  {botResult.snapshot.level}
                </div>
              </div>
              <div className="stat">
                <div className="label">Discord gateway ping</div>
                <div className="value" style={{ fontSize: 20 }}>
                  {botResult.snapshot.discord.gatewayPingMs !== null ? (
                    `${Math.round(botResult.snapshot.discord.gatewayPingMs)}ms`
                  ) : (
                    <span className="muted">n/a</span>
                  )}
                </div>
              </div>
              <div className="stat">
                <div className="label">Discord REST p95</div>
                <div className="value" style={{ fontSize: 20 }}>
                  {botResult.snapshot.discord.restP95Ms !== null ? (
                    `${Math.round(botResult.snapshot.discord.restP95Ms)}ms`
                  ) : (
                    <span className="muted">n/a</span>
                  )}
                </div>
              </div>
              <div className="stat">
                <div className="label">Discord REST error rate</div>
                <div className="value" style={{ fontSize: 20 }}>
                  {botResult.snapshot.discord.restErrorRate !== null ? (
                    `${(botResult.snapshot.discord.restErrorRate * 100).toFixed(1)}%`
                  ) : (
                    <span className="muted">n/a</span>
                  )}
                </div>
              </div>
              <div className="stat">
                <div className="label">DB latency</div>
                <div
                  className="value"
                  style={{ fontSize: 20, color: botResult.snapshot.db.ok ? undefined : "var(--danger)" }}
                >
                  {botResult.snapshot.db.latencyMs !== null ? `${botResult.snapshot.db.latencyMs}ms` : <span className="muted">n/a</span>}
                </div>
              </div>
              <div className="stat">
                <div className="label">Queue stalls</div>
                <div
                  className="value"
                  style={{ fontSize: 20, color: botResult.snapshot.queue.ok ? undefined : "var(--danger)" }}
                >
                  {botResult.snapshot.queue.ok ? "none" : botResult.snapshot.queue.stalled.join(", ")}
                </div>
              </div>
            </div>

            <div className="card" style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                Last checked {formatRelativeTime(new Date(botResult.snapshot.checkedAt), now)}
              </div>
              {botResult.snapshot.notes.length > 0 && (
                <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {botResult.snapshot.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </main>
    </>
  );
}

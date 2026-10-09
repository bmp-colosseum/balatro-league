import { requireAdmin } from "@/lib/admin";
import { loadAdminHomeStats } from "@/lib/loaders/admin";
import { unreadDmCount } from "@/lib/loaders/dms";
import { seasonCountdown } from "@/lib/season-countdown-core";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { getUiPreviewV2 } from "@/lib/preferences";
import { enableUiPreviewAction, disableUiPreviewAction } from "@/app/admin/ui-preview-actions";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  await requireAdmin();
  const [stats, unreadDms] = await Promise.all([loadAdminHomeStats(), unreadDmCount()]);
  const uiV2 = await getUiPreviewV2();
  const countdown = stats.activeSeason
    ? seasonCountdown({
        startMs: stats.activeSeason.startedAt.getTime(),
        scheduledEndMs: stats.activeSeason.scheduledEndAt?.getTime() ?? null,
        endedMs: stats.activeSeason.endedAt?.getTime() ?? null,
        nowMs: Date.now(),
      })
    : null;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin" />
      <main>
        <h2>Inbox</h2>

        {(stats.disputedPairings > 0 || unreadDms > 0) && (
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <strong>Needs attention</strong>
            {stats.disputedPairings > 0 && (
              <div>
                <strong>{stats.disputedPairings}</strong> disputed match{stats.disputedPairings === 1 ? "" : "es"}
                {" -- "}
                <a href="/admin/disputes">Review in Matches {"->"}</a>
              </div>
            )}
            {unreadDms > 0 && (
              <div>
                <strong>{unreadDms}</strong> unread DM{unreadDms === 1 ? "" : "s"}
                {" -- "}
                <a href="/admin/dms">Open Messages {"->"}</a>
              </div>
            )}
          </div>
        )}

        {/* The "Card Table" look is the default for everyone. This toggle is a
            per-browser opt-out so an admin can compare against the classic
            look while the remaining pages are restyled (see ui-preview-actions.ts). */}
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <strong style={{ marginRight: "auto" }}>Look: {uiV2 ? "new (default)" : "classic (this browser only)"}</strong>
          {uiV2 ? (
            <form action={disableUiPreviewAction}>
              <button type="submit" className="secondary">Use classic look here</button>
            </form>
          ) : (
            <form action={enableUiPreviewAction}>
              <button type="submit">Back to new look</button>
            </form>
          )}
        </div>

        {stats.activeSeason ? (
          <>
            {countdown && (
              <p className="muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 12 }}>
                {countdown.label}
                {countdown.kind === "no-end-set" && (
                  <>
                    {" - "}
                    <a href={`/admin/seasons/${stats.activeSeason.id}`}>Set an end date</a>
                  </>
                )}
              </p>
            )}
            <div className="grid grid-3">
              <div className="stat"><div className="label">Active season</div><div className="value" style={{ fontSize: 20 }}>{stats.activeSeason.name}</div></div>
              <div className="stat"><div className="label">Divisions</div><div className="value">{stats.activeSeason.divisionCount}</div></div>
              <div className="stat"><div className="label">Matches confirmed</div><div className="value">{stats.confirmedPairings}</div></div>
            </div>
            <div className="grid grid-3" style={{ marginTop: 16 }}>
              <div className="stat"><div className="label">Players (total)</div><div className="value">{stats.totalPlayers}</div></div>
              <div className="stat"><div className="label">Fake players</div><div className="value">{stats.fakePlayerCount}</div></div>
              <div className="stat"><div className="label">Disputed matches</div><div className="value">{stats.disputedPairings}</div></div>
            </div>
          </>
        ) : (
          <div className="card">
            <strong>No active season.</strong>
            <p className="muted">Head to <a href="/admin/seasons">Seasons</a> to start one.</p>
          </div>
        )}
      </main>
    </>
  );
}

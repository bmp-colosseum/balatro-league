"use client";

// The "send to Owen" view: next season projected from the current one, with all
// the signal visible — each player's movement (↑ promoted / ↓ relegated / held /
// NEW), where they came from, last-season standing, BMP vs hidden MMR; and an
// optional schedule view (round-robin at the top, 4 opponents below + SoS).
// Returners are locked to their finish; only rookies fill gaps; Legendary is a
// fixed 6, round-robin.
//
// This is a READ-ONLY snapshot. Hand-moving players is done after "Build season
// →" on the draft-season page, which has the shared drag-and-drop editor — so
// there's one editing surface, not two.

import { useMemo, useState } from "react";
import { generateSchedule, summariseSchedule } from "@/lib/schedule";
import { ConfirmButton } from "@/components/ConfirmButton";
import type { ContinuityDivision } from "@/lib/loaders/continuity";

export function ContinuityPreview({
  divisions,
  returnerCount,
  rookieCount,
  basedOnSeason,
  roundId,
  onBuild,
  roundRobinTop = 2,
}: {
  divisions: ContinuityDivision[];
  returnerCount: number;
  rookieCount: number;
  basedOnSeason: string;
  roundId?: string;
  // Server action: commit this arrangement as a draft season (then drag-edit it).
  onBuild?: (formData: FormData) => void | Promise<void>;
  roundRobinTop?: number; // how many top divisions are round-robin
}) {
  const [showSchedules, setShowSchedules] = useState(false);
  const names = useMemo(() => divisions.map((d) => d.name), [divisions]);

  const view = useMemo(() => {
    return divisions.map((d, divIdx) => {
      const members = d.members.slice().sort((a, b) => {
        if (a.isRookie !== b.isRookie) return a.isRookie ? 1 : -1; // returners first
        return b.mmr - a.mmr;
      });
      const backCount = members.filter((m) => !m.isRookie).length;
      const newCount = members.length - backCount;
      const avgMmr = members.length ? Math.round(members.reduce((s, m) => s + m.mmr, 0) / members.length) : 0;
      let schedule: {
        opponents: Map<string, string[]>;
        sos: Map<string, number>;
        summary: ReturnType<typeof summariseSchedule>;
      } | null = null;
      if (showSchedules && members.length >= 2) {
        const sp = members.map((m) => ({ id: m.discordId, mmr: m.mmr }));
        // Top `roundRobinTop` divisions play a full round-robin; lower divisions
        // use the balanced 4-opponent graph.
        const degree = divIdx < roundRobinTop ? members.length - 1 : 4;
        const r = generateSchedule(sp, { degree, seed: 1 });
        schedule = { opponents: r.opponents, sos: r.sos, summary: summariseSchedule(r, sp, degree) };
      }
      const nameOf = new Map(members.map((m) => [m.discordId, m.displayName]));
      return { name: d.name, divIdx, members, backCount, newCount, avgMmr, schedule, nameOf };
    });
  }, [divisions, showSchedules, roundRobinTop]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Summary */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <strong>Season built from {basedOnSeason}</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {returnerCount + rookieCount} players · {returnerCount} returning · {rookieCount} new · {divisions.length} divisions
          </span>
          <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }}>
            <input type="checkbox" checked={showSchedules} onChange={(e) => setShowSchedules(e.target.checked)} />
            Show schedules
          </label>
        </div>
        <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
          Returners hold their finish division (with promotion ↑ / relegation ↓); only newcomers fill gaps,
          by MMR. <strong>Finishers are never shuffled by size-balancing.</strong> Top division is a fixed 6,
          round-robin. Each row shows movement, last-season standing, <strong>BMP</strong> (balatromp ranked)
          and our <strong>hidden MMR</strong> (right). To hand-move anyone, build it and drag on the season
          page. Nothing here is saved.
        </p>
      </div>

      {/* Divisions */}
      {view.map((d) => (
        <div key={d.name} className="card" style={{ margin: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
            {d.name}{" "}
            <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
              — {d.members.length} players ({d.backCount} back · {d.newCount} new) · avg MMR {d.avgMmr}
              {d.divIdx < roundRobinTop ? " · round-robin" : ""}
              {d.schedule ? ` · SoS ${d.schedule.summary.minSos}–${d.schedule.summary.maxSos} (spread ${d.schedule.summary.spread})` : ""}
            </span>
            {d.divIdx >= roundRobinTop && d.members.length < 5 && (
              <span style={{ fontWeight: 400, marginLeft: 8, color: "var(--accent)", fontSize: 12 }}>
                ⚠ thin (&lt;5)
              </span>
            )}
          </div>
          <div>
            {d.members.map((m, idx) => {
              const promoted = m.fromIndex != null && d.divIdx < m.fromIndex;
              const relegated = m.fromIndex != null && d.divIdx > m.fromIndex;
              const fromName = (promoted || relegated) && m.fromIndex != null ? names[m.fromIndex] : null;
              return (
                <div
                  key={m.discordId}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    padding: "3px 4px",
                    fontSize: 13,
                    borderTop: idx === 0 ? undefined : "1px solid rgba(255,255,255,0.05)",
                  }}
                >
                  {/* movement vs last season */}
                  <span style={{ width: 14, textAlign: "center", color: promoted ? "var(--success)" : relegated ? "var(--danger)" : "var(--muted)" }}>
                    {m.isRookie ? "" : promoted ? "↑" : relegated ? "↓" : "="}
                  </span>
                  <span style={{ flex: "1 1 160px", fontWeight: 500 }}>
                    {m.displayName}
                    {m.isRookie && <span style={{ color: "var(--info)", fontSize: 11, marginLeft: 6 }}>NEW</span>}
                    {fromName && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>← {fromName}</span>}
                  </span>
                  <span className="muted" style={{ fontSize: 11, minWidth: 78, textAlign: "right" }} title="Last-season standing">
                    {m.standing ? `#${m.standing.rank} · ${m.standing.record}` : m.isRookie ? "—" : "no games"}
                  </span>
                  {d.schedule ? (
                    <>
                      <span className="muted" style={{ fontSize: 12, flex: "2 1 220px" }}>
                        vs {(d.schedule.opponents.get(m.discordId) ?? []).map((o) => d.nameOf.get(o) ?? o).join(", ")}
                      </span>
                      <span className="muted" style={{ fontSize: 11, minWidth: 64, textAlign: "right" }}>SoS {d.schedule.sos.get(m.discordId)}</span>
                    </>
                  ) : null}
                  <span className="muted" style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 64, textAlign: "right" }} title="BMP ranked MMR">
                    {m.bmp != null ? `BMP ${m.bmp}` : "BMP —"}
                  </span>
                  <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", minWidth: 48, textAlign: "right", fontWeight: 600 }} title="Hidden MMR">
                    {m.mmr}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Commit: turn this projection into a real draft season, then drag-edit it. */}
      {onBuild && roundId && (
        <form action={onBuild} className="card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", borderColor: "var(--success)" }}>
          <input type="hidden" name="roundId" value={roundId} />
          <input type="hidden" name="moves" value="{}" />
          <strong style={{ color: "var(--success)" }}>Open this to drag &amp; edit</strong>
          <input
            name="subtitle"
            placeholder="Subtitle (optional)"
            style={{ padding: "3px 8px", fontSize: 13, flex: "0 1 220px" }}
          />
          <ConfirmButton
            message="Open the editable arrangement? This creates next season as a DRAFT (not live) so you can drag players between divisions. Nothing goes live until you activate."
            style={{ marginLeft: "auto", padding: "5px 14px", fontWeight: 600 }}
          >
            ✏️ Edit these groupings →
          </ConfirmButton>
          <span className="muted" style={{ fontSize: 11, flexBasis: "100%" }}>
            Opens one editable page: drag players between divisions (saves automatically), then activate.
            Share that page with whoever&apos;s arranging — it&apos;s the only thing they touch.
          </span>
        </form>
      )}
    </div>
  );
}

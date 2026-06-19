"use client";

// The "send to Owen" view: next season built from the current one, with all the
// signal visible — each player's movement (↑ promoted / ↓ relegated / held /
// NEW), where they came from, their last-season standing, and MMR; per-division
// summaries (size, returners vs new, average MMR); and an optional schedule view
// (round-robin at the top, 4 opponents below + SoS spread). Returners are locked
// to their finish; only rookies fill gaps.
//
// Edit mode: an admin (e.g. dunk) can reassign anyone to any division by hand to
// craft the arrangement they want. Sizes, averages, SoS and the round-robin all
// recompute live. Hand-moves are highlighted; "Reset" drops back to the
// algorithm. Nothing is saved — it's a live worksheet to talk over.

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
}: {
  divisions: ContinuityDivision[];
  returnerCount: number;
  rookieCount: number;
  basedOnSeason: string;
  roundId?: string;
  // Server action: commit this arrangement (+ hand-moves) as a draft season.
  onBuild?: (formData: FormData) => void | Promise<void>;
}) {
  const [showSchedules, setShowSchedules] = useState(false);
  const [editing, setEditing] = useState(false);
  // discordId → hand-assigned division index (overrides the computed one).
  const [moves, setMoves] = useState<Record<string, number>>({});

  const names = useMemo(() => divisions.map((d) => d.name), [divisions]);

  // Flatten once: every member tagged with the division the algorithm computed.
  const base = useMemo(
    () => divisions.flatMap((d, divIdx) => d.members.map((m) => ({ ...m, computedDivIdx: divIdx }))),
    [divisions],
  );

  const movedCount = useMemo(
    () => base.filter((m) => (moves[m.discordId] ?? m.computedDivIdx) !== m.computedDivIdx).length,
    [base, moves],
  );

  const view = useMemo(() => {
    return divisions.map((d, divIdx) => {
      const members = base
        .filter((m) => (moves[m.discordId] ?? m.computedDivIdx) === divIdx)
        .sort((a, b) => {
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
        // Legendary (top division) is a full round-robin — everyone plays everyone.
        // Every other division is the balanced 4-opponent graph.
        const degree = divIdx === 0 ? members.length - 1 : 4;
        const r = generateSchedule(sp, { degree, seed: 1 });
        schedule = { opponents: r.opponents, sos: r.sos, summary: summariseSchedule(r, sp, degree) };
      }
      const nameOf = new Map(members.map((m) => [m.discordId, m.displayName]));
      return { name: d.name, divIdx, members, backCount, newCount, avgMmr, schedule, nameOf };
    });
  }, [divisions, base, moves, showSchedules]);

  const moveTo = (id: string, computedDivIdx: number, divIdx: number) =>
    setMoves((prev) => {
      const next = { ...prev };
      if (divIdx === computedDivIdx) delete next[id]; // back to auto
      else next[id] = divIdx;
      return next;
    });
  const resetAll = () => setMoves({});

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Summary */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <strong>Season built from {basedOnSeason}</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {returnerCount + rookieCount} players · {returnerCount} returning · {rookieCount} new · {divisions.length} divisions
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto", flexWrap: "wrap" }}>
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 5 }}>
              <input type="checkbox" checked={showSchedules} onChange={(e) => setShowSchedules(e.target.checked)} />
              Show schedules
            </label>
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 5 }}>
              <input type="checkbox" checked={editing} onChange={(e) => setEditing(e.target.checked)} />
              ✋ Edit placements
            </label>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
          Returners hold their finish division (with promotion ↑ / relegation ↓); only newcomers fill gaps,
          by MMR. <strong>Finishers are never shuffled by size-balancing.</strong> Top division is a fixed 6,
          round-robin. Each row shows movement, last-season standing, <strong>BMP</strong> (balatromp ranked)
          and our <strong>internal MMR</strong> (right). Internal MMR comes from season results once you
          recompute on /admin/mmr. Nothing is saved.
        </p>
        {editing && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
            <span className="pill" style={{ background: "rgba(241,196,15,0.18)", color: "#f1c40f" }}>
              ✋ {movedCount} hand-moved
            </span>
            <button
              type="button"
              onClick={resetAll}
              disabled={movedCount === 0}
              style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "2px 10px", fontSize: 12, color: movedCount === 0 ? "#555" : "#76c7ff", cursor: movedCount === 0 ? "default" : "pointer" }}
            >
              Reset to algorithm
            </button>
            <span className="muted" style={{ fontSize: 11 }}>
              Pick a division per player to move them. Sizes, averages, SoS &amp; the round-robin recompute live.
            </span>
          </div>
        )}
      </div>

      {/* Divisions */}
      {view.map((d) => (
        <div key={d.name} className="card" style={{ margin: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
            {d.name}{" "}
            <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
              — {d.members.length} players ({d.backCount} back · {d.newCount} new) · avg MMR {d.avgMmr}
              {d.divIdx === 0 ? " · round-robin" : ""}
              {d.schedule ? ` · SoS ${d.schedule.summary.minSos}–${d.schedule.summary.maxSos} (spread ${d.schedule.summary.spread})` : ""}
            </span>
            {d.divIdx !== 0 && d.members.length < 5 && (
              <span style={{ fontWeight: 400, marginLeft: 8, color: "#f1c40f", fontSize: 12 }}>
                ⚠ thin (&lt;5)
              </span>
            )}
          </div>
          <div>
            {d.members.map((m, idx) => {
              const promoted = m.fromIndex != null && d.divIdx < m.fromIndex;
              const relegated = m.fromIndex != null && d.divIdx > m.fromIndex;
              const fromName = (promoted || relegated) && m.fromIndex != null ? names[m.fromIndex] : null;
              const handMoved = m.computedDivIdx !== d.divIdx;
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
                    borderLeft: handMoved ? "2px solid #f1c40f" : "2px solid transparent",
                    paddingLeft: 6,
                  }}
                >
                  {/* movement vs last season */}
                  <span style={{ width: 14, textAlign: "center", color: promoted ? "#2ecc71" : relegated ? "#e74c3c" : "#666" }}>
                    {m.isRookie ? "" : promoted ? "↑" : relegated ? "↓" : "="}
                  </span>
                  <span style={{ flex: "1 1 160px", fontWeight: 500 }}>
                    {m.displayName}
                    {m.isRookie && <span style={{ color: "#76c7ff", fontSize: 11, marginLeft: 6 }}>NEW</span>}
                    {fromName && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>← {fromName}</span>}
                    {handMoved && <span style={{ color: "#f1c40f", fontSize: 11, marginLeft: 6 }}>✋ moved from {names[m.computedDivIdx]}</span>}
                  </span>
                  {editing && (
                    <select
                      value={d.divIdx}
                      onChange={(e) => moveTo(m.discordId, m.computedDivIdx, Number(e.target.value))}
                      style={{ fontSize: 11, padding: "1px 2px", maxWidth: 130 }}
                      title="Move to division"
                    >
                      {names.map((nm, i) => (
                        <option key={i} value={i}>{nm}</option>
                      ))}
                    </select>
                  )}
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
                  <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", minWidth: 48, textAlign: "right", fontWeight: 600 }} title="Internal (secret) MMR">
                    {m.mmr}
                  </span>
                </div>
              );
            })}
            {d.members.length === 0 && (
              <div className="muted" style={{ fontSize: 12, padding: "4px 6px" }}>empty</div>
            )}
          </div>
        </div>
      ))}

      {/* Commit: turn this arrangement into a real draft season. */}
      {onBuild && roundId && (
        <form action={onBuild} className="card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", borderColor: "#2ecc71" }}>
          <input type="hidden" name="roundId" value={roundId} />
          <input type="hidden" name="moves" value={JSON.stringify(moves)} />
          <strong style={{ color: "#2ecc71" }}>Build this as the next season</strong>
          <input
            name="subtitle"
            placeholder="Subtitle (optional)"
            style={{ padding: "3px 8px", fontSize: 13, flex: "0 1 220px" }}
          />
          <ConfirmButton
            message={`Build the next season from this exact arrangement${movedCount ? ` (${movedCount} hand-moved)` : ""}? Creates a DRAFT season — you review divisions and activate it next, same as always.`}
            style={{ marginLeft: "auto", padding: "5px 14px", fontWeight: 600 }}
          >
            Build season →
          </ConfirmButton>
          <span className="muted" style={{ fontSize: 11, flexBasis: "100%" }}>
            Creates a draft season (not live) on Owen&apos;s ladder with everyone placed exactly as shown above —
            including your hand-moves. Then you activate it from the season page.
          </span>
        </form>
      )}
    </div>
  );
}

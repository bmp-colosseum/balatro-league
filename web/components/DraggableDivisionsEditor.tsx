"use client";

// Drag-and-drop editor for division placements in draft mode.
// Replaces the per-row Move-to dropdown with grab-the-player /
// drop-on-target-row. Uses pointer events so it works on touch
// + desktop equally.
//
// The Move-to dropdown stays inside each row as a fallback for
// keyboard / screen-reader users — the drag is an enhancement.
//
// Optimistic UI: the dropped player visually moves into the new
// division immediately, then the server action is fired in a
// transition. On failure the state reverts.
//
// Drop targeting is finer than "did we hover the division card":
// we track each row's bounding rect and pick the target index based
// on which row's midpoint the cursor is above (cursor above row N's
// midpoint → insert at N; below → insert at N+1). The cursor below
// the last row maps to index = members.length (append).

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { generateSchedule, scheduleDegree } from "@/lib/schedule";
import { moveDivisionMember, moveDivisionMemberToPosition, setPlayerHiddenMmr } from "@/app/admin/seasons/actions";
import { addExistingPlayerToDivision, addLatePlayerToDivision, deleteDivision } from "@/app/admin/seasons/actions";
import { PlayerSearch, type PlayerOption } from "@/components/PlayerSearch";
import { addDivisionToTier } from "@/app/admin/seasons/actions";
import { Button } from "@/components/ui/button";
import { CopyId } from "@/components/CopyId";

export interface EditorMember {
  id: string;
  playerId: string;
  playerName: string;
  discordId?: string | null; // shown as a click-to-copy chip for admin lookups
  divisionId: string;
  draftOrder: number;
  // Per-row context fields rendered as inline chips. Null = no data
  // (e.g. new player, no BMP profile, first-time signup). The
  // component renders muted placeholders for nulls rather than
  // omitting the chip entirely, so column widths stay stable.
  leagueRating: number | null;
  hiddenMmr: number | null; // the hidden league MMR — unchanged by moves
  bmpMmr: number | null;
  bmpPeak: number | null; // all-time peak BMP MMR
  bmpPeakSeason: string | null; // BMP season of that peak
  bmpTier: string | null;
  priorFinalGlobalRank: number | null;
  // Last season's division as a ladder index (0 = top), for the promotion /
  // relegation marker. null = new this season; undefined = no continuity data
  // (e.g. the plain season page, which doesn't compute it).
  priorDivisionGlobalIndex?: number | null;
  priorDivisionName?: string | null;
  priorStanding?: string | null; // last-season W-L-D record, e.g. "3-1-0"
  priorPoints?: number | null; // last-season points total
  priorRank?: number | null; // finish place in their last-season division (5 = 5th)
  // STATIC outcome from the auto-placement that built this draft (last season's
  // division vs where continuity originally placed them) -- unlike the live
  // MovementMark, this never changes when the TO drags the player afterward.
  // null = no continuity data or a rookie (no earned division).
  priorOutcome?: "promoted" | "relegated" | "same" | null;
  // The division the auto-placement put them in - what they were SUPPOSED to be
  // relegated to (or promoted into), independent of where the TO drags them.
  priorAutoPlacedName?: string | null;
  // The WORST division (highest ladder index) the player is entitled to — their
  // last-season division, or one below if relegated. Dropping them below this
  // means dropping someone who wasn't relegated. null = no floor (rookie).
  floorGlobalIndex?: number | null;
  floorDivisionName?: string | null;
}

export interface EditorDivision {
  id: string;
  name: string;
  tierId: string;
  // Position in the ladder (0 = top). Set where we want live ↑/↓ markers.
  globalIndex?: number;
  // This division's own opponents-per-player override; null/undefined = use
  // the season default passed as `defaultOpponentsPerPlayer`.
  opponentsPerPlayer?: number | null;
}

export interface EditorTier {
  id: string;
  name: string;
  position: number;
  color: { bg: string; fg: string };
}

const tierHeuristic = (avg: number): { color: string; text: string } | null => {
  if (avg < 4) return { color: "var(--danger)", text: "too few players" };
  if (avg > 7) return { color: "var(--danger)", text: "too many — consider adding a division" };
  if (avg < 5) return { color: "var(--accent)", text: "below target" };
  return null;
};

// Colors for the BMP tier chip — mirror balatromp.com's tier names.
// Fall back to a neutral grey for unknown / null tiers.
// BMP tiers (Owen's thresholds, mirrors src/balatromp.ts): Stone < 250, Steel <
// 320, Gold < 460, Lucky < 620, Glass ≥ 620.
function bmpMmrToTier(mmr: number): string {
  if (mmr < 250) return "Stone";
  if (mmr < 320) return "Steel";
  if (mmr < 460) return "Gold";
  if (mmr < 620) return "Lucky";
  return "Glass";
}
// "season3" → "S3"; passthrough anything that doesn't match.
function shortBmpSeason(s: string | null): string {
  if (!s) return "";
  const m = /season\s*(\d+)/i.exec(s);
  return m ? `S${m[1]}` : s;
}
function bmpTierColor(tier: string | null): string {
  if (!tier) return "var(--muted)";
  const t = tier.toLowerCase();
  if (t.includes("glass")) return "#9bdcff";
  if (t.includes("lucky")) return "var(--success)";
  if (t.includes("gold")) return "var(--accent)";
  if (t.includes("steel")) return "var(--muted)";
  if (t.includes("stone")) return "var(--muted)";
  return "var(--muted)";
}

// Shared column template for the member header + rows so they line up.
// handle | Player | MMR | Last season | BMP·peak (cur tier · peak tier) | Finish | Move
const COLS = "14px minmax(80px, 1.1fr) 52px minmax(108px, 1.3fr) minmax(168px, 1.9fr) 42px 84px";

export function DraggableDivisionsEditor({
  seasonId,
  tiers,
  divisions,
  initialMembers,
  allPlayers = [],
  defaultOpponentsPerPlayer = 4,
}: {
  seasonId: string;
  tiers: EditorTier[];
  divisions: EditorDivision[];
  initialMembers: EditorMember[];
  allPlayers?: PlayerOption[];
  defaultOpponentsPerPlayer?: number; // season default opponents/player (for the schedule preview)
}) {
  const [members, setMembers] = useState<EditorMember[]>(initialMembers);
  const [showSchedules, setShowSchedules] = useState(false);
  const [dragPlayerId, setDragPlayerId] = useState<string | null>(null);
  const [hoverDivId, setHoverDivId] = useState<string | null>(null);
  // Index within the hovered division's member list where the
  // dragged row would land if dropped right now. Null = no valid
  // hover yet.
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();
  // Save-status confirmation so an arranger can see their drags + MMR edits stuck.
  const [everSaved, setEverSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const divRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  // Row refs keyed by `${divisionId}:${memberId}` so we can recover
  // both the per-row rect AND its position within the division
  // during pointermove. Cleared and rebuilt on every render via the
  // ref callback below.
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  // The drag has to clear a small movement threshold before we treat it
  // as a real drag — otherwise touching a row to read its name would
  // immediately start dragging.
  const pending = useRef<{ playerId: string; sourceDivId: string; x: number; y: number } | null>(null);

  const startDrag = (playerId: string, sourceDivId: string) => {
    setDragPlayerId(playerId);
    setHoverDivId(sourceDivId);
  };

  const onRowPointerDown = (e: React.PointerEvent, playerId: string, sourceDivId: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pending.current = { playerId, sourceDivId, x: e.clientX, y: e.clientY };
  };

  const onWrapperPointerMove = (e: React.PointerEvent) => {
    if (dragPlayerId === null) {
      if (pending.current) {
        const dx = e.clientX - pending.current.x;
        const dy = e.clientY - pending.current.y;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          startDrag(pending.current.playerId, pending.current.sourceDivId);
        }
      }
      return;
    }
    // Find which division the cursor is over.
    let foundDiv: string | null = null;
    for (const [id, el] of divRefs.current) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left && e.clientX <= r.right) {
        foundDiv = id;
        break;
      }
    }
    if (foundDiv !== hoverDivId) setHoverDivId(foundDiv);

    // Find which row in that division the cursor is over (by
    // midpoint). Cursor above row N's midpoint → index = N;
    // below → index = N+1. Past the last row → append.
    let foundIndex: number | null = null;
    if (foundDiv) {
      const divMembers = byDivision.get(foundDiv) ?? [];
      let landed = false;
      for (let i = 0; i < divMembers.length; i++) {
        const m = divMembers[i]!;
        const el = rowRefs.current.get(`${foundDiv}:${m.id}`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const mid = (r.top + r.bottom) / 2;
        if (e.clientY < mid) {
          foundIndex = i;
          landed = true;
          break;
        }
      }
      if (!landed) foundIndex = divMembers.length;
    }
    if (foundIndex !== hoverIndex) setHoverIndex(foundIndex);

    if (e.pointerType === "touch") e.preventDefault();
  };

  const finishDrag = () => {
    if (dragPlayerId === null || hoverDivId === null || hoverIndex === null) {
      cancelDrag();
      return;
    }
    const playerId = dragPlayerId;
    const targetDivId = hoverDivId;
    const targetIndex = hoverIndex;
    const sourceMember = members.find((m) => m.playerId === playerId);
    if (!sourceMember) {
      cancelDrag();
      return;
    }

    // Compute the post-move membership shape so the optimistic
    // update matches what the server will produce. We rebuild the
    // dragged member's divisionId + draftOrder, then renumber
    // draftOrder in the target division (and source if cross-div)
    // to match the spliced sequence.
    const isCrossDiv = sourceMember.divisionId !== targetDivId;
    const targetMembers = members
      .filter((m) => m.divisionId === targetDivId && m.playerId !== playerId)
      .sort((a, b) => a.draftOrder - b.draftOrder);
    const insertAt = Math.max(0, Math.min(targetIndex, targetMembers.length));

    // Cheap no-op detection: same-division drop on its current slot
    // doesn't need a server roundtrip.
    if (!isCrossDiv) {
      const currentIdx = members
        .filter((m) => m.divisionId === targetDivId)
        .sort((a, b) => a.draftOrder - b.draftOrder)
        .findIndex((m) => m.playerId === playerId);
      if (currentIdx === insertAt) {
        cancelDrag();
        return;
      }
    }

    const prevMembers = members;
    const newTargetOrder = [
      ...targetMembers.slice(0, insertAt),
      sourceMember,
      ...targetMembers.slice(insertAt),
    ];
    const targetById = new Map<string, number>();
    newTargetOrder.forEach((m, i) => targetById.set(m.playerId, i));
    const nextMembers = members.map((m): EditorMember => {
      if (m.playerId === playerId) {
        return { ...m, divisionId: targetDivId, draftOrder: insertAt };
      }
      if (m.divisionId === targetDivId) {
        return { ...m, draftOrder: targetById.get(m.playerId) ?? m.draftOrder };
      }
      return m;
    });

    setMembers(nextMembers);
    setDragPlayerId(null);
    setHoverDivId(null);
    setHoverIndex(null);
    pending.current = null;

    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append("seasonId", seasonId);
        fd.append("playerId", playerId);
        fd.append("targetDivisionId", targetDivId);
        fd.append("targetIndex", String(insertAt));
        await moveDivisionMemberToPosition(fd);
        setSaveError(null);
        setEverSaved(true);
      } catch (err) {
        console.warn("[draggable-divisions] move failed, reverting:", err);
        setSaveError("move didn't save");
        setMembers(prevMembers);
      }
    });
  };

  const cancelDrag = () => {
    setDragPlayerId(null);
    setHoverDivId(null);
    setHoverIndex(null);
    pending.current = null;
  };

  // Inline hidden-MMR edit: optimistic local update + persist. Blank clears it.
  const saveMmr = (playerId: string, raw: string) => {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : Math.max(0, Math.floor(Number(trimmed)));
    if (trimmed !== "" && !Number.isFinite(value as number)) return;
    setMembers((prev) => prev.map((mm) => (mm.playerId === playerId ? { ...mm, hiddenMmr: value } : mm)));
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append("playerId", playerId);
        fd.append("mmr", value == null ? "" : String(value));
        await setPlayerHiddenMmr(fd);
        setSaveError(null);
        setEverSaved(true);
      } catch (err) {
        console.warn("[draggable-divisions] MMR save failed:", err);
        setSaveError("MMR didn't save");
      }
    });
  };

  // Bucket members by division for rendering. Within a division
  // they're sorted by draftOrder so optimistic reorders surface
  // immediately without waiting for the server response.
  const byDivision = new Map<string, EditorMember[]>();
  for (const m of members) {
    const arr = byDivision.get(m.divisionId) ?? [];
    arr.push(m);
    byDivision.set(m.divisionId, arr);
  }
  for (const arr of byDivision.values()) {
    arr.sort((a, b) => a.draftOrder - b.draftOrder);
  }

  const nameById = useMemo(() => new Map(members.map((m) => [m.playerId, m.playerName])), [members]);
  // Projected schedule per division for the CURRENT arrangement (recomputed live
  // as you drag): each division's own opponents-per-player override, or the
  // season default, clamped to size-1. Unseeded MMRs fall back to the division
  // average.
  const scheduleByDiv = useMemo(() => {
    const out = new Map<string, { opponents: Map<string, string[]>; sos: Map<string, number> }>();
    if (!showSchedules) return out;
    const byDiv = new Map<string, EditorMember[]>();
    for (const m of members) (byDiv.get(m.divisionId) ?? byDiv.set(m.divisionId, []).get(m.divisionId)!).push(m);
    for (const d of divisions) {
      const mems = byDiv.get(d.id) ?? [];
      if (mems.length < 2) continue;
      const seeded = mems.map((m) => m.hiddenMmr).filter((x): x is number => x != null);
      const avg = seeded.length ? Math.round(seeded.reduce((a, b) => a + b, 0) / seeded.length) : 1000;
      const sp = mems.map((m) => ({ id: m.playerId, mmr: m.hiddenMmr ?? avg }));
      const degree = scheduleDegree(d.opponentsPerPlayer ?? null, defaultOpponentsPerPlayer, mems.length);
      const r = generateSchedule(sp, { degree, seed: 1 });
      out.set(d.id, { opponents: r.opponents, sos: r.sos });
    }
    return out;
  }, [members, divisions, showSchedules, defaultOpponentsPerPlayer]);

  return (
    <div
      onPointerMove={onWrapperPointerMove}
      onPointerUp={finishDrag}
      onPointerLeave={finishDrag}
      onPointerCancel={cancelDrag}
    >
      {/* The per-row move dropdown is a keyboard/SR fallback for the drag.
          Hide it until the row is hovered or the control is focused so it
          stops cluttering every row; always show it on touch (no hover). */}
      <style>{`
        .dd-move { opacity: 0; transition: opacity 120ms; }
        .dd-row:hover .dd-move, .dd-move:focus { opacity: 1; }
        @media (hover: none) { .dd-move { opacity: 1; } }
      `}</style>
      {/* Save-status confirmation — drags + MMR edits persist automatically;
          this is the proof they stuck. */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 12,
          fontSize: 12,
          height: 20,
          marginBottom: 4,
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 5, marginRight: "auto" }}>
          <input type="checkbox" checked={showSchedules} onChange={(e) => setShowSchedules(e.target.checked)} />
          📅 Show schedules
        </label>
        {saveError ? (
          <span style={{ color: "var(--danger)" }}>⚠ {saveError} — refresh and retry</span>
        ) : isPending ? (
          <span className="muted">Saving…</span>
        ) : everSaved ? (
          <span style={{ color: "var(--success)" }}>✓ Saved</span>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>Changes save automatically</span>
        )}
      </div>
      {tiers.map((tier) => {
        const tierDivs = divisions.filter((d) => d.tierId === tier.id);
        const tierMemberCount = tierDivs.reduce((sum, d) => sum + (byDivision.get(d.id)?.length ?? 0), 0);
        const target = tierDivs.length * 6;
        const avgPerDiv = tierDivs.length === 0 ? 0 : tierMemberCount / tierDivs.length;
        const warning = tierDivs.length === 0 ? null : tierHeuristic(avgPerDiv);
        return (
          <div key={tier.id} style={{ marginTop: 12 }}>
            <h4 style={{ margin: "8px 0 4px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="pill" style={{ background: tier.color.bg, color: tier.color.fg }}>{tier.name}</span>
              <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                {tierMemberCount} player{tierMemberCount === 1 ? "" : "s"} across {tierDivs.length} division{tierDivs.length === 1 ? "" : "s"}
                {tierDivs.length > 0 && ` · ~${avgPerDiv.toFixed(1)}/div (target 5–6, capacity ${target})`}
              </span>
              {warning && <span style={{ fontSize: 11, color: warning.color }}>⚠ {warning.text}</span>}
              <form
                action={addDivisionToTier}
                onPointerDown={(e) => e.stopPropagation()}
                style={{ marginLeft: "auto" }}
              >
                <input type="hidden" name="seasonId" value={seasonId} />
                <input type="hidden" name="tierId" value={tier.id} />
                <Button type="submit" variant="secondary" style={{ fontSize: 11, padding: "2px 8px" }}>
                  + Add division
                </Button>
              </form>
            </h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(580px, 1fr))", gap: 8 }}>
              {tierDivs.map((d) => {
                const divMembers = byDivision.get(d.id) ?? [];
                const isDropTarget = hoverDivId === d.id && dragPlayerId !== null;
                const currentDivOfDrag = dragPlayerId
                  ? members.find((m) => m.playerId === dragPlayerId)?.divisionId
                  : null;
                const isValidDrop = isDropTarget;
                // Active drop index — only render the indicator
                // line if we're actively hovering this division AND
                // dragging.
                const activeIndex = isDropTarget ? hoverIndex : null;
                return (
                  <div
                    key={d.id}
                    ref={(el) => { divRefs.current.set(d.id, el); }}
                    className="card"
                    style={{
                      margin: 0,
                      outline: isValidDrop ? (currentDivOfDrag === d.id ? "2px solid #76c7ff" : "2px solid #2ecc71") : undefined,
                      background: isValidDrop ? (currentDivOfDrag === d.id ? "rgba(118,199,255,0.04)" : "rgba(46,204,113,0.05)") : undefined,
                      transition: "outline 100ms, background 100ms",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <strong>
                        <Link href={`/divisions/${d.id}`} style={{ textDecoration: "none" }}>{d.name}</Link>
                      </strong>
                      <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
                        {divMembers.length} member{divMembers.length === 1 ? "" : "s"}
                      </span>
                      {divMembers.length === 0 && (
                        <form
                          action={deleteDivision}
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          <input type="hidden" name="divisionId" value={d.id} />
                          <button
                            type="submit"
                            className="link-action"
                            style={{ color: "var(--danger)", fontSize: 11 }}
                            title="Delete this empty division (draft mode only)"
                          >
                            delete
                          </button>
                        </form>
                      )}
                    </div>
                    {divMembers.length === 0 ? (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4, padding: 12, border: "1px dashed var(--border)", borderRadius: 4, textAlign: "center" }}>
                        {isValidDrop ? "Drop here" : "Empty division — drag a player here"}
                      </div>
                    ) : (
                      <div style={{ marginTop: 4 }}>
                        {/* Column headers */}
                        <div
                          className="muted"
                          style={{ display: "grid", gridTemplateColumns: COLS, gap: 8, fontSize: 10, padding: "0 4px 3px", borderBottom: "1px solid var(--border)" }}
                        >
                          <span />
                          <span>Player</span>
                          <span style={{ textAlign: "right" }} title="Hidden league MMR">MMR</span>
                          <span>Last season</span>
                          <span title="balatromp ranked MMR (current) · all-time peak">BMP · peak</span>
                          <span style={{ textAlign: "right" }} title="Overall finish last season (1 = top across all divisions)">Finish</span>
                          <span>Move</span>
                        </div>
                        {divMembers.map((m, idx) => {
                          const isDragged = dragPlayerId === m.playerId;
                          const showLineAbove = activeIndex === idx;
                          return (
                            <div key={m.id}>
                            <div
                              className="dd-row"
                              ref={(el) => { rowRefs.current.set(`${d.id}:${m.id}`, el); }}
                              onPointerDown={(e) => onRowPointerDown(e, m.playerId, d.id)}
                              style={{
                                display: "grid",
                                gridTemplateColumns: COLS,
                                alignItems: "center",
                                gap: 8,
                                padding: "4px",
                                cursor: isDragged ? "grabbing" : "grab",
                                opacity: isDragged ? 0.4 : 1,
                                touchAction: "none",
                                userSelect: "none",
                                fontSize: 12,
                                borderRadius: 3,
                                borderTop: showLineAbove ? "2px solid #76c7ff" : "2px solid transparent",
                              }}
                            >
                              <span style={{ color: "var(--muted)" }} title="Drag to move">⋮⋮</span>
                              <div style={{ display: "grid", minWidth: 0 }}>
                                <Link
                                  href={`/profile/${m.playerId}`}
                                  style={{ color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                                  onPointerDown={(e) => e.stopPropagation()}
                                >
                                  {m.playerName}
                                </Link>
                                {m.discordId && <CopyId id={m.discordId} style={{ justifySelf: "start" }} />}
                              </div>
                              <input
                                type="number"
                                title="Hidden league MMR — edit to set (moving a player never changes it)"
                                value={m.hiddenMmr ?? ""}
                                onPointerDown={(e) => e.stopPropagation()}
                                onChange={(e) =>
                                  setMembers((prev) =>
                                    prev.map((mm) =>
                                      mm.playerId === m.playerId
                                        ? { ...mm, hiddenMmr: e.target.value === "" ? null : Number(e.target.value) }
                                        : mm,
                                    ),
                                  )
                                }
                                onBlur={(e) => saveMmr(m.playerId, e.target.value)}
                                style={{
                                  width: "100%",
                                  fontSize: 11,
                                  padding: "1px 3px",
                                  textAlign: "right",
                                  color: m.hiddenMmr == null ? "var(--accent)" : "var(--success)",
                                  fontWeight: 600,
                                  background: "transparent",
                                  border: `1px solid ${m.hiddenMmr == null ? "rgba(241,196,15,0.4)" : "rgba(46,204,113,0.3)"}`,
                                  borderRadius: 3,
                                }}
                              />
                              {/* Last season: movement + static outcome badge + prior division + record + points + floor warning */}
                              <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, overflow: "hidden" }}>
                                <MovementMark member={m} currentGlobalIndex={d.globalIndex} />
                                <PriorOutcomeBadge member={m} />
                                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {m.priorDivisionName ?? ""}
                                  {/* Where they were SUPPOSED to land, e.g. "Common 4 -> Common 5". */}
                                  {(m.priorOutcome === "relegated" || m.priorOutcome === "promoted") && m.priorAutoPlacedName && (
                                    <span
                                      className="muted"
                                      title={m.priorOutcome === "relegated" ? "Was due to drop into this division" : "Was due to rise into this division"}
                                    >
                                      {" -> "}{m.priorAutoPlacedName}
                                    </span>
                                  )}
                                  {m.priorStanding && (
                                    <span className="muted" style={{ marginLeft: 4 }}>{m.priorStanding}</span>
                                  )}
                                  {m.priorPoints != null && (
                                    <span className="muted" style={{ marginLeft: 4 }}>{m.priorPoints} pts</span>
                                  )}
                                </span>
                                <FloorWarn member={m} currentGlobalIndex={d.globalIndex} />
                              </span>
                              <span
                                title={`BMP ranked MMR (current)${m.bmpTier ? ` ${m.bmpTier}` : ""} · all-time peak ${m.bmpPeak != null ? `${m.bmpPeak} ${bmpMmrToTier(m.bmpPeak)}${m.bmpPeakSeason ? ` (BMP ${m.bmpPeakSeason})` : ""}` : "—"}`}
                                style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                              >
                                <span style={{ color: bmpTierColor(m.bmpTier) }}>
                                  {m.bmpMmr ?? "—"}
                                  {m.bmpTier ? ` ${m.bmpTier}` : ""}
                                </span>
                                {m.bmpPeak != null && (
                                  <span style={{ color: bmpTierColor(bmpMmrToTier(m.bmpPeak)) }}>
                                    {" · pk "}
                                    {m.bmpPeak} {bmpMmrToTier(m.bmpPeak)}
                                    {m.bmpPeakSeason && <span className="muted"> {shortBmpSeason(m.bmpPeakSeason)}</span>}
                                  </span>
                                )}
                              </span>
                              <span title="Overall finish last season (across all divisions)" style={{ fontSize: 11, textAlign: "right", color: m.priorRank == null ? "var(--muted)" : "var(--text)" }}>
                                {m.priorRank == null ? "—" : `#${m.priorRank}`}
                              </span>
                              <select
                                title="Move to another division"
                                onPointerDown={(e) => e.stopPropagation()}
                                onChange={async (e) => {
                                  const targetDivisionId = e.currentTarget.value;
                                  if (!targetDivisionId) return;
                                  const prev = members;
                                  setMembers(members.map((mm) => mm.playerId === m.playerId ? { ...mm, divisionId: targetDivisionId } : mm));
                                  startTransition(async () => {
                                    try {
                                      const fd = new FormData();
                                      fd.append("seasonId", seasonId);
                                      fd.append("playerId", m.playerId);
                                      fd.append("targetDivisionId", targetDivisionId);
                                      await moveDivisionMember(fd);
                                      setSaveError(null);
                                      setEverSaved(true);
                                    } catch {
                                      setSaveError("move didn't save");
                                      setMembers(prev);
                                    }
                                  });
                                  e.currentTarget.value = "";
                                }}
                                defaultValue=""
                                style={{ width: "100%", fontSize: 11, padding: "1px 2px" }}
                              >
                                <option value="" disabled>move…</option>
                                {divisions.filter((other) => other.id !== d.id).map((other) => (
                                  <option key={other.id} value={other.id}>{other.name}</option>
                                ))}
                              </select>
                            </div>
                            {showSchedules && scheduleByDiv.get(d.id) && (
                              <div style={{ fontSize: 10, color: "var(--muted)", padding: "0 4px 4px 24px", lineHeight: 1.3 }}>
                                vs {(scheduleByDiv.get(d.id)!.opponents.get(m.playerId) ?? []).map((id) => nameById.get(id) ?? id).join(", ") || "—"}
                                <span style={{ marginLeft: 6 }}>· SoS {scheduleByDiv.get(d.id)!.sos.get(m.playerId) ?? "—"}</span>
                              </div>
                            )}
                            </div>
                          );
                        })}
                        {/* Implicit drop target after the last row.
                            When the cursor is past the last row's
                            midpoint, activeIndex === divMembers.length
                            and we render the bottom indicator line. */}
                        {activeIndex === divMembers.length && (
                          <div style={{ borderTop: "2px solid #76c7ff", margin: "0 4px" }} />
                        )}
                      </div>
                    )}
                    {/* Both add-player paths folded behind one toggle so the
                        card stays quiet until you actually want to add someone. */}
                    <AddPlayerControls divisionId={d.id} allPlayers={allPlayers} />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Per-division "add player" controls, collapsed behind a single "+ Add
// player" link so each card is clean by default. Expands to both paths:
// add by Discord ID (late signup) or search an existing player.
function AddPlayerControls({
  divisionId,
  allPlayers,
}: {
  divisionId: string;
  allPlayers: PlayerOption[];
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className="link-action"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen(true)}
        style={{ color: "var(--info)", fontSize: 11, marginTop: 6 }}
      >
        + Add player
      </button>
    );
  }
  return (
    <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
      <form
        action={addLatePlayerToDivision}
        onPointerDown={(e) => e.stopPropagation()}
        style={{ display: "flex", gap: 4, fontSize: 11 }}
      >
        <input type="hidden" name="divisionId" value={divisionId} />
        <input
          type="text"
          name="discordId"
          placeholder="+ Discord ID (17-20 digits)"
          required
          pattern="\d{17,20}"
          style={{ flex: 1, fontSize: 11, padding: "1px 4px" }}
        />
        <Button type="submit" variant="secondary" style={{ fontSize: 11, padding: "1px 6px" }}>Add</Button>
      </form>
      {allPlayers.length > 0 && (
        <form
          action={addExistingPlayerToDivision}
          onPointerDown={(e) => e.stopPropagation()}
          style={{ display: "flex", gap: 4, fontSize: 11 }}
        >
          <input type="hidden" name="divisionId" value={divisionId} />
          <PlayerSearch players={allPlayers} name="playerId" placeholder="+ search existing player…" />
          <Button type="submit" variant="secondary" style={{ fontSize: 11, padding: "1px 6px" }}>Add</Button>
        </form>
      )}
      <button
        type="button"
        className="link-action"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen(false)}
        style={{ color: "var(--muted)", fontSize: 10, justifySelf: "start" }}
      >
        done
      </button>
    </div>
  );
}

// Live promotion/relegation marker: compares the player's CURRENT division
// (where they are right now, updates as you drag) to their last-season division.
// ↑ promoted (green), ↓ relegated (red), = same level, NEW (blue). Renders
// nothing when there's no continuity data (priorDivisionGlobalIndex undefined).
function MovementMark({ member, currentGlobalIndex }: { member: EditorMember; currentGlobalIndex?: number }) {
  if (member.priorDivisionGlobalIndex === undefined) return null;
  if (member.priorDivisionGlobalIndex === null) {
    return (
      <span title="New this season" style={{ color: "var(--info)", fontSize: 9, fontWeight: 700, width: 12, textAlign: "center" }}>
        NEW
      </span>
    );
  }
  if (currentGlobalIndex === undefined) return null;
  const prior = member.priorDivisionGlobalIndex;
  const dir = currentGlobalIndex < prior ? "up" : currentGlobalIndex > prior ? "down" : "same";
  const sym = dir === "up" ? "↑" : dir === "down" ? "↓" : "=";
  const color = dir === "up" ? "var(--success)" : dir === "down" ? "var(--danger)" : "var(--muted)";
  const title =
    `Last season: ${member.priorDivisionName ?? "—"}` +
    (member.priorStanding ? ` (${member.priorStanding})` : "") +
    (dir === "up" ? " — promoted" : dir === "down" ? " — relegated" : " — same level") +
    (member.floorDivisionName ? ` · floor: ${member.floorDivisionName}` : "");
  return (
    <span title={title} style={{ color, fontWeight: 700, width: 12, textAlign: "center" }}>
      {sym}
    </span>
  );
}

// STATIC last-season outcome badge: pinned to the auto-placement's original
// comparison (last season's division vs where continuity FIRST put them), so
// it does NOT change when the TO drags the player afterward -- unlike the
// live MovementMark above, which tracks the CURRENT/dragged division. This is
// informational only (it's fine to move a relegated player back up), so it
// stays a small tag rather than a warning. Renders nothing for "same" or no
// data.
function PriorOutcomeBadge({ member }: { member: EditorMember }) {
  if (member.priorOutcome === "relegated") {
    return (
      <span
        title={`Was relegated last season${member.priorAutoPlacedName ? ` -- should drop to ${member.priorAutoPlacedName}` : ""} -- pinned regardless of where they're dragged.`}
        style={{ color: "var(--danger)", fontSize: 9, fontWeight: 700 }}
      >
        REL
      </span>
    );
  }
  if (member.priorOutcome === "promoted") {
    return (
      <span
        title={`Was promoted last season${member.priorAutoPlacedName ? ` -- should rise to ${member.priorAutoPlacedName}` : ""} -- pinned regardless of where they're dragged.`}
        style={{ color: "var(--success)", fontSize: 9, fontWeight: 700 }}
      >
        PRO
      </span>
    );
  }
  return null;
}

// Floor warning: a player below the WORST division they're entitled to (their
// last-season division, or one lower if relegated) gets a red ⚠ — they're being
// dropped without having been relegated.
function FloorWarn({ member, currentGlobalIndex }: { member: EditorMember; currentGlobalIndex?: number }) {
  const floor = member.floorGlobalIndex;
  if (floor == null || currentGlobalIndex === undefined) return null;
  if (currentGlobalIndex <= floor) return null; // at or above their floor — fine
  return (
    <span
      title={`Below their floor — entitled to at least ${member.floorDivisionName ?? "their earned division"} (they weren't relegated).`}
      style={{ color: "var(--danger)", fontWeight: 700 }}
    >
      ⚠
    </span>
  );
}


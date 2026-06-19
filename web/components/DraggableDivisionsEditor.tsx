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
import { useRef, useState, useTransition } from "react";
import { moveDivisionMember, moveDivisionMemberToPosition, setPlayerHiddenMmr } from "@/app/admin/seasons/actions";
import { addExistingPlayerToDivision, addLatePlayerToDivision, deleteDivision } from "@/app/admin/seasons/actions";
import { PlayerSearch, type PlayerOption } from "@/components/PlayerSearch";
import { addDivisionToTier } from "@/app/admin/seasons/actions";

export interface EditorMember {
  id: string;
  playerId: string;
  playerName: string;
  divisionId: string;
  draftOrder: number;
  // Per-row context fields rendered as inline chips. Null = no data
  // (e.g. new player, no BMP profile, first-time signup). The
  // component renders muted placeholders for nulls rather than
  // omitting the chip entirely, so column widths stay stable.
  leagueRating: number | null;
  hiddenMmr: number | null; // the secret league MMR — unchanged by moves
  bmpMmr: number | null;
  bmpTier: string | null;
  priorFinalGlobalRank: number | null;
  // Last season's division as a ladder index (0 = top), for the promotion /
  // relegation marker. null = new this season; undefined = no continuity data
  // (e.g. the plain season page, which doesn't compute it).
  priorDivisionGlobalIndex?: number | null;
  priorDivisionName?: string | null;
  priorStanding?: string | null; // e.g. "#3 · 3-1-0"
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
}

export interface EditorTier {
  id: string;
  name: string;
  position: number;
  color: { bg: string; fg: string };
}

const TIER_GOOD = { color: "#2ecc71", label: "on target" };
const tierHeuristic = (avg: number): { color: string; text: string } | null => {
  if (avg < 4) return { color: "#e74c3c", text: "too few players" };
  if (avg > 7) return { color: "#e74c3c", text: "too many — consider adding a division" };
  if (avg < 5) return { color: "#f1c40f", text: "below target" };
  void TIER_GOOD;
  return null;
};

// Colors for the BMP tier chip — mirror balatromp.com's tier names.
// Fall back to a neutral grey for unknown / null tiers.
function bmpTierColor(tier: string | null): string {
  if (!tier) return "#888";
  const t = tier.toLowerCase();
  if (t.includes("diamond")) return "#76c7ff";
  if (t.includes("platinum")) return "#c0c8cb";
  if (t.includes("gold")) return "#f1c40f";
  if (t.includes("silver")) return "#bdc3c7";
  if (t.includes("bronze")) return "#cd7f32";
  if (t.includes("glass")) return "#9bdcff";
  return "#888";
}

export function DraggableDivisionsEditor({
  seasonId,
  tiers,
  divisions,
  initialMembers,
  allPlayers = [],
}: {
  seasonId: string;
  tiers: EditorTier[];
  divisions: EditorDivision[];
  initialMembers: EditorMember[];
  allPlayers?: PlayerOption[];
}) {
  const [members, setMembers] = useState<EditorMember[]>(initialMembers);
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
          fontSize: 12,
          height: 20,
          marginBottom: 4,
        }}
      >
        {saveError ? (
          <span style={{ color: "#e74c3c" }}>⚠ {saveError} — refresh and retry</span>
        ) : isPending ? (
          <span className="muted">Saving…</span>
        ) : everSaved ? (
          <span style={{ color: "#2ecc71" }}>✓ Saved</span>
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
                <button type="submit" className="secondary" style={{ fontSize: 11, padding: "2px 8px" }}>
                  + Add division
                </button>
              </form>
            </h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 8 }}>
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
                            className="muted"
                            style={{
                              background: "none",
                              border: "none",
                              color: "#e74c3c",
                              cursor: "pointer",
                              fontSize: 11,
                              padding: 0,
                            }}
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
                        {divMembers.map((m, idx) => {
                          const isDragged = dragPlayerId === m.playerId;
                          const showLineAbove = activeIndex === idx;
                          return (
                            <div
                              key={m.id}
                              className="dd-row"
                              ref={(el) => { rowRefs.current.set(`${d.id}:${m.id}`, el); }}
                              onPointerDown={(e) => onRowPointerDown(e, m.playerId, d.id)}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                padding: "3px 4px",
                                cursor: isDragged ? "grabbing" : "grab",
                                opacity: isDragged ? 0.4 : 1,
                                touchAction: "none",
                                userSelect: "none",
                                fontSize: 12,
                                borderRadius: 3,
                                borderTop: showLineAbove ? "2px solid #76c7ff" : "2px solid transparent",
                              }}
                            >
                              <span style={{ color: "#888" }} title="Drag to move">⋮⋮</span>
                              <MovementMark member={m} currentGlobalIndex={d.globalIndex} />
                              <FloorWarn member={m} currentGlobalIndex={d.globalIndex} />
                              <Link
                                href={`/profile/${m.playerId}`}
                                style={{ color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "1 1 auto", minWidth: 110 }}
                                onPointerDown={(e) => e.stopPropagation()}
                              >
                                {m.playerName}
                              </Link>
                              <label
                                title="Hidden league MMR — edit to set (moving a player never changes it)"
                                style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 10, color: "#2ecc71" }}
                                onPointerDown={(e) => e.stopPropagation()}
                              >
                                MMR
                                <input
                                  type="number"
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
                                    width: 48,
                                    fontSize: 11,
                                    padding: "0 2px",
                                    textAlign: "right",
                                    color: "#2ecc71",
                                    fontWeight: 600,
                                    background: "transparent",
                                    border: "1px solid rgba(46,204,113,0.3)",
                                    borderRadius: 3,
                                  }}
                                />
                              </label>
                              <MemberChips member={m} />
                              <select
                                className="dd-move"
                                title="Or pick a target division from the dropdown (accessibility fallback)"
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
                                style={{ marginLeft: 4, fontSize: 11, padding: "1px 4px", maxWidth: 72 }}
                              >
                                <option value="" disabled>↪</option>
                                {divisions.filter((other) => other.id !== d.id).map((other) => (
                                  <option key={other.id} value={other.id}>{other.name}</option>
                                ))}
                              </select>
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
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen(true)}
        style={{ background: "none", border: "none", color: "#76c7ff", cursor: "pointer", fontSize: 11, padding: 0, marginTop: 6 }}
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
        <button type="submit" className="secondary" style={{ fontSize: 11, padding: "1px 6px" }}>Add</button>
      </form>
      {allPlayers.length > 0 && (
        <form
          action={addExistingPlayerToDivision}
          onPointerDown={(e) => e.stopPropagation()}
          style={{ display: "flex", gap: 4, fontSize: 11 }}
        >
          <input type="hidden" name="divisionId" value={divisionId} />
          <PlayerSearch players={allPlayers} name="playerId" placeholder="+ search existing player…" />
          <button type="submit" className="secondary" style={{ fontSize: 11, padding: "1px 6px" }}>Add</button>
        </form>
      )}
      <button
        type="button"
        className="muted"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen(false)}
        style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 10, padding: 0, justifySelf: "start" }}
      >
        done
      </button>
    </div>
  );
}

// Inline per-row context chips: league rank, BMP MMR + tier, and
// (for returners only) prior-season finishing global rank. Compact
// styling — 11px chips, neutral palette — so they fit on a 280px
// division card without breaking the layout.
// Live promotion/relegation marker: compares the player's CURRENT division
// (where they are right now, updates as you drag) to their last-season division.
// ↑ promoted (green), ↓ relegated (red), = same level, NEW (blue). Renders
// nothing when there's no continuity data (priorDivisionGlobalIndex undefined).
function MovementMark({ member, currentGlobalIndex }: { member: EditorMember; currentGlobalIndex?: number }) {
  if (member.priorDivisionGlobalIndex === undefined) return null;
  if (member.priorDivisionGlobalIndex === null) {
    return (
      <span title="New this season" style={{ color: "#76c7ff", fontSize: 9, fontWeight: 700, width: 12, textAlign: "center" }}>
        NEW
      </span>
    );
  }
  if (currentGlobalIndex === undefined) return null;
  const prior = member.priorDivisionGlobalIndex;
  const dir = currentGlobalIndex < prior ? "up" : currentGlobalIndex > prior ? "down" : "same";
  const sym = dir === "up" ? "↑" : dir === "down" ? "↓" : "=";
  const color = dir === "up" ? "#2ecc71" : dir === "down" ? "#e74c3c" : "#666";
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
      style={{ color: "#e74c3c", fontWeight: 700 }}
    >
      ⚠
    </span>
  );
}

function MemberChips({ member }: { member: EditorMember }) {
  const tierColor = bmpTierColor(member.bmpTier);
  return (
    <span
      style={{
        marginLeft: "auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        whiteSpace: "nowrap",
      }}
    >
      <span
        title="Current league rank (Player.rating)"
        style={{
          color: member.leagueRating == null ? "#666" : "var(--text)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {member.leagueRating == null ? "L —" : `L#${member.leagueRating}`}
      </span>
      {member.bmpMmr != null && (
        <span
          title={`Latest BMP MMR${member.bmpTier ? ` (${member.bmpTier})` : ""}`}
          style={{
            color: tierColor,
            fontVariantNumeric: "tabular-nums",
            background: "rgba(255,255,255,0.04)",
            padding: "0 4px",
            borderRadius: 3,
          }}
        >
          🃏 {member.bmpMmr}
          {member.bmpTier ? <span style={{ marginLeft: 2, opacity: 0.85 }}>{member.bmpTier}</span> : null}
        </span>
      )}
      {member.priorFinalGlobalRank != null && (
        <span
          className="muted"
          title="Global rank when their last season ended"
          style={{ fontSize: 10, fontVariantNumeric: "tabular-nums" }}
        >
          (was #{member.priorFinalGlobalRank})
        </span>
      )}
    </span>
  );
}

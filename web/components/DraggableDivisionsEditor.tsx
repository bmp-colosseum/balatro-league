"use client";

// Drag-and-drop editor for division placements in draft mode.
// Replaces the per-row Move-to dropdown with grab-the-player /
// drop-on-target-division. Uses pointer events so it works on touch
// + desktop equally.
//
// The Move-to dropdown stays inside each row as a fallback for
// keyboard / screen-reader users — the drag is an enhancement.
//
// Optimistic UI: the dropped player visually moves into the new
// division immediately, then the server action is fired in a
// transition. On failure the state reverts.

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { moveDivisionMember } from "@/app/admin/seasons/actions";
import { addLatePlayerToDivision } from "@/app/admin/seasons/actions";

export interface EditorMember {
  id: string;
  playerId: string;
  playerName: string;
  divisionId: string;
}

export interface EditorDivision {
  id: string;
  name: string;
  tierId: string;
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

export function DraggableDivisionsEditor({
  seasonId,
  tiers,
  divisions,
  initialMembers,
}: {
  seasonId: string;
  tiers: EditorTier[];
  divisions: EditorDivision[];
  initialMembers: EditorMember[];
}) {
  const [members, setMembers] = useState<EditorMember[]>(initialMembers);
  const [dragPlayerId, setDragPlayerId] = useState<string | null>(null);
  const [hoverDivId, setHoverDivId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const divRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
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
    // Find which division the cursor is over
    let found: string | null = null;
    for (const [id, el] of divRefs.current) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left && e.clientX <= r.right) {
        found = id;
        break;
      }
    }
    if (found !== hoverDivId) setHoverDivId(found);
    if (e.pointerType === "touch") e.preventDefault();
  };

  const finishDrag = () => {
    if (dragPlayerId === null || hoverDivId === null) {
      cancelDrag();
      return;
    }
    const currentDivId = members.find((m) => m.playerId === dragPlayerId)?.divisionId;
    if (!currentDivId || currentDivId === hoverDivId) {
      cancelDrag();
      return;
    }
    const playerId = dragPlayerId;
    const targetDivId = hoverDivId;
    const prevMembers = members;
    // Optimistic update so the row visually moves immediately.
    setMembers(members.map((m) => (m.playerId === playerId ? { ...m, divisionId: targetDivId } : m)));
    setDragPlayerId(null);
    setHoverDivId(null);
    pending.current = null;
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append("seasonId", seasonId);
        fd.append("playerId", playerId);
        fd.append("targetDivisionId", targetDivId);
        await moveDivisionMember(fd);
      } catch (err) {
        console.warn("[draggable-divisions] move failed, reverting:", err);
        setMembers(prevMembers);
      }
    });
  };

  const cancelDrag = () => {
    setDragPlayerId(null);
    setHoverDivId(null);
    pending.current = null;
  };

  // Bucket members by division for rendering.
  const byDivision = new Map<string, EditorMember[]>();
  for (const m of members) {
    const arr = byDivision.get(m.divisionId) ?? [];
    arr.push(m);
    byDivision.set(m.divisionId, arr);
  }

  return (
    <div
      onPointerMove={onWrapperPointerMove}
      onPointerUp={finishDrag}
      onPointerLeave={finishDrag}
      onPointerCancel={cancelDrag}
    >
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
            </h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 8 }}>
              {tierDivs.map((d) => {
                const divMembers = byDivision.get(d.id) ?? [];
                const isDropTarget = hoverDivId === d.id && dragPlayerId !== null;
                const currentDivOfDrag = dragPlayerId
                  ? members.find((m) => m.playerId === dragPlayerId)?.divisionId
                  : null;
                const isValidDrop = isDropTarget && currentDivOfDrag !== d.id;
                return (
                  <div
                    key={d.id}
                    ref={(el) => { divRefs.current.set(d.id, el); }}
                    className="card"
                    style={{
                      margin: 0,
                      outline: isValidDrop ? "2px solid #2ecc71" : isDropTarget ? "2px solid #888" : undefined,
                      background: isValidDrop ? "rgba(46,204,113,0.05)" : undefined,
                      transition: "outline 100ms, background 100ms",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <strong>
                        <Link href={`/admin/divisions/${d.id}`} style={{ textDecoration: "none" }}>{d.name}</Link>
                      </strong>
                      <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
                        {divMembers.length} member{divMembers.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {divMembers.length === 0 ? (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4, padding: 12, border: "1px dashed var(--border)", borderRadius: 4, textAlign: "center" }}>
                        {isValidDrop ? "Drop here" : "Empty division — drag a player here"}
                      </div>
                    ) : (
                      <div style={{ marginTop: 4 }}>
                        {divMembers.map((m) => {
                          const isDragged = dragPlayerId === m.playerId;
                          return (
                            <div
                              key={m.id}
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
                              }}
                            >
                              <span style={{ color: "#888" }} title="Drag to move">⋮⋮</span>
                              <Link
                                href={`/profile/${m.playerId}`}
                                style={{ color: "var(--text)" }}
                                onPointerDown={(e) => e.stopPropagation()}
                              >
                                {m.playerName}
                              </Link>
                              <select
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
                                    } catch {
                                      setMembers(prev);
                                    }
                                  });
                                  e.currentTarget.value = "";
                                }}
                                defaultValue=""
                                style={{ marginLeft: "auto", fontSize: 11, padding: "1px 4px", maxWidth: 100 }}
                              >
                                <option value="" disabled>Move to…</option>
                                {divisions.filter((other) => other.id !== d.id).map((other) => (
                                  <option key={other.id} value={other.id}>{other.name}</option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {/* Late-add form lives outside the drag flow */}
                    <form
                      action={addLatePlayerToDivision}
                      onPointerDown={(e) => e.stopPropagation()}
                      style={{ display: "flex", gap: 4, marginTop: 6, fontSize: 11 }}
                    >
                      <input type="hidden" name="divisionId" value={d.id} />
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

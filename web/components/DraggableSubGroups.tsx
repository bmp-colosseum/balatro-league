"use client";

// Drag-and-drop sub-group editor for one division (draft mode). Drag a player
// from one Group column onto another to reassign their sub-group — same pointer
// pattern as the division builder (works on touch + mouse), optimistic with
// revert on failure. Cross-division moves stay in the division placement editor;
// this is just "which group within the division".

import { useRef, useState, useTransition } from "react";
import { setMemberSubGroup } from "@/app/seasons/[id]/actions";
import { groupLetter } from "@/lib/sub-grouping";

export interface SubGroupMember {
  memberId: string;
  playerName: string;
  group: number;
  // Current seed within the division (1 = top seed). Drives the snake balance;
  // shown so officials can eyeball where people land + whether groups are even.
  seed: number;
}

export function DraggableSubGroups({
  seasonId,
  groupCount,
  initialMembers,
}: {
  seasonId: string;
  groupCount: number;
  initialMembers: SubGroupMember[];
}) {
  const [members, setMembers] = useState<SubGroupMember[]>(initialMembers);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverGroup, setHoverGroup] = useState<number | null>(null);
  const [, startTransition] = useTransition();
  const colRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const pending = useRef<{ memberId: string; x: number; y: number } | null>(null);

  const groups = Array.from({ length: Math.max(1, groupCount) }, (_, i) => i + 1);
  const byGroup = new Map<number, SubGroupMember[]>();
  for (const g of groups) byGroup.set(g, []);
  for (const m of members) (byGroup.get(m.group) ?? byGroup.set(m.group, []).get(m.group)!).push(m);

  const onPointerDown = (e: React.PointerEvent, memberId: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pending.current = { memberId, x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragId === null) {
      if (pending.current) {
        const moved = Math.abs(e.clientX - pending.current.x) > 6 || Math.abs(e.clientY - pending.current.y) > 6;
        if (moved) setDragId(pending.current.memberId);
      }
      return;
    }
    let found: number | null = null;
    for (const [g, el] of colRefs.current) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left && e.clientX <= r.right) {
        found = g;
        break;
      }
    }
    if (found !== hoverGroup) setHoverGroup(found);
    if (e.pointerType === "touch") e.preventDefault();
  };

  const finishDrag = () => {
    if (dragId === null || hoverGroup === null) return cancel();
    const m = members.find((x) => x.memberId === dragId);
    if (!m || m.group === hoverGroup) return cancel();
    const target = hoverGroup;
    const prev = members;
    setMembers(members.map((x) => (x.memberId === dragId ? { ...x, group: target } : x)));
    setDragId(null);
    setHoverGroup(null);
    pending.current = null;
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append("seasonId", seasonId);
        fd.append("memberId", m.memberId);
        fd.append("group", String(target));
        await setMemberSubGroup(fd);
      } catch (err) {
        console.warn("[sub-groups] move failed, reverting:", err);
        setMembers(prev);
      }
    });
  };

  const cancel = () => {
    setDragId(null);
    setHoverGroup(null);
    pending.current = null;
  };

  return (
    <div
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerLeave={finishDrag}
      onPointerCancel={cancel}
      style={{ display: "flex", gap: 10, flexWrap: "nowrap", overflowX: "auto", paddingBottom: 4 }}
    >
      {groups.map((g) => {
        const ms = (byGroup.get(g) ?? []).slice().sort((a, b) => a.seed - b.seed);
        const isTarget = hoverGroup === g && dragId !== null;
        const avgSeed = ms.length ? ms.reduce((s, m) => s + m.seed, 0) / ms.length : 0;
        return (
          <div
            key={g}
            ref={(el) => { colRefs.current.set(g, el); }}
            style={{
              border: isTarget ? "2px solid #2ecc71" : "1px solid var(--border)",
              borderRadius: 6,
              padding: 8,
              width: 200,
              flex: "0 0 auto",
              background: isTarget ? "rgba(46,204,113,0.05)" : undefined,
              transition: "border-color 100ms, background 100ms",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
              Group {groupLetter(g)}{" "}
              <span className="muted" style={{ fontWeight: 400 }}>
                · {ms.length}p · {Math.max(0, ms.length - 1)} games{ms.length ? ` · avg #${avgSeed.toFixed(1)}` : ""}
              </span>
            </div>
            {ms.length === 0 ? (
              <div className="muted" style={{ fontSize: 12, padding: 4 }}>{isTarget ? "Drop here" : "—"}</div>
            ) : (
              ms.map((m, i) => (
                <div
                  key={m.memberId}
                  onPointerDown={(e) => onPointerDown(e, m.memberId)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "3px 4px",
                    cursor: dragId === m.memberId ? "grabbing" : "grab",
                    opacity: dragId === m.memberId ? 0.4 : 1,
                    touchAction: "none",
                    userSelect: "none",
                    fontSize: 13,
                    borderTop: i === 0 ? undefined : "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <span style={{ color: "#888" }} title="Drag to another group">⋮⋮</span>
                  <span style={{ flex: 1 }}>{m.playerName}</span>
                  <span className="muted" style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }} title="Current seed">#{m.seed}</span>
                </div>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

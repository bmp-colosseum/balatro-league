"use client";

// Draggable hidden-MMR ladder. The row ORDER is the MMR: top → bottom, spaced
// exactly 10 apart, so #1 = N×10 and #N = 10. Drag to reorder; the new spacing
// autosaves. This is the clean cold-start ("everyone 10 apart" instead of lumpy
// BMP-derived gaps where someone sits 900 below their neighbour). The Recompute
// button on the page is the other path — results-based spread, which breaks the
// even spacing on purpose.
//
// Drag uses pointer events (not HTML5 DnD) so it works on touch + desktop. Same
// mechanics as the build-page rating table.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

export interface MmrLadderRow {
  playerId: string;
  displayName: string;
  hiddenMmr: number | null;
  bmpPeak: number | null;
  bmpTier: string | null;
}

export function MmrLadder({
  initial,
  applyOrder,
}: {
  initial: MmrLadderRow[];
  applyOrder: (formData: FormData) => void | Promise<void>;
}) {
  const [rows, setRows] = useState<MmrLadderRow[]>(initial);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const pendingDragIdx = useRef<number | null>(null);
  const pendingStart = useRef<{ x: number; y: number } | null>(null);

  const N = rows.length;
  const mmrFor = (index: number) => (N - index) * 10;

  const onRowPointerDown = (e: React.PointerEvent<HTMLTableRowElement>, idx: number) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pendingDragIdx.current = idx;
    pendingStart.current = { x: e.clientX, y: e.clientY };
  };

  const computeHoverIdx = (clientY: number): number | null => {
    for (let i = 0; i < rowRefs.current.length; i++) {
      const el = rowRefs.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return i;
      if (i === rowRefs.current.length - 1 && clientY > r.bottom) return i;
      if (i === 0 && clientY < r.top) return 0;
    }
    return null;
  };

  const onTablePointerMove = (e: React.PointerEvent<HTMLTableElement>) => {
    if (dragIdx === null) {
      if (pendingDragIdx.current !== null && pendingStart.current) {
        const dx = e.clientX - pendingStart.current.x;
        const dy = e.clientY - pendingStart.current.y;
        if (Math.abs(dy) > 6 || Math.abs(dx) > 6) {
          setDragIdx(pendingDragIdx.current);
          setHoverIdx(pendingDragIdx.current);
        }
      }
      return;
    }
    const idx = computeHoverIdx(e.clientY);
    if (idx !== null && idx !== hoverIdx) setHoverIdx(idx);
    if (e.pointerType === "touch") e.preventDefault();
  };

  const finishDrag = () => {
    if (dragIdx !== null && hoverIdx !== null && hoverIdx !== dragIdx) {
      const next = [...rows];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(hoverIdx, 0, moved!);
      setRows(next);
    }
    setDragIdx(null);
    setHoverIdx(null);
    pendingDragIdx.current = null;
    pendingStart.current = null;
  };

  const order = useMemo(() => JSON.stringify(rows.map((r) => r.playerId)), [rows]);

  // Autosave on reorder (skip the initial render so we don't re-save the
  // server's order back to itself). The explicit "Space everyone 10 apart"
  // button below commits the even spacing even without a drag, for the first
  // time you set it up.
  const [isPending, startTransition] = useTransition();
  const [savedHash, setSavedHash] = useState<string>(() => order);
  const [saveError, setSaveError] = useState<string | null>(null);

  const commit = (nextOrder: string) => {
    setSaveError(null);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append("order", nextOrder);
        await applyOrder(fd);
        setSavedHash(nextOrder);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "save failed");
      }
    });
  };

  useEffect(() => {
    if (order === savedHash) return;
    commit(order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order]);

  if (rows.length === 0) return <p className="muted">No players yet.</p>;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <strong>{N} players</strong>
        <button
          type="button"
          className="secondary"
          style={{ fontSize: 12, padding: "3px 10px" }}
          onClick={() => commit(order)}
          disabled={isPending}
        >
          Space everyone 10 apart now
        </button>
        <span className="muted" style={{ fontSize: 11 }}>
          Drag to reorder — #1 = {N * 10}, each step −10, #{N} = 10. Saves automatically.
        </span>
        <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
          {saveError ? <span style={{ color: "#e74c3c" }}>⚠ {saveError}</span> : isPending ? "Saving…" : "✓ Saved"}
        </span>
      </div>
      <table
        style={{ width: "100%", fontSize: 13 }}
        onPointerMove={onTablePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onPointerLeave={finishDrag}
      >
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th style={{ width: 28 }}></th>
            <th style={{ width: 28 }}>#</th>
            <th style={{ padding: "4px 8px" }}>Player</th>
            <th style={{ padding: "4px 8px", textAlign: "right" }}>MMR (10 apart)</th>
            <th style={{ padding: "4px 8px", textAlign: "right" }} className="muted">stored</th>
            <th style={{ padding: "4px 8px", textAlign: "right" }} className="muted">BMP peak</th>
            <th style={{ padding: "4px 8px" }} className="muted">Tier</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isDragged = dragIdx === i;
            const isHovered = hoverIdx === i && dragIdx !== null && dragIdx !== i;
            const next = mmrFor(i);
            const drifted = r.hiddenMmr != null && r.hiddenMmr !== next;
            return (
              <tr
                key={r.playerId}
                ref={(el) => { rowRefs.current[i] = el; }}
                onPointerDown={(e) => onRowPointerDown(e, i)}
                style={{
                  cursor: isDragged ? "grabbing" : "grab",
                  opacity: isDragged ? 0.4 : 1,
                  borderTop: isHovered ? "2px solid #76c7ff" : "2px solid transparent",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                  background: isDragged ? "rgba(118,199,255,0.05)" : undefined,
                  touchAction: "none",
                  userSelect: "none",
                }}
              >
                <td style={{ color: "#888", textAlign: "center" }} title="Drag to reorder">⋮⋮</td>
                <td style={{ fontVariantNumeric: "tabular-nums", color: "#888" }}>{i + 1}</td>
                <td style={{ padding: "3px 8px" }}>
                  <Link href={`/profile/${r.playerId}`} style={{ color: "var(--text)" }} onPointerDown={(e) => e.stopPropagation()}>
                    {r.displayName}
                  </Link>
                </td>
                <td style={{ padding: "3px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                  {next}
                </td>
                <td style={{ padding: "3px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: drifted ? "#f1c40f" : "#888" }} title={drifted ? "Stored MMR differs from the even spacing — drag or hit 'Space everyone 10 apart' to apply." : undefined}>
                  {r.hiddenMmr ?? "—"}
                </td>
                <td style={{ padding: "3px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }} className="muted">
                  {r.bmpPeak ?? "—"}
                </td>
                <td style={{ padding: "3px 8px" }} className="muted">{r.bmpTier ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

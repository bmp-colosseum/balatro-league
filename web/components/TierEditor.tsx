"use client";

// Client-side React editor for the per-season tier layout.
// Used in both the Create Season form and the Manage Templates page.
// Submits its current rows as a hidden JSON input on form submit.

import { useState } from "react";

export interface TierConfig {
  name: string;
  divisionCount: number;
}

interface Template {
  id: string;
  name: string;
  config: TierConfig[];
  isLastUsed: boolean;
}

export function TierEditor({
  initial,
  templates,
  showTemplateLoader = true,
  configFieldName = "config",
  signupCount,
}: {
  initial: TierConfig[];
  templates?: Template[];
  showTemplateLoader?: boolean;
  configFieldName?: string;
  // When known (build flow), enables the "Suggest from N signups"
  // button that auto-computes division counts to keep every division
  // around the target size with extras going to lower tiers.
  signupCount?: number;
}) {
  const [rows, setRows] = useState<TierConfig[]>(
    initial.length > 0 ? initial : [{ name: "", divisionCount: 1 }],
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  // Compute total slots at target=6/div for the current row config —
  // shown next to the suggest button so admin sees capacity at a glance.
  const totalCapacity = rows.reduce((sum, r) => sum + r.divisionCount * 6, 0);
  // Project the actual per-tier division sizes the build will produce
  // given the current signup count. Mirrors planByRating's even-fill
  // algorithm: top tier = 1/div, remaining N-1 distributed across lower
  // tiers with extras going to upper tiers first. Admin can see the
  // resulting shape live as they edit tier counts.
  const totalDivisions = rows.reduce((sum, r) => sum + Math.max(1, r.divisionCount), 0);
  // Even distribution across ALL divisions (no special case for the
  // top tier). For N signups across D total divisions:
  //   base = floor(N / D), extras = N - base*D
  // Each division gets `base` players. Extras (one each) go to the
  // upper-tier divisions first so Legendary/Rare are full before
  // Common takes leftovers.
  const projectedSizes: number[][] = (() => {
    if (!signupCount || signupCount <= 0 || rows.length === 0 || totalDivisions === 0) {
      return rows.map((r) => Array.from({ length: Math.max(1, r.divisionCount) }, () => 0));
    }
    const base = Math.floor(signupCount / totalDivisions);
    let extras = signupCount - base * totalDivisions;
    return rows.map((row) => {
      const numDivs = Math.max(1, row.divisionCount);
      return Array.from({ length: numDivs }, () => {
        const e = extras > 0 ? 1 : 0;
        if (extras > 0) extras--;
        return base + e;
      });
    });
  })();
  // Auto-suggest: position-1 tier stays 1 division (Legendary slot).
  // Remaining tiers split ceil((N-1)/6) divisions as evenly as
  // possible, with extras going to LOWER tiers first (Common gets
  // extras before Uncommon, Uncommon before Rare).
  const suggestFromSignups = () => {
    if (!signupCount || signupCount < 1 || rows.length === 0) return;
    const next = rows.map((r) => ({ ...r }));
    next[0]!.divisionCount = 1;
    const lower = next.slice(1);
    if (lower.length === 0) return;
    const remaining = Math.max(0, signupCount - 1);
    const divCount = Math.ceil(remaining / 6);
    const base = Math.floor(divCount / lower.length);
    const extras = divCount - base * lower.length;
    // Fill lower tiers from the BACK (last tier = lowest = gets extras first).
    for (let i = 0; i < lower.length; i++) {
      const fromBack = lower.length - 1 - i;
      lower[fromBack]!.divisionCount = base + (i < extras ? 1 : 0);
    }
    setRows([next[0]!, ...lower]);
  };

  const addRow = () => setRows([...rows, { name: "", divisionCount: 1 }]);
  const removeRow = (idx: number) => {
    if (rows.length === 1) return;
    setRows(rows.filter((_, i) => i !== idx));
  };
  const updateRow = (idx: number, patch: Partial<TierConfig>) => {
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const move = (idx: number, delta: -1 | 1) => {
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= rows.length) return;
    const next = [...rows];
    [next[idx], next[newIdx]] = [next[newIdx]!, next[idx]!];
    setRows(next);
  };
  const loadTemplate = (id: string) => {
    if (!templates) return;
    const t = templates.find((x) => x.id === id);
    if (t) setRows(t.config);
  };

  return (
    <div style={{ flex: "1 1 100%" }}>
      {showTemplateLoader && templates && templates.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <label>
            Load template
            <select
              value={selectedTemplateId}
              onChange={(e) => {
                setSelectedTemplateId(e.target.value);
                if (e.target.value) loadTemplate(e.target.value);
              }}
            >
              <option value="">— pick a template —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.isLastUsed ? "★ " : ""}
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {selectedTemplateId && (
            <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>
              ✓ Loaded — edit the rows below, then click Create season
            </span>
          )}
        </div>
      )}

      {rows.map((row, idx) => (
        <div
          key={idx}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "6px 8px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            marginBottom: 6,
          }}
        >
          <span className="muted" style={{ width: 22, fontVariantNumeric: "tabular-nums" }}>
            {idx + 1}.
          </span>
          <input
            type="text"
            value={row.name}
            onChange={(e) => updateRow(idx, { name: e.target.value })}
            placeholder="Tier name"
            required
            style={{ flex: "1 1 auto" }}
          />
          <input
            type="number"
            value={row.divisionCount}
            min={1}
            max={50}
            onChange={(e) => updateRow(idx, { divisionCount: parseInt(e.target.value, 10) || 1 })}
            style={{ width: 80 }}
          />
          <button
            type="button"
            className="secondary"
            onClick={() => move(idx, -1)}
            disabled={idx === 0}
            style={{ padding: "4px 8px", fontSize: 12 }}
            title="Move up"
          >
            ▲
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => move(idx, 1)}
            disabled={idx === rows.length - 1}
            style={{ padding: "4px 8px", fontSize: 12 }}
            title="Move down"
          >
            ▼
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => removeRow(idx)}
            disabled={rows.length === 1}
            style={{ padding: "4px 8px", fontSize: 12 }}
            title="Remove"
          >
            ✕
          </button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
        <button type="button" className="secondary" onClick={addRow}>
          + Add tier
        </button>
        {signupCount !== undefined && signupCount > 0 && (
          <>
            <button type="button" className="secondary" onClick={suggestFromSignups}>
              ✨ Suggest from {signupCount} signup{signupCount === 1 ? "" : "s"}
            </button>
            <span className="muted" style={{ fontSize: 11 }}>
              {totalDivisions} div{totalDivisions === 1 ? "" : "s"} · capacity at 6/div: {totalCapacity}
              {signupCount > totalCapacity && (
                <span style={{ color: "var(--accent)", marginLeft: 4 }}>
                  ({signupCount - totalCapacity} over — bottom tier absorbs)
                </span>
              )}
              {signupCount < totalCapacity && (
                <span style={{ color: "#95a5a6", marginLeft: 4 }}>
                  ({totalCapacity - signupCount} slots free)
                </span>
              )}
            </span>
          </>
        )}
      </div>

      {/* Live preview of what the build will produce — per-tier division
          sizes computed with the same algorithm as planByRating so admin
          sees the exact shape before clicking Build. */}
      {signupCount !== undefined && signupCount > 0 && rows.length > 0 && totalDivisions > 0 && (
        <div style={{
          marginTop: 8,
          padding: 8,
          border: "1px solid var(--border)",
          borderRadius: 4,
          background: "var(--surface-2)",
          fontSize: 11,
        }}>
          <strong style={{ fontSize: 12, color: "var(--info)" }}>Projected placement</strong>
          <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>
            How {signupCount} signup{signupCount === 1 ? "" : "s"} will fill into this shape (even distribution, extras to upper tiers)
          </div>
          {rows.map((row, idx) => {
            const sizes = projectedSizes[idx] ?? [];
            const tierTotal = sizes.reduce((s, n) => s + n, 0);
            const avg = sizes.length > 0 ? tierTotal / sizes.length : 0;
            const warning = sizes.length === 0
              ? null
              : avg < 4
                ? { color: "var(--danger)", text: "too few" }
                : avg > 7
                  ? { color: "var(--danger)", text: "too many" }
                  : avg < 5
                    ? { color: "var(--accent)", text: "below target" }
                    : null;
            return (
              <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6, fontVariantNumeric: "tabular-nums" }}>
                <span style={{ width: 100, color: "#bdc3c7" }}>{row.name || `Tier ${idx + 1}`}:</span>
                <span style={{ flex: "0 0 auto" }}>
                  {sizes.length === 0 ? "—" : sizes.join(" / ")}
                </span>
                <span className="muted" style={{ marginLeft: 6 }}>
                  ({tierTotal} player{tierTotal === 1 ? "" : "s"} across {sizes.length} div{sizes.length === 1 ? "" : "s"})
                </span>
                {warning && <span style={{ color: warning.color, marginLeft: 4 }}>⚠ {warning.text}</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Hidden field serializing current state; consumed by the parent form's server action. */}
      <input type="hidden" name={configFieldName} value={JSON.stringify(rows)} />
    </div>
  );
}

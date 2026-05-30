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
}: {
  initial: TierConfig[];
  templates?: Template[];
  showTemplateLoader?: boolean;
  configFieldName?: string;
}) {
  const [rows, setRows] = useState<TierConfig[]>(
    initial.length > 0 ? initial : [{ name: "", divisionCount: 1 }],
  );

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
              defaultValue=""
              onChange={(e) => {
                loadTemplate(e.target.value);
                e.target.value = "";
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

      <button type="button" className="secondary" onClick={addRow} style={{ marginTop: 6 }}>
        + Add tier
      </button>

      {/* Hidden field serializing current state; consumed by the parent form's server action. */}
      <input type="hidden" name={configFieldName} value={JSON.stringify(rows)} />
    </div>
  );
}

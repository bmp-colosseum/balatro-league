"use client";

// Per-season deck preset picker. Auto-saves on dropdown change (no Save
// button) and shows what's inside the currently-selected preset so admin can
// confirm at a glance before the match flow uses it.

import { useState, useTransition } from "react";

interface Preset {
  id: string;
  name: string;
  decks: string[];
  stakes: string[];
}

interface Props {
  seasonId: string;
  presets: Preset[];
  initialPresetId: string | null;
  defaultPreset?: Preset | null; // shown when "Use Default" is selected
  saveAction: (formData: FormData) => Promise<void>;
}

export function SeasonDeckPresetPicker({
  seasonId,
  presets,
  initialPresetId,
  defaultPreset,
  saveAction,
}: Props) {
  const [selected, setSelected] = useState<string>(initialPresetId ?? "");
  const [savedTick, setSavedTick] = useState(0);
  const [isPending, startTransition] = useTransition();

  const previewPreset =
    selected === ""
      ? defaultPreset ?? null
      : presets.find((p) => p.id === selected) ?? null;

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newValue = e.target.value;
    setSelected(newValue);
    const fd = new FormData();
    fd.set("id", seasonId);
    fd.set("presetId", newValue);
    startTransition(async () => {
      await saveAction(fd);
      setSavedTick((t) => t + 1);
    });
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <label className="muted" style={{ fontSize: 12 }}>Deck preset:</label>
        <select value={selected} onChange={handleChange} style={{ flex: 1 }}>
          <option value="">— Use Default —</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <span
          className="muted"
          style={{ fontSize: 11, minWidth: 60, textAlign: "right" }}
        >
          {isPending ? "saving…" : savedTick > 0 ? "✓ saved" : ""}
        </span>
      </div>
      {previewPreset && (
        <div
          className="muted"
          style={{ fontSize: 11, marginTop: 4, paddingLeft: 8, borderLeft: "2px solid var(--border)" }}
        >
          <div>
            <strong>Decks ({previewPreset.decks.length}):</strong>{" "}
            {previewPreset.decks.length > 0 ? previewPreset.decks.join(", ") : <em>none</em>}
          </div>
          <div>
            <strong>Stakes ({previewPreset.stakes.length}):</strong>{" "}
            {previewPreset.stakes.length > 0 ? previewPreset.stakes.join(", ") : <em>none</em>}
          </div>
          <div style={{ marginTop: 2 }}>
            <strong>{previewPreset.decks.length * previewPreset.stakes.length}</strong> combos
            available to the bot's 9-pick sampler.
          </div>
        </div>
      )}
      {!previewPreset && selected === "" && (
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          No <code>Default</code> preset exists yet — create one on{" "}
          <a href="/admin/deck-selection">Deck Selection</a>.
        </div>
      )}
    </div>
  );
}

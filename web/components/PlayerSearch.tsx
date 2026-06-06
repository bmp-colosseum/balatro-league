"use client";

import { useMemo, useRef, useState } from "react";

export interface PlayerOption {
  id: string;
  displayName: string;
}

// A small searchable player picker: type to filter the existing player
// list, click to select. The selected player's id is written into a hidden
// input named `name` so it submits with the surrounding <form>. No external
// combobox library — just filtered local state.
export function PlayerSearch({
  players,
  name,
  placeholder = "Search players…",
}: {
  players: PlayerOption[];
  name: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PlayerOption | null>(null);
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return players.slice(0, 20);
    return players.filter((p) => p.displayName.toLowerCase().includes(q)).slice(0, 20);
  }, [players, query]);

  function pick(p: PlayerOption) {
    setSelected(p);
    setQuery(p.displayName);
    setOpen(false);
  }

  return (
    <div style={{ position: "relative", flex: "1 1 200px", minWidth: 160 }}>
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(null);
          setOpen(true);
        }}
        onBlur={() => {
          // Delay so an option click registers before we close.
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        style={{ width: "100%" }}
      />
      {open && matches.length > 0 && (
        <ul
          style={{
            position: "absolute",
            zIndex: 20,
            top: "100%",
            left: 0,
            right: 0,
            margin: 0,
            padding: 4,
            listStyle: "none",
            maxHeight: 220,
            overflowY: "auto",
            background: "var(--surface-2, #1c1c1c)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 4,
          }}
        >
          {matches.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  // mousedown beats the input blur so the pick lands.
                  e.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                  pick(p);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "4px 8px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {p.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

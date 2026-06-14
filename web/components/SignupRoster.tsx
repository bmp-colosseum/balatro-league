"use client";

// Admin-only roster of the people currently signed up. Players see only a
// count on the public embed; this is where staff eyeball who's actually in.
// Shows display name + Discord ID side by side, with toggles to configure
// which columns show (and their order), plus a search box that matches on
// EITHER the name or the Discord ID.

import { useMemo, useState } from "react";

export interface RosterEntry {
  displayName: string;
  discordId: string;
}

export function SignupRoster({ signups }: { signups: RosterEntry[] }) {
  const [query, setQuery] = useState("");
  const [showId, setShowId] = useState(true);
  const [showName, setShowName] = useState(true);
  const [idFirst, setIdFirst] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return signups;
    return signups.filter(
      (s) => s.displayName.toLowerCase().includes(q) || s.discordId.includes(q),
    );
  }, [signups, query]);

  if (signups.length === 0) {
    return <div className="muted" style={{ fontSize: 12, margin: "4px 0" }}>No one signed up yet.</div>;
  }

  // At least one column must be visible, otherwise rows render blank.
  const nameOn = showName || !showId;
  const idOn = showId;

  const nameCell = (s: RosterEntry) =>
    nameOn ? <span>{s.displayName}</span> : null;
  const idCell = (s: RosterEntry) =>
    idOn ? (
      <code style={{ fontSize: 12, opacity: 0.85 }}>{s.discordId}</code>
    ) : null;

  return (
    <details style={{ margin: "4px 0 8px" }} open={query.length > 0}>
      <summary style={{ cursor: "pointer", fontSize: 12 }} className="muted">
        View who&apos;s signed up ({signups.length})
      </summary>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", margin: "8px 0" }}>
        <input
          type="text"
          value={query}
          placeholder="Search name or Discord ID…"
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: "1 1 220px", minWidth: 180, fontSize: 13 }}
        />
        <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }} className="muted">
          <input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> Name
        </label>
        <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }} className="muted">
          <input type="checkbox" checked={showId} onChange={(e) => setShowId(e.target.checked)} /> Discord ID
        </label>
        <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }} className="muted">
          <input type="checkbox" checked={idFirst} onChange={(e) => setIdFirst(e.target.checked)} /> ID first
        </label>
      </div>

      {matches.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>No matches for “{query}”.</div>
      ) : (
        <ol style={{ margin: "4px 0 0", paddingLeft: 28, fontSize: 13, lineHeight: 1.6 }}>
          {matches.map((s, i) => (
            <li key={`${s.discordId}-${i}`}>
              <span style={{ display: "inline-flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                {idFirst ? (
                  <>
                    {idCell(s)}
                    {nameCell(s)}
                  </>
                ) : (
                  <>
                    {nameCell(s)}
                    {idCell(s)}
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

"use client";

// Admin-only roster of the people currently signed up. Players see only a
// count on the public embed; this is where staff eyeball who's actually in.
// Shows each person's Discord global display name by default (the recognizable
// account-level name), with a toggle to also show their Discord ID. The search
// box matches on ALL of: global name, @username, and Discord ID — regardless
// of which columns are currently shown.

import { useMemo, useState } from "react";

export interface RosterEntry {
  // Discord @username captured at signup.
  displayName: string;
  // Account-level display name (user.global_name); null when unset.
  globalName: string | null;
  discordId: string;
  // Whether they're currently in the Discord server. false → flagged "not in
  // server"; null → not yet checked (shown without a flag).
  inGuild: boolean | null;
}

export function SignupRoster({
  signups,
  defaultShowId = false,
}: {
  signups: RosterEntry[];
  defaultShowId?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [showId, setShowId] = useState(defaultShowId);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return signups;
    return signups.filter(
      (s) =>
        (s.globalName ?? "").toLowerCase().includes(q) ||
        s.displayName.toLowerCase().includes(q) ||
        s.discordId.includes(q),
    );
  }, [signups, query]);

  if (signups.length === 0) {
    return <div className="muted" style={{ fontSize: 12, margin: "4px 0" }}>No one signed up yet.</div>;
  }

  // Default label = global name; fall back to @username when it's unset.
  const label = (s: RosterEntry) => s.globalName ?? s.displayName;

  const goneCount = signups.filter((s) => s.inGuild === false).length;

  return (
    <details style={{ margin: "4px 0 8px" }} open={query.length > 0}>
      <summary style={{ cursor: "pointer", fontSize: 12 }} className="muted">
        View who&apos;s signed up ({signups.length})
        {goneCount > 0 && (
          <span style={{ color: "#e67e22", marginLeft: 6 }}>· {goneCount} not in server</span>
        )}
      </summary>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", margin: "8px 0" }}>
        <input
          type="text"
          value={query}
          placeholder="Search name, @username, or Discord ID…"
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: "1 1 240px", minWidth: 200, fontSize: 13 }}
        />
        <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }} className="muted">
          <input type="checkbox" checked={showId} onChange={(e) => setShowId(e.target.checked)} /> Show Discord ID
        </label>
      </div>

      {matches.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>No matches for “{query}”.</div>
      ) : (
        <ol style={{ margin: "4px 0 0", paddingLeft: 28, fontSize: 13, lineHeight: 1.6 }}>
          {matches.map((s, i) => (
            <li key={`${s.discordId}-${i}`}>
              <span style={{ display: "inline-flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={s.inGuild === false ? { opacity: 0.6 } : undefined}>{label(s)}</span>
                {showId && <code style={{ fontSize: 12, opacity: 0.85 }}>{s.discordId}</code>}
                {s.inGuild === false && (
                  <span style={{ color: "#e67e22", fontSize: 11 }} title="Signed up but not currently a member of the Discord server">
                    ⚠️ not in server
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

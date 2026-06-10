"use client";

// Reactive match-report form. The result dropdown alone ("2-0", "0-2") is
// ambiguous about *who* won, so this shows a live plain-language confirmation
// that names the opponent ("You're reporting: you beat Alice 2–0") before the
// Report button — the safeguard against reporting the wrong direction/opponent.
// Posts to the same server action as before, so the rules are unchanged.

import { useState } from "react";

export interface ReportOpponent {
  playerId: string;
  displayName: string;
  alreadyPending: boolean;
}

function confirmationLine(name: string, result: string): string {
  if (result === "2-0") return `you beat ${name} 2–0`;
  if (result === "0-2") return `${name} beat you 2–0`;
  return `you drew ${name} 1–1`;
}

export function ReportForm({
  opponents,
  decks,
  stakes,
  action,
}: {
  opponents: ReportOpponent[];
  decks: string[];
  stakes: string[];
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [opponentId, setOpponentId] = useState("");
  const [result, setResult] = useState("2-0");

  const opponent = opponents.find((o) => o.playerId === opponentId);
  const pending = opponent?.alreadyPending ?? false;

  return (
    <form action={action} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>vs</span>
        <select
          name="opponentId"
          required
          value={opponentId}
          onChange={(e) => setOpponentId(e.target.value)}
          style={{ flex: "1 1 240px" }}
        >
          <option value="">— pick an opponent —</option>
          {opponents.map((o) => (
            <option key={o.playerId} value={o.playerId}>
              {o.displayName}
              {o.alreadyPending ? " (already pending)" : ""}
            </option>
          ))}
        </select>
        <select name="result" required value={result} onChange={(e) => setResult(e.target.value)}>
          <option value="2-0">2-0 — you won both</option>
          <option value="1-1">1-1 — draw</option>
          <option value="0-2">0-2 — you lost both</option>
        </select>
        <select name="deck" defaultValue="" title="Optional: deck played">
          <option value="">deck (optional)</option>
          {decks.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select name="stake" defaultValue="" title="Optional: stake played">
          <option value="">stake (optional)</option>
          {stakes.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {/* Live, named confirmation of exactly what's about to be recorded. */}
      <div
        style={{
          fontSize: 13,
          padding: "8px 10px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          minHeight: 18,
        }}
      >
        {opponent ? (
          <>
            You&apos;re reporting:{" "}
            <strong style={{ color: "var(--text)" }}>{confirmationLine(opponent.displayName, result)}</strong>.
            {pending && (
              <span style={{ color: "#f1c40f" }}> {" "}Heads up — a result vs {opponent.displayName} is already pending.</span>
            )}
          </>
        ) : (
          <span className="muted">Pick an opponent to see exactly what will be recorded.</span>
        )}
      </div>

      <div>
        <button type="submit" disabled={!opponentId}>
          Report{opponent ? ` — ${confirmationLine(opponent.displayName, result)}` : ""}
        </button>
      </div>
    </form>
  );
}

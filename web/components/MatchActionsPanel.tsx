"use client";

// Consolidated match-actions UI: pick a matchup, pick what happened, submit.
// One flow instead of separate Record / Override / DQ / Void / Undo cards.
// Two sub-sections by match state (the order of cognitive load):
//   • Resolve a match  — pairs that haven't been played yet
//   • Fix a finished match — pairs with a result already; same picker + Undo
// Both post to setMatchOutcome, which routes the chosen outcome to the right
// canonical mutation. Outcome labels use the picked pair's real names.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setMatchOutcome } from "@/lib/actions/match-outcome";
import { resultLabelByName } from "@/lib/result-labels";

export interface PanelMember {
  playerId: string;
  displayName: string;
}
export interface PanelPair {
  p1Id: string;
  p2Id: string;
  // For finished matches: a short "2-0" / "1-1" / "0-0 void" / "DQ" tag.
  summary?: string;
}

function outcomeOptions(p1: string, p2: string, includeUndo: boolean) {
  const opts = [
    { value: "p1-2-0", label: resultLabelByName("2-0", p1, p2) },
    { value: "draw", label: resultLabelByName("1-1", p1, p2) },
    { value: "p2-2-0", label: resultLabelByName("0-2", p1, p2) },
    { value: "void", label: `Void — 0-0 (no points, finished)` },
    { value: "p1-dq", label: `${p1} wins — ${p2} DQ'd` },
    { value: "p2-dq", label: `${p2} wins — ${p1} DQ'd` },
  ];
  if (includeUndo) opts.push({ value: "undo", label: "Undo — clear the result" });
  return opts;
}

function PairForm({
  divisionId,
  returnTo,
  pairs,
  members,
  includeUndo,
  submitLabel,
  emptyNote,
}: {
  divisionId: string;
  returnTo: string;
  pairs: PanelPair[];
  members: PanelMember[];
  includeUndo: boolean;
  submitLabel: string;
  emptyNote: string;
}) {
  const [pairKey, setPairKey] = useState("");
  const [outcome, setOutcome] = useState("");
  const nameOf = (id: string) => members.find((m) => m.playerId === id)?.displayName ?? id;
  const [p1Id, p2Id] = pairKey ? pairKey.split("|") : ["", ""];

  if (pairs.length === 0) {
    return <div className="muted" style={{ fontSize: 12 }}>{emptyNote}</div>;
  }

  return (
    <form action={setMatchOutcome} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input type="hidden" name="divisionId" value={divisionId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="p1" value={p1Id} />
      <input type="hidden" name="p2" value={p2Id} />
      <Select
        value={pairKey}
        onValueChange={(v) => {
          setPairKey(v ?? "");
          setOutcome("");
        }}
      >
        <SelectTrigger className="min-w-[200px]">
          <SelectValue placeholder="— pick a matchup —" />
        </SelectTrigger>
        <SelectContent>
          {pairs.map((pr) => (
            <SelectItem key={`${pr.p1Id}|${pr.p2Id}`} value={`${pr.p1Id}|${pr.p2Id}`}>
              {nameOf(pr.p1Id)} vs {nameOf(pr.p2Id)}
              {pr.summary ? ` — ${pr.summary}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {pairKey && (
        <>
          {/* Radix Select isn't a native <select name>, so mirror the value. */}
          <input type="hidden" name="outcome" value={outcome} />
          <Select value={outcome} onValueChange={(v) => setOutcome(v ?? "")}>
            <SelectTrigger className="min-w-[200px]">
              <SelectValue placeholder="— what happened? —" />
            </SelectTrigger>
            <SelectContent>
              {outcomeOptions(nameOf(p1Id!), nameOf(p2Id!), includeUndo).map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="text"
            name="reason"
            placeholder="Reason (required for DQ)"
            style={{ flex: "1 1 180px" }}
          />
          <Button type="submit" variant="secondary" disabled={!outcome}>{submitLabel}</Button>
        </>
      )}
    </form>
  );
}

export function MatchActionsPanel({
  divisionId,
  members,
  unplayed,
  played,
  returnTo,
  showFix = true,
}: {
  divisionId: string;
  members: PanelMember[];
  unplayed: PanelPair[];
  played: PanelPair[];
  returnTo: string;
  // Hide the "Fix a finished match" picker where the page already has a
  // recorded-matches table that does per-row override/undo (e.g. /admin/results).
  showFix?: boolean;
}) {
  return (
    <div className="card">
      <strong>⚔ Match actions</strong>
      <p className="muted" style={{ fontSize: 12, margin: "4px 0 10px" }}>
        Pick a matchup, then pick what happened. Covers normal results, DQs, and voids in one place.
      </p>

      <div style={{ marginBottom: showFix ? 14 : 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Resolve a match (not yet played)</div>
        <PairForm
          divisionId={divisionId}
          returnTo={returnTo}
          pairs={unplayed}
          members={members}
          includeUndo={false}
          submitLabel="Apply"
          emptyNote="Every matchup already has a result."
        />
      </div>

      {showFix && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Fix a finished match</div>
          <PairForm
            divisionId={divisionId}
            returnTo={returnTo}
            pairs={played}
            members={members}
            includeUndo
            submitLabel="Update"
            emptyNote="No finished matches yet."
          />
        </div>
      )}
    </div>
  );
}

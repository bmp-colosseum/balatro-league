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

// Radix Select disallows empty values, so optional deck/stake use a sentinel.
const NONE = "__none__";

// Which outcomes are a played BO2 result (so per-game deck/stake/lives apply).
const RESULT_OUTCOMES = new Set(["p1-2-0", "draw", "p2-2-0"]);

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

function ComboSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? NONE)}>
      <SelectTrigger className="min-w-[120px]">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{placeholder}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>{o}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PairForm({
  divisionId,
  returnTo,
  pairs,
  members,
  includeUndo,
  submitLabel,
  emptyNote,
  decks,
  stakes,
}: {
  divisionId: string;
  returnTo: string;
  pairs: PanelPair[];
  members: PanelMember[];
  includeUndo: boolean;
  submitLabel: string;
  emptyNote: string;
  decks: string[];
  stakes: string[];
}) {
  const [pairKey, setPairKey] = useState("");
  const [outcome, setOutcome] = useState("");
  const [deck1, setDeck1] = useState(NONE);
  const [stake1, setStake1] = useState(NONE);
  const [deck2, setDeck2] = useState(NONE);
  const [stake2, setStake2] = useState(NONE);
  const nameOf = (id: string) => members.find((m) => m.playerId === id)?.displayName ?? id;
  const [p1Id, p2Id] = pairKey ? pairKey.split("|") : ["", ""];

  if (pairs.length === 0) {
    return <div className="muted" style={{ fontSize: 12 }}>{emptyNote}</div>;
  }

  const isResult = RESULT_OUTCOMES.has(outcome);
  // Whose win is each game, given the chosen score (for the lives labels).
  const winnerG1 = outcome === "p2-2-0" ? nameOf(p2Id!) : nameOf(p1Id!);
  const winnerG2 = outcome === "p1-2-0" ? nameOf(p1Id!) : nameOf(p2Id!);

  return (
    <form action={setMatchOutcome} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input type="hidden" name="divisionId" value={divisionId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="p1" value={p1Id} />
      <input type="hidden" name="p2" value={p2Id} />
      <Select
        items={pairs.map((pr) => ({
          value: `${pr.p1Id}|${pr.p2Id}`,
          label: `${nameOf(pr.p1Id)} vs ${nameOf(pr.p2Id)}${pr.summary ? ` — ${pr.summary}` : ""}`,
        }))}
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
          {/* Radix Select isn't a native <select name>, so mirror the values. */}
          <input type="hidden" name="outcome" value={outcome} />
          <input type="hidden" name="deck1" value={deck1 === NONE ? "" : deck1} />
          <input type="hidden" name="stake1" value={stake1 === NONE ? "" : stake1} />
          <input type="hidden" name="deck2" value={deck2 === NONE ? "" : deck2} />
          <input type="hidden" name="stake2" value={stake2 === NONE ? "" : stake2} />
          <Select
            items={outcomeOptions(nameOf(p1Id!), nameOf(p2Id!), includeUndo)}
            value={outcome}
            onValueChange={(v) => setOutcome(v ?? "")}
          >
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

          {/* Optional per-game deck/stake/lives — for a match played outside the
              guided flow. Only meaningful for an actual played result. */}
          {isResult && (
            <div style={{ flexBasis: "100%", display: "grid", gap: 6, marginTop: 4 }}>
              <span className="muted" style={{ fontSize: 11 }}>
                Optional per-game detail (deck · stake · winner&apos;s lives left):
              </span>
              {[1, 2].map((g) => {
                const deckVal = g === 1 ? deck1 : deck2;
                const setDeck = g === 1 ? setDeck1 : setDeck2;
                const stakeVal = g === 1 ? stake1 : stake2;
                const setStake = g === 1 ? setStake1 : setStake2;
                const winnerName = g === 1 ? winnerG1 : winnerG2;
                return (
                  <div key={g} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12 }}>
                    <span style={{ minWidth: 50, fontWeight: 600 }}>Game {g}</span>
                    <ComboSelect value={deckVal} onChange={setDeck} options={decks} placeholder="deck" />
                    <ComboSelect value={stakeVal} onChange={setStake} options={stakes} placeholder="stake" />
                    <label className="flex items-center gap-1">
                      <span className="muted" style={{ fontSize: 11 }}>{winnerName} lives</span>
                      <input
                        type="number"
                        name={`livesGame${g}`}
                        min={0}
                        max={999}
                        inputMode="numeric"
                        className="w-16 rounded-md border border-border bg-background px-2 py-1 text-sm"
                      />
                    </label>
                  </div>
                );
              })}
            </div>
          )}

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
  decks,
  stakes,
  showFix = true,
}: {
  divisionId: string;
  members: PanelMember[];
  unplayed: PanelPair[];
  played: PanelPair[];
  returnTo: string;
  decks: string[];
  stakes: string[];
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
          decks={decks}
          stakes={stakes}
          includeUndo={false}
          submitLabel="Apply"
          emptyNote={
            played.length === 0
              ? "No matchups scheduled for this player yet — (re)generate this division's schedule on /admin/divisions."
              : "Every assigned matchup already has a result."
          }
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
            decks={decks}
            stakes={stakes}
            includeUndo
            submitLabel="Update"
            emptyNote="No finished matches yet."
          />
        </div>
      )}
    </div>
  );
}

"use client";

// The single player-facing match-report form, used on /report, /profile, and
// /divisions so reporting looks + behaves identically everywhere (same fields,
// wording, and lives capture). The result dropdown alone ("2-0", "0-2") is
// ambiguous about *who* won, so it shows a live plain-language confirmation
// that names both players before the Report button.
//
// Modes:
//   opponents        — dropdown of opponents to pick from (report/profile)
//   lockedOpponent   — opponent is fixed (a division-row "Report vs X"); no dropdown
//   compact          — tighter layout + smaller controls for inline/row use
//   collapsible      — render a "Report" trigger that expands the form on click
//   hiddenFields     — extra context fields the server action needs (e.g.
//                      divisionId, profileId), mirrored into hidden inputs
//
// Built with shadcn/ui (Radix Select) + Tailwind. Radix Select isn't a native
// <select name>, so chosen values are mirrored into hidden inputs — the server
// action reads the same FormData keys regardless of mode, rules unchanged.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resultLabelBySelf, type ResultStr } from "@/lib/result-labels";

export interface ReportOpponent {
  playerId: string;
  displayName: string;
  alreadyPending: boolean;
}

// Radix Select disallows empty-string item values, so optional deck/stake use a
// sentinel that maps back to "" in the hidden input.
const NONE = "__none__";

export function ReportForm({
  opponents = [],
  lockedOpponent,
  decks,
  stakes,
  action,
  compact = false,
  collapsible = false,
  hiddenFields,
}: {
  opponents?: ReportOpponent[];
  lockedOpponent?: ReportOpponent;
  decks: string[];
  stakes: string[];
  action: (formData: FormData) => void | Promise<void>;
  compact?: boolean;
  collapsible?: boolean;
  hiddenFields?: Record<string, string>;
}) {
  const [opponentId, setOpponentId] = useState(lockedOpponent?.playerId ?? "");
  const [result, setResult] = useState<ResultStr>("2-0");
  const [deck, setDeck] = useState(NONE);
  const [stake, setStake] = useState(NONE);
  // Collapsible forms start closed; everything else starts open.
  const [open, setOpen] = useState(!collapsible);

  const opponent = lockedOpponent ?? opponents.find((o) => o.playerId === opponentId);
  const pending = opponent?.alreadyPending ?? false;
  const oppName = opponent?.displayName ?? "Opponent";

  // Two lives slots, always shown. A 2-0/0-2 has one player winning both games
  // (both slots = that winner); a 1-1 splits, so slot 1 is the reporter's win
  // and slot 2 the opponent's win. Labels name whose lives each box holds; the
  // backend derives each game's winner from the result.
  const livesSlot1 =
    result === "2-0" ? "Your lives · G1"
    : result === "0-2" ? `${oppName}'s lives · G1`
    : "Your lives · your win";
  const livesSlot2 =
    result === "2-0" ? "Your lives · G2"
    : result === "0-2" ? `${oppName}'s lives · G2`
    : `${oppName}'s lives · their win`;

  const resultLabel = (r: ResultStr) =>
    opponent
      ? resultLabelBySelf(r, opponent.displayName)
      : r === "2-0" ? "You win 2–0" : r === "0-2" ? "You lose 0–2" : "1–1 draw";

  // Collapsed trigger — used in dense lists (division rows) so each row stays a
  // single line until the player chooses to report.
  if (collapsible && !open) {
    return (
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Report{lockedOpponent ? ` vs ${lockedOpponent.displayName}` : ""}
      </Button>
    );
  }

  const resultWidth = compact ? "min-w-[150px]" : "min-w-[200px]";
  const comboWidth = compact ? "min-w-[120px]" : "min-w-[140px]";

  return (
    <form action={action} className={`flex flex-col ${compact ? "gap-2" : "gap-3"}`}>
      {/* Radix Select values → server-action FormData. */}
      <input type="hidden" name="opponentId" value={opponentId} />
      <input type="hidden" name="result" value={result} />
      <input type="hidden" name="deck" value={deck === NONE ? "" : deck} />
      <input type="hidden" name="stake" value={stake === NONE ? "" : stake} />
      {hiddenFields &&
        Object.entries(hiddenFields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}

      <div className="flex flex-wrap items-center gap-2">
        {lockedOpponent ? (
          <span className="text-sm">
            <span className="muted text-xs">vs </span>
            <strong>{lockedOpponent.displayName}</strong>
          </span>
        ) : (
          <>
            <span className="muted text-xs">vs</span>
            <Select value={opponentId} onValueChange={(v) => setOpponentId(v ?? "")}>
              <SelectTrigger className="min-w-[220px] flex-1">
                <SelectValue placeholder="— pick an opponent —" />
              </SelectTrigger>
              <SelectContent>
                {opponents.map((o) => (
                  <SelectItem key={o.playerId} value={o.playerId}>
                    {o.displayName}
                    {o.alreadyPending ? " (already pending)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}

        <Select value={result} onValueChange={(v) => setResult((v as ResultStr) ?? "2-0")}>
          <SelectTrigger className={resultWidth}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="2-0">{resultLabel("2-0")}</SelectItem>
            <SelectItem value="1-1">{resultLabel("1-1")}</SelectItem>
            <SelectItem value="0-2">{resultLabel("0-2")}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={deck} onValueChange={(v) => setDeck(v ?? NONE)}>
          <SelectTrigger className={comboWidth}>
            <SelectValue placeholder="deck (optional)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>deck (optional)</SelectItem>
            {decks.map((d) => (
              <SelectItem key={d} value={d}>{d}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={stake} onValueChange={(v) => setStake(v ?? NONE)}>
          <SelectTrigger className={comboWidth}>
            <SelectValue placeholder="stake (optional)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>stake (optional)</SelectItem>
            {stakes.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Optional winner's-lives capture, always shown. Feeds the standings
          life-differential tiebreaker so players don't total it by hand.
          Native inputs (not Radix) submit directly; labels name whose lives
          each box holds (a 1-1 splits the wins between the two players). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
        <span className="muted">Lives left <span className="muted">(optional)</span></span>
        <label className="flex items-center gap-1">
          <span className="muted text-xs">{livesSlot1}</span>
          <input
            type="number"
            name="livesGame1"
            min={0}
            max={999}
            inputMode="numeric"
            className="w-16 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="muted text-xs">{livesSlot2}</span>
          <input
            type="number"
            name="livesGame2"
            min={0}
            max={999}
            inputMode="numeric"
            className="w-16 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </label>
      </div>

      {/* Live, named confirmation of exactly what's about to be recorded.
          Skipped in compact mode — the Report button label already names it. */}
      {!compact && (
        <div className="rounded-md border border-border bg-secondary px-2.5 py-2 text-[13px]">
          {opponent ? (
            <>
              You&apos;re reporting:{" "}
              <strong className="text-foreground">{resultLabelBySelf(result, opponent.displayName)}</strong>.
              {pending && (
                <span className="text-[var(--accent)]"> Heads up — a result vs {opponent.displayName} is already pending.</span>
              )}
            </>
          ) : (
            <span className="muted">Pick an opponent to confirm what gets recorded.</span>
          )}
        </div>
      )}

      <div>
        <Button type="submit" disabled={!opponentId} size={compact ? "sm" : undefined}>
          Report{opponent ? ` — ${resultLabelBySelf(result, opponent.displayName)}` : ""}
        </Button>
      </div>
    </form>
  );
}

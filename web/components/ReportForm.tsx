"use client";

// Reactive match-report form. The result dropdown alone ("2-0", "0-2") is
// ambiguous about *who* won, so this shows a live plain-language confirmation
// that names both players before the Report button.
//
// Built with shadcn/ui (Radix Select) + Tailwind. Radix Select isn't a native
// <select name>, so the chosen values are mirrored into hidden inputs — the
// server action reads the same FormData keys as before, rules unchanged.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ReportOpponent {
  playerId: string;
  displayName: string;
  alreadyPending: boolean;
}

function confirmationLine(selfName: string, oppName: string, result: string): string {
  if (result === "2-0") return `${selfName} beat ${oppName} 2–0`;
  if (result === "0-2") return `${oppName} beat ${selfName} 2–0`;
  return `${selfName} & ${oppName} drew 1–1`;
}

// Radix Select disallows empty-string item values, so optional deck/stake use a
// sentinel that maps back to "" in the hidden input.
const NONE = "__none__";

export function ReportForm({
  opponents,
  decks,
  stakes,
  action,
  selfName,
}: {
  opponents: ReportOpponent[];
  decks: string[];
  stakes: string[];
  action: (formData: FormData) => void | Promise<void>;
  selfName: string;
}) {
  const [opponentId, setOpponentId] = useState("");
  const [result, setResult] = useState("2-0");
  const [deck, setDeck] = useState(NONE);
  const [stake, setStake] = useState(NONE);

  const opponent = opponents.find((o) => o.playerId === opponentId);
  const pending = opponent?.alreadyPending ?? false;

  const resultLabel = (r: string) =>
    r === "2-0"
      ? opponent ? `2-0 — ${selfName} beat ${opponent.displayName}` : "2-0 — won both"
      : r === "1-1"
        ? opponent ? `1-1 — ${selfName} & ${opponent.displayName} drew` : "1-1 — draw"
        : opponent ? `0-2 — ${opponent.displayName} beat ${selfName}` : "0-2 — lost both";

  return (
    <form action={action} className="flex flex-col gap-3">
      {/* Radix Select values → server-action FormData. */}
      <input type="hidden" name="opponentId" value={opponentId} />
      <input type="hidden" name="result" value={result} />
      <input type="hidden" name="deck" value={deck === NONE ? "" : deck} />
      <input type="hidden" name="stake" value={stake === NONE ? "" : stake} />

      <div className="flex flex-wrap items-center gap-2">
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

        <Select value={result} onValueChange={(v) => setResult(v ?? "2-0")}>
          <SelectTrigger className="min-w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="2-0">{resultLabel("2-0")}</SelectItem>
            <SelectItem value="1-1">{resultLabel("1-1")}</SelectItem>
            <SelectItem value="0-2">{resultLabel("0-2")}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={deck} onValueChange={(v) => setDeck(v ?? NONE)}>
          <SelectTrigger className="min-w-[140px]">
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
          <SelectTrigger className="min-w-[140px]">
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

      {/* Live, named confirmation of exactly what's about to be recorded. */}
      <div className="rounded-md border border-border bg-secondary px-2.5 py-2 text-[13px]">
        {opponent ? (
          <>
            You&apos;re reporting:{" "}
            <strong className="text-foreground">{confirmationLine(selfName, opponent.displayName, result)}</strong>.
            {pending && (
              <span className="text-[var(--accent)]"> Heads up — a result vs {opponent.displayName} is already pending.</span>
            )}
          </>
        ) : (
          <span className="muted">Pick an opponent to see exactly what will be recorded.</span>
        )}
      </div>

      <div>
        <Button type="submit" disabled={!opponentId}>
          Report{opponent ? ` — ${confirmationLine(selfName, opponent.displayName, result)}` : ""}
        </Button>
      </div>
    </form>
  );
}

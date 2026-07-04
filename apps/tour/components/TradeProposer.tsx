"use client";

// N-for-N fantasy trade proposer. Pick a trade partner, then check any number of YOUR players to
// give and any number of THEIRS to receive; the swap must be even (same count each side) - enforced
// here for a live button label + disable, and re-validated server-side (ownership + even swap).
// The receiver is a single manager, so the "receive" pool is that partner's roster only.
import { useActionState, useEffect, useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/action-result";

interface RosterPlayer {
  playerId: string;
  name: string;
}

export function TradeProposer({
  season,
  myRoster,
  managers,
  rosterByTeam,
  action,
}: {
  season: string;
  myRoster: RosterPlayer[];
  managers: { id: string; name: string }[];
  rosterByTeam: Record<string, RosterPlayer[]>;
  action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
}) {
  const [partnerId, setPartnerId] = useState(managers[0]?.id ?? "");
  const [give, setGive] = useState<Set<string>>(new Set());
  const [receive, setReceive] = useState<Set<string>>(new Set());
  const [state, formAction] = useActionState(action, null);

  // The checkboxes are React-controlled, so the post-action form reset doesn't clear them. Clear
  // the picks ourselves on success, so the still-enabled button can't re-submit the same offer as
  // a duplicate PROPOSED trade. On error we keep the selection so the manager can adjust and retry.
  useEffect(() => {
    if (state?.ok) {
      setGive(new Set());
      setReceive(new Set());
    }
  }, [state]);

  const partnerRoster = rosterByTeam[partnerId] ?? [];
  const even = give.size > 0 && give.size === receive.size;

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const onPartner = (id: string) => {
    setPartnerId(id);
    setReceive(new Set()); // their roster changed - clear the receive picks
  };

  return (
    <div>
      {state && (
        <div className={`flash ${state.ok ? "success" : "error"}`} role="status" aria-live="polite">{state.message}</div>
      )}
      <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="season" value={season} />
      <input type="hidden" name="receiverTeamId" value={partnerId} />

      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="sub">Trade with</span>
        <select
          value={partnerId}
          onChange={(e) => onPartner(e.target.value)}
          className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1"
        >
          {managers.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap gap-4">
        <fieldset className="min-w-52">
          <legend className="sub">You give ({give.size})</legend>
          <div className="mt-1 flex flex-col gap-1" style={{ maxHeight: 220, overflowY: "auto" }}>
            {myRoster.length === 0 && <span className="sub">You have no players.</span>}
            {myRoster.map((p) => (
              <label key={p.playerId} className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" name="give" value={p.playerId} checked={give.has(p.playerId)} onChange={() => setGive((s) => toggle(s, p.playerId))} className="size-4" />
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="min-w-52" key={partnerId}>
          <legend className="sub">You get ({receive.size})</legend>
          <div className="mt-1 flex flex-col gap-1" style={{ maxHeight: 220, overflowY: "auto" }}>
            {partnerRoster.length === 0 && <span className="sub">No players to pick.</span>}
            {partnerRoster.map((p) => (
              <label key={p.playerId} className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" name="receive" value={p.playerId} checked={receive.has(p.playerId)} onChange={() => setReceive((s) => toggle(s, p.playerId))} className="size-4" />
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1.5">
          <span className="sub">Note</span>
          <Input name="reason" placeholder="optional" maxLength={200} className="w-56" />
        </label>
        <SubmitButton disabled={!even} pendingText="Sending...">
          {even ? `Propose ${give.size}-for-${receive.size}` : give.size !== receive.size ? "Even swap only" : "Pick players"}
        </SubmitButton>
      </div>
      </form>
    </div>
  );
}

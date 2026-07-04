"use client";

// TO control to set the fantasy snake-draft order before starting. Reorder managers (up/down or
// randomize), then start - the chosen sequence posts as order[] to startFantasyDraft, which freezes
// it as the round-1 order (snake reverses each round). Default is join order; leaving it unchanged
// is identical to starting with no override.
import { useState } from "react";
import { ArrowUp, ArrowDown, Shuffle } from "lucide-react";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import type { ActionResult } from "@/lib/action-result";

interface Manager {
  id: string;
  name: string;
}

export function DraftOrderEditor({
  season,
  managers,
  action,
}: {
  season: string;
  managers: Manager[];
  action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
}) {
  const nameById = new Map(managers.map((m) => [m.id, m.name]));
  const [order, setOrder] = useState<string[]>(managers.map((m) => m.id));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    setOrder((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const randomize = () => {
    setOrder((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
      }
      return next;
    });
  };

  return (
    <ActionFlashForm action={action} className="flex flex-col gap-3">
      <input type="hidden" name="season" value={season} />
      {order.map((id) => (
        <input key={`h-${id}`} type="hidden" name="order" value={id} />
      ))}

      <p className="sub" style={{ margin: 0 }}>
        Starting the draft locks the manager list and freezes this order (manager #1 goes on the
        clock). Reorder below, or keep join order.
      </p>

      <ol className="flex flex-col gap-1" style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
        {order.map((id, i) => (
          <li key={id} className="flex items-center gap-2 rounded border border-[var(--border)] px-2 py-1">
            <span className="num" style={{ width: 24 }}>{i + 1}</span>
            <span className="flex-1">{nameById.get(id) ?? id}</span>
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Move up" className="p-1 disabled:opacity-30"><ArrowUp className="size-4" /></button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === order.length - 1} title="Move down" className="p-1 disabled:opacity-30"><ArrowDown className="size-4" /></button>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={randomize} className="inline-flex items-center gap-1.5 text-sm" title="Shuffle the order">
          <Shuffle className="size-4" /> Randomize
        </button>
        <SubmitButton pendingText="Starting...">Start snake draft</SubmitButton>
      </div>
    </ActionFlashForm>
  );
}

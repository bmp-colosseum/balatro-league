"use client";

// One dropdown = one set result. Instead of two score boxes plus FF/DQ buttons,
// the TO picks the outcome from a single list (each player's win scores, a forfeit
// win each way, or a void/double-DQ) and it saves on pick. Labelled by the two
// players in the set (not their teams) since a set is one player vs one player. The
// options are derived from the set's best-of so only reachable scores show.
// Preselects the recorded result via `current` (see setOutcomeValue).
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect, type FormSelectOption } from "@/components/FormSelect";
import { setOutcomeAction } from "@/app/admin/matchups/[matchupId]/actions";

export function SetOutcomeSelect({
  matchupId,
  setId,
  bestOf,
  aName,
  bName,
  current,
}: {
  matchupId: string;
  setId: string;
  bestOf: number;
  aName: string; // team A's player in this set
  bName: string; // team B's player in this set
  current: string;
}) {
  const win = Math.max(1, Math.ceil(bestOf / 2)); // first to `win` games
  const a = aName.slice(0, 16);
  const b = bName.slice(0, 16);
  const options: FormSelectOption[] = [];
  // Team A wins: win-0 .. win-(win-1); value is "gamesA-gamesB".
  for (let l = win - 1; l >= 0; l--) options.push({ value: `${win}-${l}`, label: `${a} ${win}-${l}` });
  // Team B wins.
  for (let l = win - 1; l >= 0; l--) options.push({ value: `${l}-${win}`, label: `${b} ${win}-${l}` });
  options.push({ value: "ff-a", label: `${a} wins (forfeit)` });
  options.push({ value: "ff-b", label: `${b} wins (forfeit)` });
  options.push({ value: "void", label: "Void / double DQ (0-0)" });

  // If a recorded result doesn't match any generated option (e.g. an odd imported
  // score), keep it visible so the dropdown shows the real value rather than blank.
  const known = new Set(options.map((o) => o.value));
  if (current && !known.has(current)) options.unshift({ value: current, label: current });

  return (
    <ActionFlashForm action={setOutcomeAction}>
      <input type="hidden" name="matchupId" value={matchupId} />
      <input type="hidden" name="setId" value={setId} />
      <FormSelect
        name="outcome"
        size="sm"
        options={options}
        defaultValue={current}
        placeholder="-- pick result --"
        submitOnChange
        triggerClassName="min-w-[11rem]"
      />
    </ActionFlashForm>
  );
}

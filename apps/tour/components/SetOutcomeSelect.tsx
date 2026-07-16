"use client";

// One dropdown = one set result. Instead of two score boxes plus FF/DQ buttons,
// the TO picks the outcome from a single list and it saves on pick. Labelled by the
// two players in the set (a set is one player vs one player).
//
// Every result is recorded in Bo3 terms (rules doc + design §12.4): winner is 2, the
// loser is 1 if the set was competitive or 0 for a sweep -- a Bo5/Bo7 is converted to
// its Bo3 equivalent BY THE TO here (3-2/3-1 -> 2-1, 3-0 -> 2-0). So the options are
// always 2-0 / 2-1 regardless of the set's best-of. Preselects the recorded result
// via `current` (see setOutcomeValue).
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect, type FormSelectOption } from "@/components/FormSelect";
import { setOutcomeAction } from "@/app/admin/matchups/[matchupId]/actions";

export function SetOutcomeSelect({
  matchupId,
  setId,
  aName,
  bName,
  current,
}: {
  matchupId: string;
  setId: string;
  aName: string; // team A's player in this set
  bName: string; // team B's player in this set
  current: string;
}) {
  const a = aName.slice(0, 16);
  const b = bName.slice(0, 16);
  // Bo3 terms only: winner 2, loser 1 (competitive) or 0 (sweep). Value is "gamesA-gamesB".
  const options: FormSelectOption[] = [
    { value: "2-1", label: `${a} 2-1` },
    { value: "2-0", label: `${a} 2-0 (sweep)` },
    { value: "1-2", label: `${b} 2-1` },
    { value: "0-2", label: `${b} 2-0 (sweep)` },
    { value: "ff-a", label: `${a} wins (forfeit)` },
    { value: "ff-b", label: `${b} wins (forfeit)` },
    { value: "void", label: "Void / double DQ (0-0)" },
  ];

  // If a recorded result doesn't match a Bo3 option (e.g. an old raw Bo5 score still
  // on file), keep it visible so the dropdown shows the real value rather than blank.
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

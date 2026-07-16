// Shared per-set reporting controls -- the ONE component for TO set entry, used by
// the matchup console and the season audit page so the experience is identical
// everywhere. A single outcome dropdown (SetOutcomeSelect) records the result on
// pick; "Clear" undoes a recorded result. Server component: the dropdown posts to
// setOutcomeAction, Clear to unreportSetAction (both gate via can("SCHEDULE")).
import { CircleCheck, CircleDashed } from "lucide-react";
import { SetOutcomeSelect } from "@/components/SetOutcomeSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { unreportSetAction } from "@/app/admin/matchups/[matchupId]/actions";

export function SetReportControls({
  matchupId,
  setId,
  aName,
  bName,
  bestOf,
  reported,
  outcome,
}: {
  matchupId: string;
  setId: string;
  aName: string; // team A's player in this set (results are labelled by player, not team)
  bName: string; // team B's player in this set
  bestOf: number; // drives the raw score options (Bo3 2-x, Bo5 3-x, ...); server converts to Bo3
  reported: boolean;
  outcome: string; // encoded recorded result (see setOutcomeValue); "" when unreported
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* At-a-glance status so a done set reads differently from one still owed. */}
      {reported ? (
        <span className="inline-flex items-center gap-1 text-sm font-medium" style={{ color: "var(--success, #16a34a)" }} title="Result recorded">
          <CircleCheck className="size-4" /> Reported
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-sm" style={{ color: "var(--warning, #f5a524)" }} title="No result yet">
          <CircleDashed className="size-4" /> Needs result
        </span>
      )}
      <SetOutcomeSelect
        matchupId={matchupId}
        setId={setId}
        bestOf={bestOf}
        aName={aName}
        bName={bName}
        current={outcome}
      />
      {reported && (
        <form action={unreportSetAction}>
          <input type="hidden" name="matchupId" value={matchupId} />
          <input type="hidden" name="setId" value={setId} />
          <SubmitButton size="sm" variant="secondary" pendingText="...">Clear</SubmitButton>
        </form>
      )}
    </div>
  );
}

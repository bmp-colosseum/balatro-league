// Shared per-set reporting controls -- the ONE component for TO set entry, used by
// the matchup console and the season audit page so the experience is identical
// everywhere. A single outcome dropdown (SetOutcomeSelect) records the result on
// pick; "Clear" undoes a recorded result. Server component: the dropdown posts to
// setOutcomeAction, Clear to unreportSetAction (both gate via can("SCHEDULE")).
import { SetOutcomeSelect } from "@/components/SetOutcomeSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { unreportSetAction } from "@/app/admin/matchups/[matchupId]/actions";

export function SetReportControls({
  matchupId,
  setId,
  aName,
  bName,
  reported,
  outcome,
}: {
  matchupId: string;
  setId: string;
  aName: string; // team A's player in this set (results are labelled by player, not team)
  bName: string; // team B's player in this set
  reported: boolean;
  outcome: string; // encoded recorded result (see setOutcomeValue); "" when unreported
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SetOutcomeSelect
        matchupId={matchupId}
        setId={setId}
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

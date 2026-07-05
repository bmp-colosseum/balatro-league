// Shared per-set reporting controls (report / update, clear, forfeit) -- the ONE
// component for TO set entry, used by the matchup console and the season audit page
// so the experience is identical everywhere. Server component: plain forms wired to
// the matchup console's actions (which gate via can("SCHEDULE", matchupScope)).
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { reportSetAction, unreportSetAction, forfeitSetAction } from "@/app/admin/matchups/[matchupId]/actions";

export function SetReportControls({
  matchupId,
  setId,
  teamAName,
  teamBName,
  reported,
  teamAGames,
  teamBGames,
}: {
  matchupId: string;
  setId: string;
  teamAName: string;
  teamBName: string;
  reported: boolean;
  teamAGames?: number | null;
  teamBGames?: number | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActionFlashForm action={reportSetAction}>
        <input type="hidden" name="matchupId" value={matchupId} />
        <input type="hidden" name="setId" value={setId} />
        <span className="inline-flex items-center gap-1">
          <input
            type="number" name="gamesA" min={0} defaultValue={teamAGames ?? undefined}
            className="w-12 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1 py-0.5 text-center"
          />
          <span className="sub">–</span>
          <input
            type="number" name="gamesB" min={0} defaultValue={teamBGames ?? undefined}
            className="w-12 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1 py-0.5 text-center"
          />
          <SubmitButton size="sm" variant="secondary" pendingText="…">{reported ? "Update" : "Report"}</SubmitButton>
        </span>
      </ActionFlashForm>
      {reported && (
        <form action={unreportSetAction}>
          <input type="hidden" name="matchupId" value={matchupId} />
          <input type="hidden" name="setId" value={setId} />
          <SubmitButton size="sm" variant="secondary" pendingText="…">Clear</SubmitButton>
        </form>
      )}
      <span className="sub" title="0–2 set loss (rules: no reasonable scheduling effort)">FF:</span>
      {(["A", "B"] as const).map((side) => (
        <form key={side} action={forfeitSetAction}>
          <input type="hidden" name="matchupId" value={matchupId} />
          <input type="hidden" name="setId" value={setId} />
          <input type="hidden" name="forfeitTeam" value={side} />
          <SubmitButton size="sm" variant="secondary" pendingText="…" title={`${side === "A" ? teamAName : teamBName} forfeits`}>
            {(side === "A" ? teamAName : teamBName).slice(0, 10)}
          </SubmitButton>
        </form>
      ))}
    </div>
  );
}

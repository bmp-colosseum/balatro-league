import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmButton } from "@/components/ConfirmButton";
import { rankLabel, type StandingRow, type Tiebreak } from "@/lib/standings";
import type { BestNStandingRow } from "@/lib/standings-best-n";
import {
  loadStandingsPreview,
  loadStandingsPreviewSeasonOptions,
  type StandingsPreviewCandidate,
  type StandingsPreviewCandidateDivision,
  type StandingsPreviewDivision,
  type StandingsPreviewLivesInfo,
  type StandingsPreviewPlayerDiff,
} from "@/lib/loaders/standings-preview";
import { applyHypotheticalDropsAction, setSeasonScoringModeAction } from "./actions";
import type { SeasonScoringMode } from "@/lib/standings-mode";

const TIEBREAK_LABEL: Record<Tiebreak, string> = { chain: "Today's tiebreaks", lives: "Add net lives" };

export const dynamic = "force-dynamic";

const selectStyle = {
  fontSize: 13,
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--border, rgba(255,255,255,0.12))",
  background: "var(--surface-2, rgba(255,255,255,0.05))",
  color: "var(--text)",
} as const;

const MODE_LABEL: Record<SeasonScoringMode, string> = {
  all: "counting every game",
  "best-n-count": "best N (count)",
  "best-n-void": "best N (void)",
};

// Compact table shared by the "Current" and "Best N" sides of each
// division's comparison. `showOf` adds the counted/of column (only
// meaningful on the best-N side -- the current side counts everything, so
// counted === of === played there and the column would be redundant).
function CompactTable({
  rows,
  diffByPlayerId,
  showOf,
  showNetLives,
}: {
  rows: (StandingRow | BestNStandingRow)[];
  diffByPlayerId: Map<string, StandingsPreviewPlayerDiff>;
  showOf: boolean;
  // Only true when the page's tiebreak toggle is "lives" -- adds a Net
  // lives column (netLives / livesGamesMissing come off the row itself;
  // see web/lib/standings.ts's StandingRow).
  showNetLives?: boolean;
}) {
  const columnCount = 4 + (showOf ? 1 : 0) + (showNetLives ? 1 : 0);
  return (
    <div className="table-scroll">
      <table className="table-dense" style={{ margin: 0 }}>
        <thead>
          <tr>
            <th></th>
            <th>Player</th>
            <th>Pts</th>
            <th>Record</th>
            {showOf && <th title="Results counted toward this best-N standing">Of</th>}
            {showNetLives && <th title="Net lives: sum of remaining lives in wins minus sum of remaining lives in losses">Net lives</th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columnCount} className="muted">No rows.</td></tr>
          ) : (
            rows.map((r, i) => {
              const diff = diffByPlayerId.get(r.player.id);
              const rankChanged = diff?.rankChanged || diff?.livesRankChanged;
              const rowStyle = diff?.boundaryChanged
                ? { background: "rgba(241,196,15,0.14)" }
                : rankChanged
                  ? { background: "rgba(118,199,255,0.08)" }
                  : undefined;
              const bestN = showOf ? (r as BestNStandingRow) : null;
              const missing = r.livesGamesMissing ?? 0;
              return (
                <tr key={r.player.id} style={rowStyle}>
                  <td>{rankLabel(r, i)}</td>
                  <td>
                    {r.player.displayName}
                    {diff?.boundaryChanged && (
                      <span title={diff.boundaryNote ?? undefined} style={{ marginLeft: 4, color: "var(--accent)" }}>
                        !
                      </span>
                    )}
                    {!diff?.boundaryChanged && rankChanged && diff && (
                      <span title={diff.livesRankChanged && !diff.rankChanged ? "Rank changed by the net-lives tiebreak" : undefined} style={{ marginLeft: 4, color: "var(--info)" }}>
                        {(diff.bestNRank ?? 0) < (diff.currentRank ?? 0) ? "^" : "v"}
                      </span>
                    )}
                  </td>
                  <td><strong>{r.points}</strong></td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {r.wins}W - {r.draws}D - {r.losses}L
                  </td>
                  {showOf && bestN && (
                    <td className="muted">{bestN.counted} of {bestN.of}</td>
                  )}
                  {showNetLives && (
                    <td className="muted" title={missing > 0 ? `${missing} game${missing === 1 ? "" : "s"} without lives` : undefined}>
                      {r.netLives ?? 0}{missing > 0 ? ` (${missing} missing)` : ""}
                    </td>
                  )}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// Short division-level note: "Lives broke N tie(s)" plus any rows missing
// recorded lives data. Returns null when there's nothing to say (including
// always, under the page's default "chain" tiebreak, since livesInfo is the
// zero value there).
function LivesNote({ livesInfo }: { livesInfo: StandingsPreviewLivesInfo }) {
  if (livesInfo.tiesBroken === 0 && livesInfo.missingLives.length === 0) return null;
  return (
    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
      {livesInfo.lineDecisions.map((line) => (
        <div key={line}><strong>{line}</strong></div>
      ))}
      {livesInfo.tiesBroken > 0 && livesInfo.lineDecisions.length === 0 && (
        <div>Lives broke {livesInfo.tiesBroken} tie{livesInfo.tiesBroken === 1 ? "" : "s"}, none on a promotion or relegation line.</div>
      )}
      {livesInfo.missingLives.length > 0 && (
        <div>
          Missing lives data:{" "}
          {livesInfo.missingLives
            .map((m) => `${m.displayName} (${m.livesGamesMissing} game${m.livesGamesMissing === 1 ? "" : "s"})`)
            .join(", ")}
        </div>
      )}
    </div>
  );
}

// "Use this rule for season N" / "Back to counting every game" -- one tiny
// POST form, reused under Current and both Best N columns. Disabled (and
// relabeled) when its mode is already the season's active rule, so the
// admin can see at a glance which one is live without a separate badge.
function SetScoringModeForm({
  seasonId,
  seasonLabel,
  mode,
  currentMode,
  label,
}: {
  seasonId: string;
  seasonLabel: string;
  mode: SeasonScoringMode;
  currentMode: SeasonScoringMode;
  label: string;
}) {
  const isCurrent = mode === currentMode;
  return (
    <form action={setSeasonScoringModeAction} style={{ marginTop: 8 }}>
      <input type="hidden" name="season" value={seasonId} />
      <input type="hidden" name="mode" value={mode} />
      <ConfirmButton
        message={`Switch ${seasonLabel}'s LIVE standings to "${label}"? This takes effect immediately for every division.`}
        variant={isCurrent ? "secondary" : "default"}
        size="sm"
      >
        {isCurrent ? "Current rule" : label}
      </ConfirmButton>
    </form>
  );
}

// One candidate's column: its compact table, its own notes list (the two
// candidates can disagree on who moves, so each gets its own notes), and
// the switch to make this rule the season's live one.
function CandidateColumn({
  label,
  title,
  candidate,
  seasonId,
  seasonLabel,
  mode,
  currentMode,
  showNetLives,
}: {
  label: string;
  title: string;
  candidate: StandingsPreviewCandidate;
  seasonId: string;
  seasonLabel: string;
  mode: SeasonScoringMode;
  currentMode: SeasonScoringMode;
  showNetLives: boolean;
}) {
  const diffByPlayerId = new Map(candidate.players.map((p) => [p.playerId, p]));
  const notes = candidate.players.filter((p) => p.boundaryChanged && p.boundaryNote);

  return (
    <div>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }} title={title}>
        {label}
      </div>
      <CompactTable rows={candidate.rows} diffByPlayerId={diffByPlayerId} showOf={true} showNetLives={showNetLives} />
      <LivesNote livesInfo={candidate.livesInfo} />
      {notes.length > 0 && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 11 }}>
          {notes.map((n) => (
            <li key={n.playerId}>
              <strong>{n.displayName}</strong> -- {n.boundaryNote}
            </li>
          ))}
        </ul>
      )}
      <SetScoringModeForm
        seasonId={seasonId}
        seasonLabel={seasonLabel}
        mode={mode}
        currentMode={currentMode}
        label={`Use this rule for ${seasonLabel}`}
      />
    </div>
  );
}

function DivisionCard({
  d,
  seasonId,
  seasonLabel,
  currentMode,
  tiebreak,
}: {
  d: StandingsPreviewDivision;
  seasonId: string;
  seasonLabel: string;
  currentMode: SeasonScoringMode;
  tiebreak: Tiebreak;
}) {
  const showNetLives = tiebreak === "lives";

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>{d.tierName} - {d.name}</strong>
        <span className="pill" style={{ fontSize: 11 }}>
          counts best {d.n} of {d.scheduled} matches
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          {d.dropouts} unreplaced dropout{d.dropouts === 1 ? "" : "s"} - {d.k} players originally
        </span>
        {d.hypotheticalDrops.length > 0 && (
          <span
            className="pill"
            style={{ fontSize: 11, background: "rgba(241,196,15,0.18)" }}
            title="Treated as dropped for THIS PREVIEW only -- nothing has been applied yet"
          >
            what-if: {d.hypotheticalDrops.map((h) => h.displayName).join(", ")}
          </span>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", gap: 12, marginTop: 10 }}>
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
            Current
          </div>
          <CompactTable rows={d.currentRows} diffByPlayerId={d.currentLivesDiffByPlayerId} showOf={false} showNetLives={showNetLives} />
          <LivesNote livesInfo={d.currentLivesInfo} />
          <SetScoringModeForm
            seasonId={seasonId}
            seasonLabel={seasonLabel}
            mode="all"
            currentMode={currentMode}
            label="Back to counting every game"
          />
        </div>
        <CandidateColumn
          label="Best N - count (preview)"
          title="A result against the dropout is a normal result, eligible to count or be dropped like any other."
          candidate={d.countMode}
          seasonId={seasonId}
          seasonLabel={seasonLabel}
          mode="best-n-count"
          currentMode={currentMode}
          showNetLives={showNetLives}
        />
        <CandidateColumn
          label="Best N - void (preview)"
          title="Every result against the dropout is erased for everyone first; nobody gains or loses from having played them."
          candidate={d.voidMode}
          seasonId={seasonId}
          seasonLabel={seasonLabel}
          mode="best-n-void"
          currentMode={currentMode}
          showNetLives={showNetLives}
        />
      </div>
    </div>
  );
}

// "Who to treat as dropped" panel: a GET form so the three tables below
// re-render against the chosen hypothetical drops without any client JS.
// Candidates come pre-ticked from suggestDropCandidates; anyone else ACTIVE
// is reachable via the collapsed "add someone else" list.
function DropPickerPanel({
  selectedSeasonId,
  maxPlayed,
  pickerTouched,
  selectedIds,
  candidateDivisions,
}: {
  selectedSeasonId: string;
  maxPlayed: number;
  pickerTouched: boolean;
  selectedIds: Set<string>;
  candidateDivisions: StandingsPreviewCandidateDivision[];
}) {
  const nothingToShow = candidateDivisions.every(
    (cd) => cd.candidates.length === 0 && cd.otherActiveMembers.length === 0,
  );

  return (
    <form method="get" style={{ marginTop: 12 }}>
      <input type="hidden" name="season" value={selectedSeasonId} />
      <input type="hidden" name="pickerTouched" value="1" />
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 14 }}>Who to treat as dropped</strong>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span className="muted">Players with at most</span>
            <input
              type="number"
              name="maxPlayed"
              min={0}
              defaultValue={maxPlayed}
              style={{ ...selectStyle, width: 54 }}
            />
            <span className="muted">played matches</span>
          </label>
          <Button type="submit" variant="secondary" size="sm">Recalculate</Button>
        </div>
        <p className="muted" style={{ fontSize: 11, margin: 0 }}>
          Tick who to treat as dropped, then Recalculate to update the three tables below. Nothing is applied until
          you use &ldquo;Apply these drops&rdquo;.
        </p>

        {nothingToShow ? (
          <div className="muted" style={{ fontSize: 12 }}>No active players this season.</div>
        ) : (
          candidateDivisions.map((cd) => {
            if (cd.candidates.length === 0 && cd.otherActiveMembers.length === 0) return null;
            return (
              <div key={cd.id} style={{ borderTop: "1px solid var(--border, rgba(255,255,255,0.08))", paddingTop: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{cd.tierName} - {cd.name}</div>
                {cd.candidates.length === 0 ? (
                  <div className="muted" style={{ fontSize: 11 }}>No low-activity candidates.</div>
                ) : (
                  <ul style={{ margin: "4px 0", paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}>
                    {cd.candidates.map((c) => (
                      <li key={c.playerId} style={{ fontSize: 12 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input
                            type="checkbox"
                            name="drop"
                            value={c.playerId}
                            defaultChecked={pickerTouched ? selectedIds.has(c.playerId) : true}
                          />
                          <span>{c.displayName}</span>
                          <span className="muted" style={{ fontSize: 11 }}>
                            {c.playedCount} played{c.unplayedCount > 0 ? `, ${c.unplayedCount} scheduled` : ""}
                            {" -- "}
                            {c.reasons.join(", ")}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                {cd.otherActiveMembers.length > 0 && (
                  <details style={{ marginTop: 4 }}>
                    <summary className="muted" style={{ fontSize: 11, cursor: "pointer" }}>Add someone else...</summary>
                    <ul style={{ margin: "4px 0", paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}>
                      {cd.otherActiveMembers.map((m) => (
                        <li key={m.playerId} style={{ fontSize: 12 }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <input
                              type="checkbox"
                              name="drop"
                              value={m.playerId}
                              defaultChecked={pickerTouched && selectedIds.has(m.playerId)}
                            />
                            <span>{m.displayName}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })
        )}
      </div>
    </form>
  );
}

// "Apply these drops" panel: a SEPARATE, POST form -- ticking boxes above
// and clicking Recalculate never applies anything by itself. Submitting
// this form drops exactly the players currently selected, for real,
// through dropDivisionMember (see ./actions.ts).
function ApplyDropsForm({
  selectedSeasonId,
  selectedDrops,
}: {
  selectedSeasonId: string;
  selectedDrops: { playerId: string; displayName: string; divisionId: string; divisionName: string; tierName: string }[];
}) {
  if (selectedDrops.length === 0) return null;
  const n = selectedDrops.length;
  return (
    <form action={applyHypotheticalDropsAction} style={{ marginTop: 12 }}>
      <input type="hidden" name="season" value={selectedSeasonId} />
      {selectedDrops.map((d) => (
        <input key={d.playerId} type="hidden" name="pair" value={`${d.divisionId}:${d.playerId}`} />
      ))}
      <div className="card card-danger" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <strong style={{ fontSize: 14 }}>Apply these drops</strong>
        <div style={{ fontSize: 12 }}>
          Drops the following {n} player{n === 1 ? "" : "s"} for real -- played results are kept, unplayed pairings
          are voided, exactly like dropping one player at a time on the division page:
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          {selectedDrops.map((d) => (
            <li key={d.playerId}>
              {d.displayName} -- {d.tierName} / {d.divisionName}
            </li>
          ))}
        </ul>
        <label style={{ display: "grid", gap: 4, fontSize: 12, maxWidth: 420 }}>
          <span className="muted">Reason (required, admin-only)</span>
          <Input type="text" name="reason" required placeholder="e.g. no activity all season" />
        </label>
        <div>
          <ConfirmButton
            message={`Drop ${n} player(s) for real? This applies immediately and cannot be undone from this page.`}
            variant="destructive"
          >
            Apply {n} drop{n === 1 ? "" : "s"}
          </ConfirmButton>
        </div>
      </div>
    </form>
  );
}

export default async function StandingsPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    season?: string;
    maxPlayed?: string;
    drop?: string | string[];
    pickerTouched?: string;
    applyErr?: string;
    applied?: string;
    modeErr?: string;
    modeOk?: string;
    tiebreak?: string;
  }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const seasonOptions = await loadStandingsPreviewSeasonOptions();

  if (seasonOptions.length === 0) {
    return (
      <>
        <SiteNav activePath="/admin" />
        <AdminNav activePath="/admin/standings-preview" />
        <main>
          <h2>Best-N standings preview</h2>
          <div className="card muted">No seasons to preview.</div>
        </main>
      </>
    );
  }

  const defaultSeasonId = seasonOptions.find((s) => s.isActive)?.id ?? seasonOptions[0]!.id;
  const selectedSeasonId = sp.season && seasonOptions.some((s) => s.id === sp.season) ? sp.season : defaultSeasonId;

  const maxPlayedRaw = parseInt(sp.maxPlayed ?? "0", 10);
  const maxPlayed = Number.isFinite(maxPlayedRaw) ? Math.max(0, maxPlayedRaw) : 0;
  // Whether the "Who to treat as dropped" panel has ever been submitted.
  // Until then, every suggested candidate is pre-ticked; once submitted,
  // the checked boxes on that submit are the ONLY source of truth (so
  // unchecking every box is a valid "drop nobody" choice, not ignored).
  const pickerTouched = sp.pickerTouched === "1";
  const submittedIds = new Set(sp.drop === undefined ? [] : Array.isArray(sp.drop) ? sp.drop : [sp.drop]);
  // "chain" (default): today's tiebreak, unchanged. "lives": preview
  // breaking ties by net lives (see web/lib/standings.ts's Tiebreak) --
  // TODO(best-n-switch): this toggle is PREVIEW ONLY, same as the best-N
  // engine option it rides alongside (see web/lib/standings-best-n.ts's
  // header) -- no season-level setting exists yet to make "lives" live.
  const tiebreak: Tiebreak = sp.tiebreak === "lives" ? "lives" : "chain";

  // Pass 1: candidateDivisions don't depend on hypotheticalDroppedIds (they
  // reflect the REAL roster), so this call just resolves the suggestion
  // defaults when the picker hasn't been touched yet.
  const suggestionPass = await loadStandingsPreview(selectedSeasonId, { candidateMaxPlayed: maxPlayed });
  const hypotheticalDroppedIds = pickerTouched
    ? submittedIds
    : new Set(suggestionPass.candidateDivisions.flatMap((cd) => cd.candidates.map((c) => c.playerId)));

  // Pass 2: the real render data, now that we know exactly who to treat as
  // dropped. Keeping the existing behaviour when nothing is ticked falls
  // out naturally -- an empty set here reproduces today's output exactly.
  const preview = await loadStandingsPreview(selectedSeasonId, {
    candidateMaxPlayed: maxPlayed,
    hypotheticalDroppedIds,
    tiebreak,
  });

  // Preserves every OTHER current query param while toggling tiebreak, so
  // the season/drop-picker selections survive clicking a pill.
  function tiebreakHref(next: Tiebreak): string {
    const params = new URLSearchParams();
    params.set("season", selectedSeasonId);
    if (sp.maxPlayed) params.set("maxPlayed", sp.maxPlayed);
    if (pickerTouched) {
      params.set("pickerTouched", "1");
      for (const id of submittedIds) params.append("drop", id);
    }
    params.set("tiebreak", next);
    return `?${params.toString()}`;
  }

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/standings-preview" />
      <main>
        <h2>Best-N standings preview</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          Preview of the proposed &ldquo;best N&rdquo; dropout-adjusted scoring rule, side by side with the{" "}
          <strong>current</strong> standings. Just viewing this page applies nothing -- the Apply/Use buttons below
          are the only things that write anything, and each says exactly what it will do before you confirm.
        </p>

        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>3+-way tie breaking:</span>
          {(["chain", "lives"] as const).map((t) => (
            <a
              key={t}
              href={tiebreakHref(t)}
              className="pill"
              style={{
                fontSize: 12,
                textDecoration: "none",
                background: t === tiebreak ? "var(--accent, rgba(118,199,255,0.25))" : undefined,
                fontWeight: t === tiebreak ? 600 : 400,
              }}
            >
              {TIEBREAK_LABEL[t]}
            </a>
          ))}
          {tiebreak === "lives" && (
            <span className="muted" style={{ fontSize: 11 }} title="Preview only -- nothing live uses this yet">
              preview only
            </span>
          )}
        </div>

        {sp.applyErr && <Callout type="danger" style={{ marginTop: 8 }}>Couldn&apos;t apply: {sp.applyErr}</Callout>}
        {sp.applied && (
          <Callout type="success" style={{ marginTop: 8 }}>
            Dropped {sp.applied} player{sp.applied === "1" ? "" : "s"}.
          </Callout>
        )}
        {sp.modeErr && <Callout type="danger" style={{ marginTop: 8 }}>Couldn&apos;t change the scoring rule: {sp.modeErr}</Callout>}
        {sp.modeOk && (
          <Callout type="success" style={{ marginTop: 8 }}>
            Live standings now use &ldquo;{MODE_LABEL[sp.modeOk as SeasonScoringMode] ?? sp.modeOk}&rdquo; for this season.
          </Callout>
        )}

        <form method="get" style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginTop: 8 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span className="muted">Season</span>
            <select name="season" defaultValue={selectedSeasonId} style={selectStyle}>
              {seasonOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}{s.isActive ? " (active)" : ""}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary">View {"->"}</Button>
        </form>

        {!preview.season ? (
          <div className="card muted" style={{ marginTop: 12 }}>Season not found.</div>
        ) : (
          <>
            <DropPickerPanel
              selectedSeasonId={selectedSeasonId}
              maxPlayed={maxPlayed}
              pickerTouched={pickerTouched}
              selectedIds={hypotheticalDroppedIds}
              candidateDivisions={preview.candidateDivisions}
            />

            <ApplyDropsForm selectedSeasonId={selectedSeasonId} selectedDrops={preview.selectedDrops} />

            <div className="card" style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
              <span>{preview.season.label}</span>
              <span className="muted">
                <strong>{preview.summary.divisionsWithDropout}</strong> of{" "}
                <strong>{preview.summary.totalDivisions}</strong> division{preview.summary.totalDivisions === 1 ? "" : "s"} have
                an unreplaced dropout
              </span>
              {preview.selectedDrops.length > 0 && (
                <span className="muted">
                  <strong>{preview.selectedDrops.length}</strong> player{preview.selectedDrops.length === 1 ? "" : "s"} hypothetically
                  dropped
                </span>
              )}
              <span className="muted">
                count: <strong>{preview.summary.countMode.rankChanges}</strong> rank change{preview.summary.countMode.rankChanges === 1 ? "" : "s"},{" "}
                <strong>{preview.summary.countMode.boundaryChanges}</strong> promotion/relegation change{preview.summary.countMode.boundaryChanges === 1 ? "" : "s"}
              </span>
              <span className="muted">
                void: <strong>{preview.summary.voidMode.rankChanges}</strong> rank change{preview.summary.voidMode.rankChanges === 1 ? "" : "s"},{" "}
                <strong>{preview.summary.voidMode.boundaryChanges}</strong> promotion/relegation change{preview.summary.voidMode.boundaryChanges === 1 ? "" : "s"}
              </span>
              {tiebreak === "lives" && (
                <span className="muted">
                  promotion/relegation lines decided by lives: <strong>{preview.summary.livesTiesBroken}</strong>
                </span>
              )}
            </div>

            {preview.divisions.length === 0 ? (
              <Callout type="success" style={{ marginTop: 12 }}>
                No divisions in {preview.season.label} have an unreplaced dropout -- best-N would make no difference
                anywhere this season.
              </Callout>
            ) : (
              preview.divisions.map((d) => (
                <DivisionCard
                  key={d.id}
                  d={d}
                  seasonId={preview.season!.id}
                  seasonLabel={preview.season!.label}
                  currentMode={preview.season!.scoringMode}
                  tiebreak={tiebreak}
                />
              ))
            )}
          </>
        )}
      </main>
    </>
  );
}

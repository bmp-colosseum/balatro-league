// The merged admin Matches page -- replaces /admin/results, /admin/resolve,
// and /admin/disputes (see .claude/knowledge/ux-audit/01-findings.md,
// "Target: three weekly pages"). One filtered list of this season's matches
// (division / status / age / dropped-player filters), a per-row expand for
// the single-match record/override/DQ/undo toolkit (MatchActionsPanel, or a
// direct override+undo pair once a result's already recorded), an always-
// visible inline panel for a disputed row's proposed correction, and the
// same tick-box preview-then-apply bulk flow the old /admin/resolve queue
// used -- unchanged core logic (lib/bulk-resolve-core.ts / lib/bulk-resolve.ts),
// just one shared list instead of three separate pages.
//
// The three old routes still work: each now just redirects here with the
// matching status filter (see their page.tsx bodies).

import { Suspense } from "react";
import Link from "next/link";
import { SelectAllCheckbox } from "@/components/SelectAllCheckbox";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { FlashToast } from "@/components/FlashToast";
import { FormSelect } from "@/components/FormSelect";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { MatchActionsPanel } from "@/components/MatchActionsPanel";
import { CANONICAL_DECKS, CANONICAL_STAKES } from "@/lib/balatro-info";
import { resultLabelByName } from "@/lib/result-labels";
import { RarityText } from "@/components/RarityText";
import { loadAdminMatchesPage, type AdminMatchesMember, type AdminMatchesPageData } from "@/lib/loaders/admin-matches";
import {
  filterMatchRows,
  groupMatchRows,
  parseOlderThanDays,
  parseStatusFilter,
  toUnresolvedRow,
  type MatchPageFilters,
  type MatchPageGroup,
  type MatchPageRow,
  type MatchPageStatus,
  type StatusFilter,
} from "@/lib/matches-page-core";
import { planBulkAction, type BulkAction } from "@/lib/bulk-resolve-core";
import {
  overrideResultAction,
  showdownAction,
  undoAction,
  applyBulkResolveAction,
  acceptDisputeProposal,
  rejectDispute,
  setDisputeResult,
} from "./actions";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

const PAGE = "/admin/matches";
const BULK_FORM_ID = "admin-matches-bulk-form";

const OK_MSG: Record<string, string> = {
  recorded: "Result recorded.",
  overridden: "Result overridden.",
  forfeit: "Forfeit / DQ recorded.",
  showdown: "Shootout recorded.",
  undone: "Match removed.",
  accepted: "Proposed correction accepted. Standings updated.",
  rejected: "Dispute rejected, original result kept.",
  custom: "Corrected result set.",
};

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "All",
  pending: "Pending",
  disputed: "Disputed",
  unplayed: "Unplayed",
  recorded: "Recorded",
};

const GROUP_LABEL: Record<MatchPageStatus, string> = {
  DISPUTED: "Disputed",
  PENDING: "Pending",
  UNPLAYED_SCHEDULED: "Unplayed",
  RECORDED: "Recorded",
};

const SUGGESTION_TONE: Record<string, string> = {
  void: "var(--danger)",
  "forfeit-a": "var(--accent)",
  "forfeit-b": "var(--accent)",
  "needs-human": "var(--info)",
  leave: "var(--muted)",
};

const ACTION_LABEL: Record<BulkAction, string> = {
  void: "Void",
  "forfeit-a": "Forfeit for player A",
  "forfeit-b": "Forfeit for player B",
  "double-forfeit": "Double forfeit",
};

const RESULT_OPTIONS = (aName: string, bName: string) => [
  { value: "2-0", label: resultLabelByName("2-0", aName, bName) },
  { value: "1-1", label: resultLabelByName("1-1", aName, bName) },
  { value: "0-2", label: resultLabelByName("0-2", aName, bName) },
];

interface SP {
  season?: string;
  division?: string;
  status?: string;
  olderThan?: string;
  dropped?: string;
  ok?: string;
  err?: string;
  step?: string;
  ids?: string | string[];
  action?: string;
  reason?: string;
}

function isBulkAction(v: string | undefined): v is BulkAction {
  return v === "void" || v === "forfeit-a" || v === "forfeit-b" || v === "double-forfeit";
}

// Only the FILTER params -- never step/ids/action/reason/ok/err -- so a Back
// link, a row's returnTo, or the panel's returnTo lands on the same filtered
// list, not back into a half-finished confirmation.
function filterQuery(sp: SP): string {
  const q = new URLSearchParams();
  if (sp.season) q.set("season", sp.season);
  if (sp.division) q.set("division", sp.division);
  if (sp.status && sp.status !== "all") q.set("status", sp.status);
  if (sp.olderThan) q.set("olderThan", sp.olderThan);
  if (sp.dropped === "1") q.set("dropped", "1");
  const qs = q.toString();
  return qs ? `${PAGE}?${qs}` : PAGE;
}

function daysAgoLabel(days: number): string {
  return days <= 0 ? "today" : `${days}d ago`;
}

export default async function AdminMatchesPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdmin();
  const sp = await searchParams;
  const data = await loadAdminMatchesPage(sp.season);

  const filters: MatchPageFilters = {
    divisionId: sp.division || undefined,
    status: parseStatusFilter(sp.status),
    olderThanDays: parseOlderThanDays(sp.olderThan),
    droppedOnly: sp.dropped === "1",
  };
  const filteredRows = filterMatchRows(data.rows, filters);
  const groups = groupMatchRows(filteredRows);
  const isConfirmStep = sp.step === "confirm";
  const returnTo = filterQuery(sp);

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/matches" />
      <main>
        <h2>Matches</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Every match this season, in one place -- filter it down, expand a row to record / override / DQ / undo
          it by hand, or tick a batch and apply one bulk decision with one reason. Disputed rows show the
          disputer&apos;s proposal inline.
        </p>

        <Suspense fallback={null}>
          <FlashToast messages={OK_MSG} />
        </Suspense>

        {!data.hasSeason && <Callout type="info">No seasons yet -- create one on Season tools.</Callout>}

        {data.hasSeason && (
          <>
            <FilterBar sp={sp} data={data} filters={filters} />

            {filters.divisionId && (
              <ShootoutCard divisionId={filters.divisionId} members={data.membersByDivision.get(filters.divisionId) ?? []} returnTo={returnTo} />
            )}

            <p className="muted" style={{ fontSize: 12, margin: "8px 0" }}>
              <strong>{filteredRows.length}</strong> shown / <strong>{data.rows.length}</strong> match
              {data.rows.length === 1 ? "" : "es"} in {data.seasonLabel}
              {!data.seasonIsActive ? " (ended)" : ""}.
            </p>

            {isConfirmStep ? (
              <ConfirmStep sp={sp} data={data} backHref={returnTo} />
            ) : (
              <QueueView sp={sp} data={data} groups={groups} returnTo={returnTo} />
            )}
          </>
        )}
      </main>
    </>
  );
}

function FilterBar({ sp, data, filters }: { sp: SP; data: AdminMatchesPageData; filters: MatchPageFilters }) {
  const hasAnyFilter = Boolean(filters.divisionId || filters.olderThanDays != null || filters.droppedOnly) || filters.status !== "all";
  return (
    <form method="get" action={PAGE} className="card" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
      <div>
        <label className="muted" style={{ fontSize: 12, display: "block" }}>Season</label>
        <FormSelect
          name="season"
          defaultValue={data.seasonId ?? ""}
          triggerClassName="min-w-[200px]"
          options={data.seasons.map((s) => ({ value: s.id, label: s.isActive ? s.label : `${s.label}${s.ended ? " (ended)" : ""}` }))}
        />
      </div>
      <div>
        <label className="muted" style={{ fontSize: 12, display: "block" }}>Division</label>
        <FormSelect
          name="division"
          defaultValue={sp.division ?? ""}
          placeholder="All divisions"
          triggerClassName="min-w-[200px]"
          options={[{ value: "", label: "All divisions" }, ...data.divisions.map((d) => ({ value: d.id, label: `${d.tierName} - ${d.name}` }))]}
        />
      </div>
      <div>
        <label className="muted" style={{ fontSize: 12, display: "block" }}>Status</label>
        <FormSelect
          name="status"
          defaultValue={filters.status}
          triggerClassName="min-w-[160px]"
          options={(Object.entries(STATUS_FILTER_LABEL) as Array<[StatusFilter, string]>).map(([value, label]) => ({ value, label }))}
        />
      </div>
      <div>
        <label className="muted" style={{ fontSize: 12, display: "block" }}>Older than (days)</label>
        <Input type="number" name="olderThan" min={0} defaultValue={sp.olderThan ?? ""} style={{ width: 90 }} />
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
        <input type="checkbox" name="dropped" value="1" defaultChecked={sp.dropped === "1"} />
        Involves a dropped player
      </label>
      <Button type="submit" variant="secondary">Filter</Button>
      {hasAnyFilter && (
        <Link href={PAGE} className="secondary" style={{ fontSize: 12, alignSelf: "center" }}>
          Clear
        </Link>
      )}
    </form>
  );
}

function MemberSelect({ name, members, label }: { name: string; members: AdminMatchesMember[]; label: string }) {
  return (
    <FormSelect
      name={name}
      required
      triggerClassName="min-w-[140px]"
      placeholder={label}
      options={members.map((m) => ({ value: m.playerId, label: m.displayName }))}
    />
  );
}

function ShootoutCard({ divisionId, members, returnTo }: { divisionId: string; members: AdminMatchesMember[]; returnTo: string }) {
  return (
    <section className="card">
      <strong>Shootout</strong>
      <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        1-game tiebreaker for two players tied on a promotion/relegation spot, in the filtered division.
      </p>
      <form action={showdownAction} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <input type="hidden" name="divisionId" value={divisionId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <MemberSelect name="p1Id" members={members} label="p1..." />
        <span className="muted">vs</span>
        <MemberSelect name="p2Id" members={members} label="p2..." />
        <span className="muted" style={{ fontSize: 12 }}>winner</span>
        <MemberSelect name="winnerId" members={members} label="winner..." />
        <Button type="submit">Record shootout</Button>
      </form>
    </section>
  );
}

function QueueView({ sp, data, groups, returnTo }: { sp: SP; data: AdminMatchesPageData; groups: MatchPageGroup[]; returnTo: string }) {
  if (groups.length === 0) {
    return <Callout type="success">Nothing matches this filter.</Callout>;
  }
  return (
    <form id={BULK_FORM_ID} method="get" action={PAGE}>
      <input type="hidden" name="step" value="confirm" />
      {sp.season && <input type="hidden" name="season" value={sp.season} />}
      {sp.division && <input type="hidden" name="division" value={sp.division} />}
      {sp.status && sp.status !== "all" && <input type="hidden" name="status" value={sp.status} />}
      {sp.olderThan && <input type="hidden" name="olderThan" value={sp.olderThan} />}
      {sp.dropped === "1" && <input type="hidden" name="dropped" value="1" />}

      <div className="card" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <SelectAllCheckbox formId={BULK_FORM_ID} label="Select all shown" />
        <FormSelect
          name="action"
          placeholder="Choose an action..."
          triggerClassName="min-w-[200px]"
          options={(Object.entries(ACTION_LABEL) as Array<[BulkAction, string]>).map(([value, label]) => ({ value, label }))}
        />
        <Input name="reason" placeholder="Reason (required)" style={{ flex: "1 1 220px" }} />
        <SubmitButton variant="secondary">Preview</SubmitButton>
        <span className="muted" style={{ fontSize: 11 }}>
          Bulk void/forfeit only applies to open (Pending/Disputed/Unplayed) matches -- recorded rows are
          refused in the preview if ticked.
        </span>
      </div>

      {groups.map((group) => (
        <div key={group.status} style={{ marginBottom: 16 }}>
          <div className="muted" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            {GROUP_LABEL[group.status]} ({group.rows.length})
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {group.rows.map((row) => (
              <MatchRowCard key={row.matchId} row={row} data={data} returnTo={returnTo} />
            ))}
          </div>
        </div>
      ))}
    </form>
  );
}

function SuggestionPill({ action, reason }: { action: string; reason: string }) {
  const tone = SUGGESTION_TONE[action] ?? "var(--muted)";
  return (
    <span className="pill" style={{ background: `color-mix(in oklch, ${tone} 18%, transparent)`, color: tone, fontSize: 11 }} title={reason}>
      {reason}
    </span>
  );
}

function MatchRowCard({ row, data, returnTo }: { row: MatchPageRow; data: AdminMatchesPageData; returnTo: string }) {
  const members = data.membersByDivision.get(row.divisionId) ?? [];
  const isRecordedLeague = row.pageStatus === "RECORDED" && row.format === "LEAGUE_BO2";
  const isRecordedShootout = row.pageStatus === "RECORDED" && row.format !== "LEAGUE_BO2";
  const isUnplayed = row.pageStatus === "UNPLAYED_SCHEDULED";
  const summary = `${row.gamesWonA}-${row.gamesWonB}${row.forfeit ? " (DQ)" : ""}`;

  return (
    <div className="card" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      {row.pageStatus !== "RECORDED" || isRecordedLeague ? (
        <input type="checkbox" name="ids" value={row.matchId} form={BULK_FORM_ID} style={{ marginTop: 4 }} />
      ) : (
        <span style={{ width: 13 }} />
      )}

      <details style={{ flex: 1, minWidth: 0 }}>
        <summary style={{ cursor: "pointer", listStyle: "none" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <strong style={{ fontSize: 13 }}>
              {row.playerA.displayName}
              {row.playerA.memberStatus === "DROPPED" && <span style={{ color: "var(--danger)", fontSize: 11 }}> (dropped)</span>}
              {" vs "}
              {row.playerB.displayName}
              {row.playerB.memberStatus === "DROPPED" && <span style={{ color: "var(--danger)", fontSize: 11 }}> (dropped)</span>}
            </strong>
            <span className="muted" style={{ fontSize: 12 }}>
              <RarityText position={row.tierPosition}>{row.tierName} - {row.divisionName}</RarityText>
            </span>
            {row.pageStatus === "RECORDED" && <strong style={{ fontSize: 13 }}>{summary}</strong>}
            <span className="muted" style={{ fontSize: 11 }}>{daysAgoLabel(row.daysSinceTouch)}</span>
            {row.pageStatus !== "RECORDED" && <SuggestionPill action={row.suggestion.action} reason={row.suggestion.reason} />}
          </div>
        </summary>

        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {isRecordedLeague && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <form action={overrideResultAction} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input type="hidden" name="matchId" value={row.matchId} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <FormSelect
                  name="result"
                  defaultValue={`${row.gamesWonA}-${row.gamesWonB}`}
                  size="sm"
                  options={RESULT_OPTIONS(row.playerA.displayName, row.playerB.displayName)}
                />
                <Button type="submit" variant="secondary" size="sm">Set</Button>
              </form>
              <form action={undoAction}>
                <input type="hidden" name="matchId" value={row.matchId} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <ConfirmButton
                  message={`Remove the ${row.playerA.displayName} vs ${row.playerB.displayName} result? Standings fall back to the next tiebreaker.`}
                  className="secondary"
                  style={{ fontSize: 11, color: "var(--danger)" }}
                >
                  Undo
                </ConfirmButton>
              </form>
            </div>
          )}

          {isRecordedShootout && (
            <form action={undoAction}>
              <input type="hidden" name="matchId" value={row.matchId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <ConfirmButton message="Undo this shootout?" className="secondary" style={{ fontSize: 11, color: "var(--danger)" }}>
                Undo
              </ConfirmButton>
            </form>
          )}

          {row.pageStatus === "DISPUTED" && <DisputeProposalBlock row={row} returnTo={returnTo} />}

          {row.pageStatus !== "RECORDED" && (
            <MatchActionsPanel
              divisionId={row.divisionId}
              returnTo={returnTo}
              decks={CANONICAL_DECKS.map((d) => d.name)}
              stakes={CANONICAL_STAKES.map((s) => s.name)}
              members={members}
              unplayed={isUnplayed ? [{ p1Id: row.playerA.playerId, p2Id: row.playerB.playerId }] : []}
              played={
                isUnplayed
                  ? []
                  : [{ p1Id: row.playerA.playerId, p2Id: row.playerB.playerId, summary: `${row.gamesWonA}-${row.gamesWonB}` }]
              }
              showFix={!isUnplayed}
            />
          )}
        </div>
      </details>
    </div>
  );
}

// Disputed row's current result vs the disputer's proposed correction, side
// by side, with the Disputes page's one-click actions -- shown inline
// (always visible, not behind the expand) per the merged page's spec.
function DisputeProposalBlock({ row, returnTo }: { row: MatchPageRow; returnTo: string }) {
  const d = row.dispute;
  if (!d) return null;
  const hasProposal = d.proposedGamesWonA != null && d.proposedGamesWonB != null;
  return (
    <div className="card" style={{ background: "var(--surface-2)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 8 }}>
        <div>
          <div className="muted" style={{ fontSize: 11 }}>Recorded</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {row.playerA.displayName} <strong>{row.gamesWonA}-{row.gamesWonB}</strong> {row.playerB.displayName}
          </div>
          {d.reporter && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Reported by {d.reporter.displayName}</div>}
        </div>
        <div style={{ padding: 8, background: hasProposal ? "rgba(46,204,113,0.08)" : undefined, borderRadius: 4, borderLeft: hasProposal ? "3px solid #2ecc71" : undefined }}>
          <div className="muted" style={{ fontSize: 11 }}>Disputer says it should be</div>
          {hasProposal ? (
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {row.playerA.displayName} <strong>{d.proposedGamesWonA}-{d.proposedGamesWonB}</strong> {row.playerB.displayName}
            </div>
          ) : (
            <div className="muted">-- no specific proposal --</div>
          )}
        </div>
      </div>
      {d.reason && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          <strong>Reason:</strong> {d.reason} {d.disputer && <>-- {d.disputer.displayName}</>}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {hasProposal && (
          <form action={acceptDisputeProposal}>
            <input type="hidden" name="pairingId" value={row.matchId} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <ConfirmButton message="Accept the disputed result and update standings?" style={{ background: "var(--success)", color: "#fff" }}>
              Accept proposed
            </ConfirmButton>
          </form>
        )}
        <form action={rejectDispute}>
          <input type="hidden" name="pairingId" value={row.matchId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <ConfirmButton message="Keep the original result and dismiss the dispute?" variant="secondary">
            Keep original
          </ConfirmButton>
        </form>
        <form action={setDisputeResult} style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          <input type="hidden" name="pairingId" value={row.matchId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <FormSelect
            name="result"
            required
            placeholder="set other result..."
            options={RESULT_OPTIONS(row.playerA.displayName, row.playerB.displayName)}
          />
          <ConfirmButton message="Apply this result and update standings?" variant="secondary">Apply</ConfirmButton>
        </form>
      </div>
    </div>
  );
}

function ConfirmStep({ sp, data, backHref }: { sp: SP; data: AdminMatchesPageData; backHref: string }) {
  const rawIds = sp.ids;
  const idList = Array.isArray(rawIds) ? rawIds : (rawIds ?? "").split(",");
  const selectedIds = [...new Set(idList.flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean))];
  const action = sp.action ?? "";
  const reason = (sp.reason ?? "").trim();

  if (selectedIds.length === 0) {
    return (
      <Callout type="danger">
        Nothing selected. <Link href={backHref}>Back to the list</Link>
      </Callout>
    );
  }
  if (!isBulkAction(action)) {
    return (
      <Callout type="danger">
        Pick an action before previewing. <Link href={backHref}>Back to the list</Link>
      </Callout>
    );
  }
  if (!reason) {
    return (
      <Callout type="danger">
        A reason is required. <Link href={backHref}>Back to the list</Link>
      </Callout>
    );
  }

  const decisions = planBulkAction(data.rows.map(toUnresolvedRow), selectedIds, action);
  const allowed = decisions.filter((d) => d.allowed);
  const refused = decisions.filter((d) => !d.allowed);
  const byId = new Map(data.rows.map((r) => [r.matchId, r]));
  const label = (id: string): ReactNode => {
    const row = byId.get(id);
    if (!row) return id;
    return (
      <>
        <RarityText position={row.tierPosition}>{row.tierName} - {row.divisionName}</RarityText>: {row.playerA.displayName} vs {row.playerB.displayName}
      </>
    );
  };

  return (
    <div className="card">
      <strong>Preview: {ACTION_LABEL[action]}</strong>
      <p className="muted" style={{ fontSize: 13 }}>Reason: &quot;{reason}&quot;</p>
      <p>
        <strong>{allowed.length}</strong> match{allowed.length === 1 ? "" : "es"} will be acted on
        {refused.length > 0 && (
          <>
            , <strong>{refused.length}</strong> refused
          </>
        )}
        .
      </p>

      {allowed.length > 0 && (
        <ul style={{ fontSize: 12, margin: "6px 0" }}>
          {allowed.map((d) => (
            <li key={d.id}>{label(d.id)}</li>
          ))}
        </ul>
      )}

      {refused.length > 0 && (
        <>
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Refused:</p>
          <ul style={{ fontSize: 12, margin: "6px 0", color: "var(--danger)" }}>
            {refused.map((d) => (
              <li key={d.id}>{label(d.id)} -- {d.reason}</li>
            ))}
          </ul>
        </>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
        <Link href={backHref} className="secondary">Back</Link>
        {allowed.length > 0 && (
          <form action={applyBulkResolveAction}>
            <input type="hidden" name="returnTo" value={backHref} />
            <input type="hidden" name="action" value={action} />
            <input type="hidden" name="reason" value={reason} />
            {selectedIds.map((id) => (
              <input key={id} type="hidden" name="ids" value={id} />
            ))}
            <SubmitButton>Apply to {allowed.length} match{allowed.length === 1 ? "" : "es"}</SubmitButton>
          </form>
        )}
      </div>
    </div>
  );
}

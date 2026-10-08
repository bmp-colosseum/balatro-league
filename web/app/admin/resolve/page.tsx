// Admin bulk-resolve queue: every PENDING/DISPUTED league match still open
// this season, across every division, with a suggested call per match from
// the pure core (lib/bulk-resolve-core.ts) -- filter it down, tick the ones
// you want, pick one action + one reason, preview exactly what will happen,
// then apply. Replaces the old "pick a division, resolve one at a time"
// /admin/resolve with a real queue; the single-match record/override/DQ/
// showdown/undo toolkit on /admin/results (and each division page) is still
// the way to fix one match by hand, and every row links there.

import Link from "next/link";
import { SelectAllCheckbox } from "@/components/SelectAllCheckbox";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { FormSelect } from "@/components/FormSelect";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/SubmitButton";
import {
  loadBulkResolveQueue,
  type BulkResolveData,
  type BulkResolveFilters,
  type BulkResolveQueueRow,
  type RowStatusFilter,
} from "@/lib/loaders/admin-resolve";
import { planBulkAction, type BulkAction, type PlayerStanding, type RowStatus, type Suggestion, type SuggestedActionKind } from "@/lib/bulk-resolve-core";
import { applyBulkResolveAction } from "./actions";

export const dynamic = "force-dynamic";

const PAGE = "/admin/resolve";
const BULK_FORM_ID = "bulk-resolve-form";

const STATUS_LABEL: Record<RowStatusFilter, string> = {
  all: "Any status",
  pending: "Pending (reported, awaiting confirm)",
  disputed: "Disputed",
  "unplayed-scheduled": "Unplayed (nothing reported)",
};

const STATUS_SHORT: Record<RowStatus, string> = {
  PENDING: "pending",
  DISPUTED: "disputed",
  UNPLAYED_SCHEDULED: "unplayed",
  OTHER: "resolved",
};

const SUGGESTION_LABEL: Record<SuggestedActionKind | "all", string> = {
  all: "Any suggestion",
  void: "Void",
  "forfeit-a": "Forfeit (player A)",
  "forfeit-b": "Forfeit (player B)",
  "needs-human": "Needs a human",
  leave: "Leave",
};

const SUGGESTION_TONE: Record<SuggestedActionKind, string> = {
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

interface SP {
  division?: string;
  status?: string;
  suggested?: string;
  olderThan?: string;
  dropped?: string;
  ok?: string;
  err?: string;
  step?: string;
  ids?: string;
  action?: string;
  reason?: string;
}

function isRowStatusFilter(v: string | undefined): v is RowStatusFilter {
  return v === "all" || v === "pending" || v === "disputed" || v === "unplayed-scheduled";
}

function isSuggestedFilter(v: string | undefined): v is SuggestedActionKind | "all" {
  return v === "all" || v === "void" || v === "forfeit-a" || v === "forfeit-b" || v === "needs-human" || v === "leave";
}

function isBulkAction(v: string | undefined): v is BulkAction {
  return v === "void" || v === "forfeit-a" || v === "forfeit-b" || v === "double-forfeit";
}

// Only the FILTER params -- never step/ids/action/reason/ok/err -- so a Back
// link or a hidden returnTo field lands on the same filtered list, not back
// into a half-finished confirmation.
function filterQuery(sp: SP): string {
  const q = new URLSearchParams();
  if (sp.division) q.set("division", sp.division);
  if (sp.status && sp.status !== "all") q.set("status", sp.status);
  if (sp.suggested && sp.suggested !== "all") q.set("suggested", sp.suggested);
  if (sp.olderThan) q.set("olderThan", sp.olderThan);
  if (sp.dropped === "1") q.set("dropped", "1");
  const qs = q.toString();
  return qs ? `${PAGE}?${qs}` : PAGE;
}

function daysAgoLabel(days: number): string {
  return days <= 0 ? "today" : `${days}d ago`;
}

function StandingCell({ player }: { player: PlayerStanding }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <strong style={{ fontSize: 13 }}>{player.displayName}</strong>
      <span className="muted" style={{ fontSize: 11 }}>
        {player.memberStatus === "DROPPED" ? (
          <span style={{ color: "var(--danger)" }}>dropped</span>
        ) : player.memberStatus === "UNKNOWN" ? (
          "not in division"
        ) : (
          "active"
        )}
        {player.checkinIssue ? ` - ${player.checkinIssue}` : ""}
      </span>
    </div>
  );
}

function SuggestionPill({ suggestion }: { suggestion: Suggestion }) {
  const token = SUGGESTION_TONE[suggestion.action];
  return (
    <span
      className="pill"
      style={{ background: `color-mix(in oklch, ${token} 18%, transparent)`, color: token, fontSize: 11 }}
      title={suggestion.reason}
    >
      {suggestion.reason}
    </span>
  );
}

export default async function BulkResolvePage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdmin();
  const sp = await searchParams;

  const filters: BulkResolveFilters = {
    divisionId: sp.division || undefined,
    status: isRowStatusFilter(sp.status) ? sp.status : "all",
    suggested: isSuggestedFilter(sp.suggested) ? sp.suggested : "all",
    olderThanDays: sp.olderThan && Number.isFinite(Number(sp.olderThan)) ? Number(sp.olderThan) : undefined,
    droppedOnly: sp.dropped === "1",
  };
  const data = await loadBulkResolveQueue(filters);
  const isConfirmStep = sp.step === "confirm";

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/resolve" />
      <main>
        <h2>Resolve queue</h2>
        <p className="muted">
          Every PENDING or DISPUTED league match still open this season, with a suggested call per match --
          filter it down, tick the ones you want, and apply one decision with one reason. For the full
          record / override / DQ / showdown / undo toolkit on a single match, use{" "}
          <Link href="/admin/results">Results</Link> or jump to the division from a row below.
        </p>

        {sp.err && <Callout type="danger">{sp.err}</Callout>}
        {sp.ok && <Callout type="success">{sp.ok}</Callout>}

        {!data.hasActiveSeason && <Callout type="info">No active season right now.</Callout>}

        {data.hasActiveSeason && isConfirmStep && <ConfirmStep sp={sp} data={data} />}
        {data.hasActiveSeason && !isConfirmStep && <QueueStep sp={sp} filters={filters} data={data} />}
      </main>
    </>
  );
}

function QueueStep({ sp, filters, data }: { sp: SP; filters: BulkResolveFilters; data: BulkResolveData }) {
  const hasAnyFilter = Boolean(filters.divisionId || filters.olderThanDays != null || filters.droppedOnly) || filters.status !== "all" || filters.suggested !== "all";

  return (
    <>
      <form method="get" action={PAGE} className="card" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <label className="muted" style={{ fontSize: 12, display: "block" }}>
            Division
          </label>
          <FormSelect
            name="division"
            defaultValue={sp.division ?? ""}
            placeholder="All divisions"
            triggerClassName="min-w-[200px]"
            options={[
              { value: "", label: "All divisions" },
              ...data.divisions.map((d) => ({ value: d.id, label: `${d.tierName} - ${d.name}` })),
            ]}
          />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 12, display: "block" }}>
            Status
          </label>
          <FormSelect
            name="status"
            defaultValue={filters.status ?? "all"}
            triggerClassName="min-w-[220px]"
            options={(Object.entries(STATUS_LABEL) as Array<[RowStatusFilter, string]>).map(([value, label]) => ({ value, label }))}
          />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 12, display: "block" }}>
            Suggested action
          </label>
          <FormSelect
            name="suggested"
            defaultValue={filters.suggested ?? "all"}
            triggerClassName="min-w-[200px]"
            options={(Object.entries(SUGGESTION_LABEL) as Array<[SuggestedActionKind | "all", string]>).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 12, display: "block" }}>
            Older than (days)
          </label>
          <Input type="number" name="olderThan" min={0} defaultValue={sp.olderThan ?? ""} style={{ width: 90 }} />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          <input type="checkbox" name="dropped" value="1" defaultChecked={sp.dropped === "1"} />
          Involves a dropped player
        </label>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        {hasAnyFilter && (
          <Link href={PAGE} className="secondary" style={{ fontSize: 12, alignSelf: "center" }}>
            Clear
          </Link>
        )}
      </form>

      <p className="muted" style={{ fontSize: 12, margin: "8px 0" }}>
        <strong>{data.rows.length}</strong> shown / <strong>{data.totalUnfiltered}</strong> open match
        {data.totalUnfiltered === 1 ? "" : "es"} this season.
      </p>

      {data.rows.length === 0 ? (
        <Callout type={data.totalUnfiltered === 0 ? "success" : "info"}>
          {data.totalUnfiltered === 0 ? "Nothing left to resolve this season." : "Nothing matches this filter."}
        </Callout>
      ) : (
        <>
          <form id={BULK_FORM_ID} method="get" action={PAGE}>
            <input type="hidden" name="step" value="confirm" />
            {sp.division && <input type="hidden" name="division" value={sp.division} />}
            {filters.status !== "all" && <input type="hidden" name="status" value={filters.status} />}
            {filters.suggested !== "all" && <input type="hidden" name="suggested" value={filters.suggested} />}
            {sp.olderThan && <input type="hidden" name="olderThan" value={sp.olderThan} />}
            {sp.dropped === "1" && <input type="hidden" name="dropped" value="1" />}

            <div className="card" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              <SelectAllCheckbox formId={BULK_FORM_ID} label={`Select all (${data.rows.length})`} />
              <FormSelect
                name="action"
                placeholder="Choose an action..."
                triggerClassName="min-w-[200px]"
                options={(Object.entries(ACTION_LABEL) as Array<[BulkAction, string]>).map(([value, label]) => ({ value, label }))}
              />
              <Input name="reason" placeholder="Reason (required)" style={{ flex: "1 1 220px" }} />
              <SubmitButton variant="secondary">Preview</SubmitButton>
            </div>

            <div className="table-scroll">
              <table className="table-dense">
                <thead>
                  <tr>
                    <th></th>
                    <th>Division</th>
                    <th>Player A</th>
                    <th>Player B</th>
                    <th>Status</th>
                    <th>Age</th>
                    <th>Suggestion</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <QueueRow key={row.matchId} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          </form>
        </>
      )}
    </>
  );
}

function QueueRow({ row }: { row: BulkResolveQueueRow }) {
  return (
    <tr>
      <td>
        <input type="checkbox" name="ids" value={row.matchId} />
      </td>
      <td style={{ fontSize: 12 }}>
        {row.tierName} - {row.divisionName}
      </td>
      <td>
        <StandingCell player={row.playerA} />
      </td>
      <td>
        <StandingCell player={row.playerB} />
      </td>
      <td className="muted" style={{ fontSize: 11 }}>
        {STATUS_SHORT[row.status]}
      </td>
      <td style={{ fontSize: 12 }}>{daysAgoLabel(row.daysSinceTouch)}</td>
      <td>
        <SuggestionPill suggestion={row.suggestion} />
      </td>
      <td>
        <Link href={`/admin/results?division=${row.divisionId}`} className="secondary" style={{ fontSize: 11 }}>
          fix individually
        </Link>
      </td>
    </tr>
  );
}

function ConfirmStep({ sp, data }: { sp: SP; data: BulkResolveData }) {
  const backHref = filterQuery(sp);
  const selectedIds = [...new Set((sp.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  const action = sp.action ?? "";
  const reason = (sp.reason ?? "").trim();

  if (selectedIds.length === 0) {
    return (
      <Callout type="danger">
        Nothing selected. <Link href={backHref}>Back to the queue</Link>
      </Callout>
    );
  }
  if (!isBulkAction(action)) {
    return (
      <Callout type="danger">
        Pick an action before previewing. <Link href={backHref}>Back to the queue</Link>
      </Callout>
    );
  }
  if (!reason) {
    return (
      <Callout type="danger">
        A reason is required. <Link href={backHref}>Back to the queue</Link>
      </Callout>
    );
  }

  const decisions = planBulkAction(data.rows, selectedIds, action);
  const allowed = decisions.filter((d) => d.allowed);
  const refused = decisions.filter((d) => !d.allowed);
  const byId = new Map(data.rows.map((r) => [r.matchId, r]));
  const label = (id: string) => {
    const row = byId.get(id);
    return row ? `${row.tierName} - ${row.divisionName}: ${row.playerA.displayName} vs ${row.playerB.displayName}` : id;
  };

  return (
    <div className="card">
      <strong>Preview: {ACTION_LABEL[action]}</strong>
      <p className="muted" style={{ fontSize: 13 }}>
        Reason: &quot;{reason}&quot;
      </p>
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
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            Refused:
          </p>
          <ul style={{ fontSize: 12, margin: "6px 0", color: "var(--danger)" }}>
            {refused.map((d) => (
              <li key={d.id}>
                {label(d.id)} -- {d.reason}
              </li>
            ))}
          </ul>
        </>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
        <Link href={backHref} className="secondary">
          Back
        </Link>
        {allowed.length > 0 && (
          <form action={applyBulkResolveAction}>
            <input type="hidden" name="returnTo" value={backHref} />
            <input type="hidden" name="action" value={action} />
            <input type="hidden" name="reason" value={reason} />
            {selectedIds.map((id) => (
              <input key={id} type="hidden" name="ids" value={id} />
            ))}
            <SubmitButton>
              Apply to {allowed.length} match{allowed.length === 1 ? "" : "es"}
            </SubmitButton>
          </form>
        )}
      </div>
    </div>
  );
}

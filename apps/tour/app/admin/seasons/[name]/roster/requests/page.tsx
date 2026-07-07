import Link from "next/link";
import { ArrowLeft, Check, X, Inbox } from "lucide-react";
import { getViewer, isAdmin } from "@/lib/auth";
import { capabilitiesFor, seasonIdByName } from "@/lib/permissions";
import { listPendingRequests } from "@/lib/services/roster-requests";
import { NoAccess } from "@/components/NoAccess";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { SelectAllCheckbox } from "@/components/SelectAllCheckbox";
import { LiveRefresh } from "@/components/LiveRefresh";
import { approveRequestAction, rejectRequestAction, approveRequestsBulkAction } from "../actions";

export const dynamic = "force-dynamic";

const inputCls = "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5";

export default async function RosterRequestsInbox({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);

  // Mod-only: TO or a ROSTERS grant. Captains submit + withdraw on their team page; they
  // don't review the queue.
  const to = await isAdmin();
  const seasonId = to ? null : await seasonIdByName(seasonName);
  const viewer = to ? null : await getViewer();
  const isMod = to || !!(viewer && (await capabilitiesFor(viewer, seasonId)).has("ROSTERS"));
  if (!isMod) return <NoAccess what="review roster requests" />;

  const sid = await seasonIdByName(seasonName);
  const pending = await listPendingRequests(seasonName);

  return (
    <main>
      {sid && <LiveRefresh channel={`roster-requests:${sid}`} />}
      <p>
        <Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
      </p>
      <h1 className="inline-flex items-center gap-2"><Inbox className="size-5" /> Roster requests</h1>
      <p className="sub">
        Captain-submitted roster changes waiting on a mod. <strong>Approve</strong> runs the change (it lands on the
        team&apos;s move timeline); <strong>Reject</strong> discards it. Captains can withdraw their own from the team page.
      </p>

      {pending.length === 0 ? (
        <Callout type="success">No pending requests -- all caught up.</Callout>
      ) : (
        <>
          {/* Bulk bar: the row checkboxes below join this form via form="bulk-approve-req". */}
          <ActionFlashForm id="bulk-approve-req" action={approveRequestsBulkAction} className="mb-2 flex items-center gap-2">
            <input type="hidden" name="season" value={seasonName} />
            <SubmitButton size="sm" variant="secondary" pendingText="...">Approve selected</SubmitButton>
            <span className="sub">tick the clean ones and approve them in one go</span>
          </ActionFlashForm>
          <div className="card">
            <table>
              <thead>
                <tr><th style={{ width: "1.5rem" }}><SelectAllCheckbox boxName="ids" formId="bulk-approve-req" /></th><th>Team</th><th>Change</th><th>Requested by</th><th></th></tr>
              </thead>
              <tbody>
                {pending.map((r) => {
                  const needsNote = r.kind === "QUIT" || r.kind === "BANNED" || r.kind === "CAPTAIN_CHANGE";
                  return (
                    <tr key={r.id}>
                      <td><input type="checkbox" name="ids" value={r.id} form="bulk-approve-req" aria-label={`Select ${r.teamName} ${r.kindLabel}`} /></td>
                      <td><Link href={`/teams/${r.teamSeasonId}`}>{r.teamName}</Link></td>
                      <td>
                        <span className="badge">{r.kindLabel}</span> {r.summary}
                        {r.reason ? <span className="sub"> -- {r.reason}</span> : null}
                      </td>
                      <td className="sub">{r.requestedName ?? r.requestedBy}</td>
                      <td style={{ textAlign: "right" }}>
                        <div className="inline-flex flex-wrap items-center justify-end gap-1">
                          <ActionFlashForm action={approveRequestAction}>
                            <input type="hidden" name="season" value={seasonName} />
                            <input type="hidden" name="id" value={r.id} />
                            <SubmitButton size="sm" pendingText="..."><Check className="size-3.5" /> Approve</SubmitButton>
                          </ActionFlashForm>
                          <ActionFlashForm action={rejectRequestAction}>
                            <input type="hidden" name="season" value={seasonName} />
                            <input type="hidden" name="id" value={r.id} />
                            <span className="inline-flex items-center gap-1">
                              <input name="note" placeholder={needsNote ? "note (required)" : "note (optional)"} className={inputCls} style={{ width: 130 }} />
                              <SubmitButton size="sm" variant="secondary" pendingText="..."><X className="size-3.5" /> Reject</SubmitButton>
                            </span>
                          </ActionFlashForm>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

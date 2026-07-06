import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { LocalDateTime } from "@/components/LocalDateTime";
import { SubmitButton } from "@/components/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import {
  loadDmInbox,
  loadDmDeliverySummary,
  type InboundDmRow,
  type DmBatchSummary,
  type FailedDeliveryRow,
} from "@/lib/loaders/dms";
import { replyToDm, markDmRead } from "./actions";

export const dynamic = "force-dynamic";

// unread = accent, read = muted, replied = success. Backgrounds are token-mixed
// (not hardcoded rgba) so the tint tracks the theme.
const STATUS_STYLE: Record<string, { token: string; label: string }> = {
  unread: { token: "--accent", label: "Unread" },
  read: { token: "--muted", label: "Read" },
  replied: { token: "--success", label: "Replied" },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { token: "--muted", label: status };
  return (
    <span
      className="pill"
      style={{
        background: `color-mix(in oklch, var(${s.token}) 18%, transparent)`,
        color: `var(${s.token})`,
      }}
    >
      {s.label}
    </span>
  );
}

function ProfileLink({ discordId }: { discordId: string }) {
  return (
    <a
      href={`https://balatromp.com/players/${discordId}`}
      target="_blank"
      rel="noreferrer"
      className="link-action"
      style={{ fontFamily: "monospace", fontSize: 11, color: "var(--muted)" }}
      title="Open balatromp profile"
    >
      {discordId}
    </a>
  );
}

function InboxRow({ row }: { row: InboundDmRow }) {
  const unread = row.status === "unread";
  return (
    <div className={"card" + (unread ? " card-accent" : "")}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>{row.displayName}</strong>
        {row.username && (
          <span className="muted" style={{ fontSize: 12 }}>
            @{row.username}
          </span>
        )}
        <ProfileLink discordId={row.authorDiscordId} />
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            <LocalDateTime iso={row.receivedAt.toISOString()} />
          </span>
          <StatusPill status={row.status} />
        </span>
      </div>

      {row.content && (
        <p style={{ margin: "8px 0 0", whiteSpace: "pre-wrap", fontSize: 14 }}>{row.content}</p>
      )}

      {row.attachments.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 10 }}>
          {row.attachments.map((a, i) => (
            <a
              key={i}
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="link-action"
              style={{ fontSize: 12, color: "var(--accent-2)" }}
            >
              {a.filename}
            </a>
          ))}
        </div>
      )}

      {row.status === "replied" && row.replyText && (
        <div
          className="card card-success"
          style={{ margin: "10px 0 0", padding: "8px 10px" }}
        >
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            Replied
            {row.repliedBy ? ` by ${row.repliedBy}` : ""}
            {row.repliedAt ? " on " : ""}
            {row.repliedAt && <LocalDateTime iso={row.repliedAt.toISOString()} />}
          </div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{row.replyText}</div>
        </div>
      )}

      <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <form action={replyToDm} style={{ flex: "1 1 320px", display: "grid", gap: 6 }}>
          <input type="hidden" name="id" value={row.id} />
          <Textarea
            name="reply"
            rows={2}
            placeholder={row.status === "replied" ? "Send another reply..." : "Reply as the league..."}
          />
          <div>
            <SubmitButton>Send reply</SubmitButton>
          </div>
        </form>
        {unread && (
          <form action={markDmRead}>
            <input type="hidden" name="id" value={row.id} />
            <SubmitButton variant="secondary">Mark read</SubmitButton>
          </form>
        )}
      </div>
    </div>
  );
}

function BatchTable({ batches }: { batches: DmBatchSummary[] }) {
  if (batches.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>
        No outbound DMs in the last 30 days.
      </p>
    );
  }
  return (
    <div className="table-scroll" style={{ marginTop: 8 }}>
      <table className="table-dense">
        <thead>
          <tr>
            <th>Kind</th>
            <th style={{ textAlign: "right" }}>Sent</th>
            <th style={{ textAlign: "right" }}>Failed</th>
            <th>Most recent</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={`${b.batchId ?? "-"}::${b.batchKind ?? "-"}`}>
              <td>
                {b.batchKind ?? "(unlabelled)"}
                {b.batchId && (
                  <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                    {b.batchId}
                  </span>
                )}
              </td>
              <td style={{ textAlign: "right" }}>{b.sentCount}</td>
              <td style={{ textAlign: "right", color: b.failedCount ? "var(--danger)" : undefined }}>
                {b.failedCount || "-"}
              </td>
              <td className="muted" style={{ fontSize: 12 }}>
                <LocalDateTime iso={b.mostRecentAt.toISOString()} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FailuresTable({ failures }: { failures: FailedDeliveryRow[] }) {
  if (failures.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>
        No failed sends recently.
      </p>
    );
  }
  return (
    <div className="table-scroll" style={{ marginTop: 8 }}>
      <table className="table-dense">
        <thead>
          <tr>
            <th>Recipient</th>
            <th>Why</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {failures.map((f) => (
            <tr key={f.id}>
              <td>
                {f.displayName}
                {f.username && (
                  <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                    @{f.username}
                  </span>
                )}
                <span className="muted" style={{ fontSize: 11, marginLeft: 6, fontFamily: "monospace" }}>
                  {f.discordId}
                </span>
              </td>
              <td style={{ color: "var(--danger)", fontSize: 12 }}>
                {f.errorCode === 50007
                  ? "DMs closed (50007)"
                  : [f.errorCode ? `code ${f.errorCode}` : null, f.errorMsg].filter(Boolean).join(" - ") || "failed"}
              </td>
              <td className="muted" style={{ fontSize: 12 }}>
                <LocalDateTime iso={f.sentAt.toISOString()} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function DmsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const { ok, err } = await searchParams;
  const [inbox, delivery] = await Promise.all([loadDmInbox(), loadDmDeliverySummary()]);

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/dms" />
      <main>
        <h2 style={{ margin: 0 }}>DM console</h2>
        <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
          Read and reply to DMs people sent the league bot, and check who could (and couldn&apos;t) be
          reached by outbound sends. Replies go out as a DM from the bot.
        </p>

        {err && <Callout type="danger">{err}</Callout>}
        {ok && <Callout type="success">{ok}</Callout>}

        {/* ---- Inbox ---- */}
        <div className="card">
          <strong>
            Inbox
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 13 }}>
              {inbox.counts.unread} unread / {inbox.counts.total} total
            </span>
          </strong>
        </div>

        {inbox.rows.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>No inbound DMs yet.</p>
        ) : (
          inbox.rows.map((row) => <InboxRow key={row.id} row={row} />)
        )}

        {/* ---- Delivery ---- */}
        <div className="card">
          <strong>Recent outbound batches</strong>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
            Grouped by kind over the last 30 days. Read-only.
          </p>
          <BatchTable batches={delivery.batches} />
        </div>

        <div className="card">
          <strong>Recent failed sends</strong>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
            Who couldn&apos;t be reached and why (error code 50007 = the recipient has DMs closed).
          </p>
          <FailuresTable failures={delivery.recentFailures} />
        </div>
      </main>
    </>
  );
}

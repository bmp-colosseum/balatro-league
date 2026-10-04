import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { LocalDateTime } from "@/components/LocalDateTime";
import { SubmitButton } from "@/components/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import {
  loadDmConversations,
  loadDmDeliverySummary,
  type ConversationView,
  type ConversationItem,
  type DmBatchSummary,
  type FailedDeliveryRow,
} from "@/lib/loaders/dms";
import { replyToDm, markDmRead } from "./actions";

// unread = accent, read = muted, replied = success. Backgrounds are token-mixed
// (not hardcoded rgba) so the tint tracks the theme.
const STATUS_STYLE: Record<string, { token: string; label: string }> = {
  unread: { token: "--accent", label: "Unread" },
  read: { token: "--muted", label: "Read" },
  replied: { token: "--success", label: "Replied" },
};

// Human label for a bot-originated DmDelivery.kind value. Unknown/legacy
// kinds (including null, pre-this-feature rows) fall back to a generic label
// rather than showing a raw code or blowing up.
const BOT_KIND_LABEL: Record<string, string> = {
  "signup-ask": "signup ask",
  "signup-reminder": "signup reminder",
  "schedule-change": "schedule change",
  "season-start": "season start",
  "roster-checkin": "roster check-in",
  shootout: "shootout",
  reply: "reply", // legacy batchKind-only rows from before `kind` existed
};

function botKindLabel(kind: string): string {
  return BOT_KIND_LABEL[kind] ?? kind.replace(/-/g, " ");
}

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

function PlayerBubble({ item }: { item: ConversationItem & { type: "player" } }) {
  return (
    <div className={"card" + (item.status === "unread" ? " card-accent" : "")} style={{ padding: "8px 10px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 11 }}>
          Player
        </span>
        <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
          <LocalDateTime iso={item.at.toISOString()} />
        </span>
        <StatusPill status={item.status} />
      </div>
      {item.content && <p style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", fontSize: 14 }}>{item.content}</p>}
      {item.attachments.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 10 }}>
          {item.attachments.map((a, i) => (
            <a
              key={i}
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="link-action"
              style={{ fontSize: 12, color: "var(--accent-2-text)" }}
            >
              {a.filename}
            </a>
          ))}
        </div>
      )}
      {item.status !== "replied" && (
        <form action={markDmRead} style={{ marginTop: 6 }}>
          <input type="hidden" name="id" value={item.id} />
          <SubmitButton variant="secondary" size="sm">
            Mark read
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

function StaffBubble({ item }: { item: ConversationItem & { type: "staff" } }) {
  const failed = item.status === "failed";
  return (
    <div className={"card " + (failed ? "card-danger" : "card-success")} style={{ padding: "8px 10px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12 }}>{item.staffName}</strong>
        <span className="muted" style={{ fontSize: 11 }}>
          staff reply
        </span>
        <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
          <LocalDateTime iso={item.at.toISOString()} />
        </span>
      </div>
      <p style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", fontSize: 14 }}>{item.content}</p>
      {failed && (
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--danger)" }}>
          Delivery failed{item.errorCode === 50007 ? " - DMs closed (50007)" : item.errorMsg ? ` - ${item.errorMsg}` : ""}
        </p>
      )}
    </div>
  );
}

function BotBubble({ item }: { item: ConversationItem & { type: "bot" } }) {
  const failed = item.status === "failed";
  return (
    <div className="card" style={{ padding: "8px 10px", opacity: 0.85 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 11 }}>
          Bot - {botKindLabel(item.kind)}
        </span>
        <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
          <LocalDateTime iso={item.at.toISOString()} />
        </span>
      </div>
      {item.content ? (
        <p style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", fontSize: 13 }} className="muted">
          {item.content}
        </p>
      ) : (
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12, fontStyle: "italic" }}>
          (content not recorded)
        </p>
      )}
      {failed && (
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--danger)" }}>
          Delivery failed{item.errorCode === 50007 ? " - DMs closed (50007)" : item.errorMsg ? ` - ${item.errorMsg}` : ""}
        </p>
      )}
    </div>
  );
}

function ThreadItemRow({ item }: { item: ConversationItem }) {
  if (item.type === "player") return <PlayerBubble item={item} />;
  if (item.type === "staff") return <StaffBubble item={item} />;
  return <BotBubble item={item} />;
}

function ConversationCard({ conv }: { conv: ConversationView }) {
  const hasUnread = conv.unreadCount > 0;
  return (
    <details className={"card" + (hasUnread ? " card-accent" : "")} open={hasUnread}>
      <summary style={{ cursor: "pointer", display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>{conv.displayName}</strong>
        {conv.username && (
          <span className="muted" style={{ fontSize: 12 }}>
            @{conv.username}
          </span>
        )}
        <ProfileLink discordId={conv.discordId} />
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            <LocalDateTime iso={conv.lastActivityAt.toISOString()} />
          </span>
          {hasUnread ? (
            <span
              className="pill"
              style={{ background: "color-mix(in oklch, var(--accent) 18%, transparent)", color: "var(--accent)" }}
            >
              {conv.unreadCount} unread
            </span>
          ) : (
            <StatusPill status="replied" />
          )}
        </span>
      </summary>

      <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
        {conv.items.map((item) => (
          <ThreadItemRow key={`${item.type}:${item.id}`} item={item} />
        ))}
      </div>

      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        {conv.latestUnansweredContent && (
          <div className="muted" style={{ fontSize: 12 }}>
            Replying to: <span style={{ fontStyle: "italic" }}>&quot;{conv.latestUnansweredContent.slice(0, 160)}&quot;</span>
          </div>
        )}
        <form action={replyToDm} style={{ display: "grid", gap: 6 }}>
          <input type="hidden" name="discordId" value={conv.discordId} />
          <Textarea
            name="reply"
            rows={2}
            placeholder={conv.latestUnansweredContent ? "Reply as the league..." : "Message as the league..."}
          />
          <div>
            <SubmitButton>{conv.latestUnansweredContent ? "Send reply" : "Send message"}</SubmitButton>
          </div>
        </form>
      </div>
    </details>
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
  const [conversations, delivery] = await Promise.all([loadDmConversations(), loadDmDeliverySummary()]);
  const totalUnread = conversations.reduce((n, c) => n + c.unreadCount, 0);

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/dms" />
      <main>
        <h2 style={{ margin: 0 }}>DM console</h2>
        <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
          Read and reply to DMs people sent the league bot, see what the bot already told them, and check who could
          (and couldn&apos;t) be reached by outbound sends. Replies go out as a DM from the bot, named as league
          staff and quoting what they&apos;re answering.
        </p>

        {err && <Callout type="danger">{err}</Callout>}
        {ok && <Callout type="success">{ok}</Callout>}

        {/* ---- Conversations ---- */}
        <div className="card">
          <strong>
            Conversations
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 13 }}>
              {totalUnread} unread / {conversations.length} total
            </span>
          </strong>
        </div>

        {conversations.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>No DM activity yet.</p>
        ) : (
          conversations.map((conv) => <ConversationCard key={conv.discordId} conv={conv} />)
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

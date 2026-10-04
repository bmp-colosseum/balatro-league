import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { LocalDateTime } from "@/components/LocalDateTime";
import { SubmitButton } from "@/components/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/host-metrics-parsers";
import {
  loadDmConversations,
  loadDmDeliverySummary,
  type ConversationView,
  type ConversationItem,
  type DmAttachment,
  type DmBatchSummary,
  type FailedDeliveryRow,
} from "@/lib/loaders/dms";
import {
  INBOX_VIEWS,
  computeInboxCounts,
  defaultView,
  selectInboxConversations,
  type InboxView,
} from "@/lib/dm-inbox-core";
import { replyToDm, markDmRead, markManyRead, archiveConversations, unarchiveConversations } from "./actions";

const BULK_FORM_ID = "dm-bulk-form";

const TAB_LABEL: Record<InboxView, string> = {
  "needs-reply": "Needs reply",
  open: "Open",
  archived: "Archived",
  "broadcast-only": "Broadcast only",
  all: "All",
};

function tabHref(view: InboxView, q: string): string {
  const sp = new URLSearchParams();
  sp.set("view", view);
  if (q) sp.set("q", q);
  return `/admin/dms?${sp.toString()}`;
}

function isInboxView(value: string | undefined): value is InboxView {
  return !!value && (INBOX_VIEWS as readonly string[]).includes(value);
}

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

function attachmentRouteUrl(storedId: string): string {
  return `/admin/dms/attachments/${storedId}`;
}

function AttachmentView({ a }: { a: DmAttachment }) {
  if (!a.stored) {
    // Pre-feature message, or storage hasn't finished yet -- all we have is
    // the original Discord CDN link, which may well have expired by now.
    return (
      <a href={a.url} target="_blank" rel="noreferrer" className="link-action" style={{ fontSize: 12, color: "var(--accent-2-text)" }}>
        {a.filename} <span className="muted">(Discord link, may have expired)</span>
      </a>
    );
  }
  if (a.error) {
    return (
      <span style={{ fontSize: 12, color: "var(--danger)" }}>
        {a.filename} - {a.error}
      </span>
    );
  }
  if (a.isImage) {
    return (
      <a href={attachmentRouteUrl(a.storedId!)} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element -- admin-only, arbitrary player-uploaded content; next/image's optimizer isn't worth it here */}
        <img
          src={attachmentRouteUrl(a.storedId!)}
          alt={a.filename}
          style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, display: "block" }}
        />
      </a>
    );
  }
  return (
    <a href={attachmentRouteUrl(a.storedId!)} className="link-action" style={{ fontSize: 12, color: "var(--accent-2-text)" }}>
      {a.filename} <span className="muted">({formatBytes(a.size ?? 0)})</span>
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
            <AttachmentView key={i} a={a} />
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

function ConversationCard({ conv, view, q }: { conv: ConversationView; view: InboxView; q: string }) {
  const hasUnread = conv.unreadCount > 0;
  const isArchived = conv.archivedAt !== null;
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
          ) : isArchived ? (
            <span className="pill muted">Archived</span>
          ) : (
            <StatusPill status="replied" />
          )}
        </span>
      </summary>

      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          <input type="checkbox" name="ids" value={conv.discordId} form={BULK_FORM_ID} />
          Select
        </label>
        <form action={markManyRead} style={{ display: "inline" }}>
          <input type="hidden" name="ids" value={conv.discordId} />
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="q" value={q} />
          <SubmitButton variant="secondary" size="sm">
            Mark all read
          </SubmitButton>
        </form>
        <form action={isArchived ? unarchiveConversations : archiveConversations} style={{ display: "inline" }}>
          <input type="hidden" name="ids" value={conv.discordId} />
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="q" value={q} />
          <SubmitButton variant="secondary" size="sm">
            {isArchived ? "Unarchive" : "Archive"}
          </SubmitButton>
        </form>
        {isArchived && (
          <span className="muted" style={{ fontSize: 11 }}>
            Archived{conv.archivedByName ? ` by ${conv.archivedByName}` : ""}
          </span>
        )}
      </div>

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
  searchParams: Promise<{ ok?: string; err?: string; view?: string; q?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const { ok, err } = sp;
  const q = sp.q ?? "";
  const [conversations, delivery] = await Promise.all([loadDmConversations(), loadDmDeliverySummary()]);
  const counts = computeInboxCounts(conversations);
  const view: InboxView = isInboxView(sp.view) ? sp.view : defaultView(counts);
  const visible = selectInboxConversations(conversations, view, q);

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

        {/* ---- Tabs ---- */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {INBOX_VIEWS.map((v) => (
            <Link
              key={v}
              href={tabHref(v, q)}
              className="pill"
              style={{
                textDecoration: "none",
                background:
                  v === view
                    ? "color-mix(in oklch, var(--accent) 22%, transparent)"
                    : "color-mix(in oklch, var(--muted) 12%, transparent)",
                color: v === view ? "var(--accent)" : "var(--muted)",
              }}
            >
              {TAB_LABEL[v]} ({v === "needs-reply" ? counts.needsReply : v === "open" ? counts.open : v === "archived" ? counts.archived : v === "broadcast-only" ? counts.broadcastOnly : counts.all})
            </Link>
          ))}
        </div>

        {/* ---- Search ---- */}
        <form method="get" action="/admin/dms" style={{ display: "flex", gap: 8, marginBottom: 10, maxWidth: 420 }}>
          <input type="hidden" name="view" value={view} />
          <Input name="q" type="text" placeholder="Search name, @handle, or discordId..." defaultValue={q} />
          <Button type="submit" variant="secondary">
            Search
          </Button>
          {q && (
            <Link href={tabHref(view, "")} className="secondary" style={{ alignSelf: "center", fontSize: 13 }}>
              Clear
            </Link>
          )}
        </form>

        {/* ---- Bulk toolbar ---- */}
        {/* Per-card checkboxes below aren't DOM descendants of this form -- they're
            associated to it via the HTML `form` attribute, since they live inside
            each card's own <details>/<form> markup and forms can't nest. */}
        <form id={BULK_FORM_ID} action={markManyRead} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="q" value={q} />
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <input type="checkbox" id="dm-select-all" />
            Select all
          </label>
          <SubmitButton formAction={markManyRead} variant="secondary" size="sm">
            Mark read
          </SubmitButton>
          <SubmitButton formAction={archiveConversations} variant="secondary" size="sm">
            Archive
          </SubmitButton>
          <SubmitButton formAction={unarchiveConversations} variant="secondary" size="sm">
            Unarchive
          </SubmitButton>
        </form>
        <script
          // Tiny progressive-enhancement toggle for "Select all" -- the only
          // script on the page, no client component needed for this one wire-up.
          // Keyed by view+q so a tab/search navigation remounts (not just
          // re-renders) this node -- otherwise the browser won't re-run it
          // against the freshly-rendered checkboxes.
          key={`dm-select-all-script-${view}-${q}`}
          dangerouslySetInnerHTML={{
            __html:
              "document.getElementById('dm-select-all').addEventListener('change', function (e) {" +
              "document.querySelectorAll('input[form=\"" + BULK_FORM_ID + "\"][name=\"ids\"]').forEach(function (cb) {" +
              "cb.checked = e.target.checked;" +
              "});" +
              "});",
          }}
        />

        {/* ---- Conversations ---- */}
        <div className="card">
          <strong>
            {TAB_LABEL[view]}
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 13 }}>
              {visible.length} shown / {counts.all} total conversations
            </span>
          </strong>
        </div>

        {conversations.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>No DM activity yet.</p>
        ) : visible.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>No conversations in this view.</p>
        ) : (
          visible.map((conv) => <ConversationCard key={conv.discordId} conv={conv} view={view} q={q} />)
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

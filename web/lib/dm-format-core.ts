// Pure core for the admin DM console (/admin/dms). Zero imports -- colocated
// test runs under the root vitest project (see vitest.config.ts's
// `include: ["web/lib/**/*.test.ts"]`).
//
// Three jobs:
//   1. formatStaffReply -- builds the exact text the player receives for a
//      staff reply (names the staff member, quotes what they're answering).
//   2. pickStaffDisplayName -- the staff-name resolution precedence, kept
//      pure so the DB/session lookups in the shell have nothing to decide.
//   3. buildDmThread -- merges InboundDm rows (what players sent) and
//      DmDelivery rows (what the bot/staff sent out) into one ordered,
//      per-player conversation list for the thread view.

// ---------------------------------------------------------------------------
// 1 + 2: staff reply formatting
// ---------------------------------------------------------------------------

export interface StaffReplyInput {
  staffName: string;
  // The player message this reply answers, or null if there's nothing to
  // quote (shouldn't normally happen, but the formatter must stay total).
  quoted: string | null;
  reply: string;
}

const QUOTE_MAX_CHARS = 200;

// Collapse newlines/whitespace to single spaces and cap length so the quote
// reads as a short preview, never a wall of text re-pasted back at the player.
export function truncateQuote(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= QUOTE_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, QUOTE_MAX_CHARS).trimEnd()}...`;
}

// Shape: a line naming the staff member as league staff, a one-line quote
// block of the message being answered, a blank line, then the reply itself.
export function formatStaffReply(input: StaffReplyInput): string {
  const lines: string[] = [`${input.staffName} (league staff) replied:`];
  const quoted = input.quoted?.trim();
  if (quoted) {
    lines.push(`> ${truncateQuote(quoted)}`);
  }
  lines.push("");
  lines.push(input.reply);
  return lines.join("\n");
}

export interface StaffMemberLite {
  nickname: string | null;
  globalName: string | null;
  username: string | null;
}

// Precedence: guild nickname > global display name > @handle > the session
// user's own name (e.g. from OAuth) > raw discordId as the last resort, so
// the player NEVER sees a bare id.
export function pickStaffDisplayName(
  member: StaffMemberLite | null,
  fallbackName: string | null | undefined,
  discordId: string,
): string {
  return member?.nickname || member?.globalName || member?.username || fallbackName || discordId;
}

// ---------------------------------------------------------------------------
// 3: thread merge
// ---------------------------------------------------------------------------

export type InboundDmStatus = "unread" | "read" | "replied";
export type DeliveryStatus = "sent" | "failed";

export interface InboundDmLite {
  id: string;
  authorDiscordId: string;
  content: string;
  receivedAt: Date;
  status: InboundDmStatus;
  // Replies made before DmDelivery carried content live only on the inbound row.
  // buildDmThread synthesises a staff item from them when no linked delivery exists.
  replyText?: string | null;
  repliedAt?: Date | null;
  repliedByName?: string | null;
}

export interface DmDeliveryLite {
  id: string;
  discordId: string;
  status: DeliveryStatus;
  sentAt: Date;
  content: string | null;
  kind: string | null;
  senderName: string | null;
  inReplyToInboundDmId: string | null;
  errorCode: number | null;
  errorMsg: string | null;
}

export type ThreadItem =
  | {
      type: "player";
      id: string;
      at: Date;
      content: string;
      status: InboundDmStatus;
    }
  | {
      type: "staff";
      id: string;
      at: Date;
      staffName: string;
      content: string;
      status: DeliveryStatus;
      inReplyToInboundDmId: string | null;
      errorCode: number | null;
      errorMsg: string | null;
    }
  | {
      type: "bot";
      id: string;
      at: Date;
      kind: string;
      content: string | null;
      status: DeliveryStatus;
      errorCode: number | null;
      errorMsg: string | null;
    };

export interface DmConversation {
  discordId: string;
  items: ThreadItem[];
  unreadCount: number;
  // The most recent player message that hasn't been answered yet (status
  // unread or read), or null if everything's been replied to. The reply form
  // quotes this and, on send, every id in `unreadIds` gets marked replied.
  latestUnanswered: InboundDmLite | null;
  unreadIds: string[];
  lastActivityAt: Date;
}

const STAFF_KIND = "staff-reply";

function isStaffDelivery(d: DmDeliveryLite): boolean {
  return d.kind === STAFF_KIND;
}

// Groups inbound + delivery rows by player discordId, sorts every
// conversation's items oldest-first (time order), and derives per-player
// unread bookkeeping. A player with only outbound rows (e.g. a season-start
// blast, never replied to the bot) still gets a conversation.
export function buildDmThread(
  inbound: readonly InboundDmLite[],
  deliveries: readonly DmDeliveryLite[],
): DmConversation[] {
  const discordIds = new Set<string>();
  for (const m of inbound) discordIds.add(m.authorDiscordId);
  for (const d of deliveries) discordIds.add(d.discordId);

  const inboundByPlayer = new Map<string, InboundDmLite[]>();
  for (const m of inbound) {
    const arr = inboundByPlayer.get(m.authorDiscordId) ?? [];
    arr.push(m);
    inboundByPlayer.set(m.authorDiscordId, arr);
  }
  const deliveriesByPlayer = new Map<string, DmDeliveryLite[]>();
  for (const d of deliveries) {
    const arr = deliveriesByPlayer.get(d.discordId) ?? [];
    arr.push(d);
    deliveriesByPlayer.set(d.discordId, arr);
  }

  const conversations: DmConversation[] = [];

  for (const discordId of discordIds) {
    const myInbound = inboundByPlayer.get(discordId) ?? [];
    const myDeliveries = deliveriesByPlayer.get(discordId) ?? [];

    const items: ThreadItem[] = [];
    for (const m of myInbound) {
      items.push({ type: "player", id: m.id, at: m.receivedAt, content: m.content, status: m.status });
    }
    for (const d of myDeliveries) {
      if (isStaffDelivery(d)) {
        items.push({
          type: "staff",
          id: d.id,
          at: d.sentAt,
          staffName: d.senderName ?? "league staff",
          content: d.content ?? "",
          status: d.status,
          inReplyToInboundDmId: d.inReplyToInboundDmId,
          errorCode: d.errorCode,
          errorMsg: d.errorMsg,
        });
      } else {
        items.push({
          type: "bot",
          id: d.id,
          at: d.sentAt,
          kind: d.kind ?? "other",
          content: d.content,
          status: d.status,
          errorCode: d.errorCode,
          errorMsg: d.errorMsg,
        });
      }
    }

    // Legacy replies: before DmDelivery stored content, a staff reply lived only on the
    // inbound row (replyText/repliedBy). Show those too, unless a real staff delivery is
    // already linked to that message -- then the delivery row is the record.
    const answeredByDelivery = new Set(
      myDeliveries.filter((d) => isStaffDelivery(d) && d.inReplyToInboundDmId).map((d) => d.inReplyToInboundDmId as string),
    );
    for (const m of myInbound) {
      const legacy = m.replyText?.trim();
      if (!legacy || answeredByDelivery.has(m.id)) continue;
      items.push({
        type: "staff",
        id: `legacy-reply-${m.id}`,
        at: m.repliedAt ?? m.receivedAt,
        staffName: m.repliedByName ?? "league staff",
        content: legacy,
        status: "sent",
        inReplyToInboundDmId: m.id,
        errorCode: null,
        errorMsg: null,
      });
    }

    // Stable time-order sort; ties keep insertion order (inbound before
    // deliveries at the exact same instant reads naturally -- the player's
    // message appears before a reply timestamped identically to it).
    items.sort((a, b) => a.at.getTime() - b.at.getTime());

    const unanswered = myInbound
      .filter((m) => m.status !== "replied")
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    const latestUnanswered = unanswered[0] ?? null;
    const unreadIds = unanswered.map((m) => m.id);

    const lastActivityAt = items.length > 0 ? items[items.length - 1]!.at : new Date(0);

    conversations.push({
      discordId,
      items,
      unreadCount: myInbound.filter((m) => m.status === "unread").length,
      latestUnanswered,
      unreadIds,
      lastActivityAt,
    });
  }

  conversations.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  return conversations;
}

// ---------------------------------------------------------------------------
// 4: DM attachment display (pairs InboundDm.attachmentsJson entries with any
// downloaded-and-stored DmAttachment rows for the admin console)
// ---------------------------------------------------------------------------

export interface DmAttachmentRef {
  filename: string;
  url: string;
}

export interface StoredDmAttachmentLite {
  id: string;
  filename: string;
  contentType: string | null;
  size: number;
  error: string | null;
}

export interface DmAttachmentView {
  filename: string;
  // Original Discord CDN url -- shown only as a fallback link when there's
  // no stored row (it may well be expired by then).
  url: string;
  stored: boolean;
  storedId: string | null;
  contentType: string | null;
  size: number | null;
  error: string | null;
  isImage: boolean;
}

// Pairs each attachmentsJson ref with its stored DmAttachment row BY
// POSITION: both lists are built in the same order (one DmAttachment row per
// original attachment, created in receipt order -- see
// src/inbound-dm.ts/src/dm-attachment-backfill.ts), so a positional zip
// reliably matches the common case. A ref with no corresponding stored row
// (index beyond `stored.length`) means never captured -- a pre-feature
// message, or storage that hasn't run/finished yet -- rendered as a plain
// (possibly-expired) Discord link.
export function buildAttachmentViews(
  refs: readonly DmAttachmentRef[],
  stored: readonly StoredDmAttachmentLite[],
): DmAttachmentView[] {
  return refs.map((ref, i) => {
    const row = stored[i];
    if (!row) {
      return {
        filename: ref.filename,
        url: ref.url,
        stored: false,
        storedId: null,
        contentType: null,
        size: null,
        error: null,
        isImage: false,
      };
    }
    return {
      filename: ref.filename,
      url: ref.url,
      stored: true,
      storedId: row.id,
      contentType: row.contentType,
      size: row.size,
      error: row.error,
      isImage: !row.error && !!row.contentType && row.contentType.startsWith("image/"),
    };
  });
}

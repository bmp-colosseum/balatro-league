// Pure core for the DM inbox views (/admin/dms): classifies each conversation
// into a tab bucket, filters/sorts the list for a selected tab + text query,
// and sums per-tab counts. Zero imports (type-only from dm-format-core) --
// colocated test runs under the root vitest project (vitest.config.ts's
// `include: ["web/lib/**/*.test.ts"]`).
//
// Two jobs:
//   1. classifyConversation -- decides which single bucket a conversation
//      belongs in (needs-reply | open | archived | broadcast-only), given its
//      thread items/unanswered state and its archive state row (if any).
//   2. selectInboxConversations / computeInboxCounts / defaultView -- the
//      tab + search-box view logic layered on top of that classification.

import type { DmConversation, InboundDmStatus } from "./dm-format-core";

export type ConversationCategory = "needs-reply" | "open" | "archived" | "broadcast-only";

// Shape the "Mark read" action's gather step needs per candidate message --
// just enough to decide, nothing DB-specific.
export interface UnansweredIdCandidate {
  id: string;
  authorDiscordId: string;
  status: InboundDmStatus;
}

// Pure decision behind every "Mark read" control (the bulk toolbar's
// multi-select, and each conversation card's own "Mark all read" button,
// which calls this with a single discordId): every inbound message
// belonging to one of the selected players that isn't already replied to.
// The shell gathers candidate messages (one DB read), calls this, then
// writes exactly those ids -- an impure-gather / pure-decide / impure-write
// sandwich instead of re-deriving the selection inside a DB WHERE clause.
export function selectUnansweredMessageIds(
  messages: readonly UnansweredIdCandidate[],
  discordIds: readonly string[],
): string[] {
  const wanted = new Set(discordIds);
  return messages.filter((m) => wanted.has(m.authorDiscordId) && m.status !== "replied").map((m) => m.id);
}

// The only field of DmConversationState the pure core needs. The shell
// passes null when there's no row for this discordId (never archived).
export interface ConversationStateLite {
  archivedAt: Date | null;
}

// The most recent player-sent message's timestamp, or null if this player
// never sent the bot a message (only ever received broadcasts). Archiving
// only ever looks at THIS timestamp -- a bot/staff send after an archive
// never un-archives a conversation; only the player writing again does.
export function latestPlayerMessageAt(conv: DmConversation): Date | null {
  let latest: Date | null = null;
  for (const item of conv.items) {
    if (item.type === "player" && (latest === null || item.at.getTime() > latest.getTime())) {
      latest = item.at;
    }
  }
  return latest;
}

// Decision tree, in order:
//   1. No player message ever -> broadcast-only (season-start/signup blasts
//      nobody replied to -- this check must come first so an archived-but-
//      never-replied-to broadcast still reads as broadcast-only, not archived).
//   2. A player message, and archivedAt is set with nothing newer -> archived.
//   3. Something of theirs is still UNREAD -> needs-reply. "Mark all read" is the
//      TO's way of clearing the inbox without replying, so a read-but-not-replied
//      message must drop the conversation to Open, not keep it in Needs reply.
//   4. Otherwise (everything read or replied) -> open.
export function classifyConversation(
  conv: DmConversation,
  state: ConversationStateLite | null,
): ConversationCategory {
  const latestPlayerAt = latestPlayerMessageAt(conv);
  if (latestPlayerAt === null) return "broadcast-only";

  const archivedAt = state?.archivedAt ?? null;
  if (archivedAt !== null && latestPlayerAt.getTime() <= archivedAt.getTime()) {
    return "archived";
  }

  if (conv.unreadCount > 0) return "needs-reply";

  return "open";
}

// ---------------------------------------------------------------------------
// Tabs: filter + sort + counts
// ---------------------------------------------------------------------------

export type InboxView = "needs-reply" | "open" | "archived" | "broadcast-only" | "all";

export const INBOX_VIEWS: readonly InboxView[] = ["needs-reply", "open", "archived", "broadcast-only", "all"];

// Minimal shape the view layer needs per conversation -- the shell maps its
// richer ConversationView (display name, items, etc.) down to (at least)
// this before calling selectInboxConversations, which returns the original
// objects (generic T) so callers don't lose fields.
export interface InboxConversationLite {
  discordId: string;
  displayName: string;
  username: string | null;
  lastActivityAt: Date;
  category: ConversationCategory;
}

export interface InboxCounts {
  needsReply: number;
  open: number;
  archived: number;
  broadcastOnly: number;
  all: number;
}

export function computeInboxCounts(convs: readonly InboxConversationLite[]): InboxCounts {
  const counts: InboxCounts = { needsReply: 0, open: 0, archived: 0, broadcastOnly: 0, all: convs.length };
  for (const c of convs) {
    if (c.category === "needs-reply") counts.needsReply++;
    else if (c.category === "open") counts.open++;
    else if (c.category === "archived") counts.archived++;
    else counts.broadcastOnly++;
  }
  return counts;
}

// Needs reply when non-empty, else Open -- the two tabs a staff member
// actually has to act on, in priority order.
export function defaultView(counts: InboxCounts): InboxView {
  return counts.needsReply > 0 ? "needs-reply" : "open";
}

function matchesQuery(conv: InboxConversationLite, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    conv.displayName.toLowerCase().includes(needle) ||
    (conv.username?.toLowerCase().includes(needle) ?? false) ||
    conv.discordId.toLowerCase().includes(needle)
  );
}

// Filters the list down to one tab (view="all" keeps everything, including
// broadcast-only -- the "All count still includes them" rule) and a free-text
// query (display name / username / discordId, case-insensitive substring),
// then sorts by lastActivityAt desc. Generic so the shell can pass its full
// ConversationView objects through and get them back, not just the lite shape.
export function selectInboxConversations<T extends InboxConversationLite>(
  convs: readonly T[],
  view: InboxView,
  query: string,
): T[] {
  const byView = view === "all" ? convs : convs.filter((c) => c.category === view);
  const filtered = byView.filter((c) => matchesQuery(c, query));
  return [...filtered].sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
}

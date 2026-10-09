// Pure core for the merged /admin/messages page (Inbox / Sent / Failed /
// Transcripts). Zero imports -- no Prisma, no Date.now(), no React. The
// existing dm-inbox-core.ts (needs-reply / open / archived / broadcast-only
// / all) keeps doing the Inbox tab's internal sub-view bucketing unchanged;
// this module is strictly the new top-level tab split layered on top of it,
// plus the "unread first" ordering and unread counting the merge adds.

export type MessagesTab = "inbox" | "sent" | "failed" | "transcripts";

export const MESSAGES_TABS: readonly MessagesTab[] = ["inbox", "sent", "failed", "transcripts"];

export function isMessagesTab(value: string | undefined): value is MessagesTab {
  return !!value && (MESSAGES_TABS as readonly string[]).includes(value);
}

// Inbox is always the landing tab -- a staff member opening /admin/messages
// should see what needs attention first, never a stats table.
export function defaultMessagesTab(): MessagesTab {
  return "inbox";
}

// Validates an incoming `?tab=` value, falling back to the default for
// anything missing or unrecognized (e.g. a stale bookmark or typo).
export function resolveMessagesTab(value: string | undefined): MessagesTab {
  return isMessagesTab(value) ? value : defaultMessagesTab();
}

// Minimal shape the Inbox tab's ordering needs.
export interface UnreadSortable {
  unreadCount: number;
  lastActivityAt: Date;
}

// "Inbox (default, unread first)": conversations with at least one unread
// message sort above everything else, each group ordered by most recent
// activity first. Array.prototype.sort is a stable sort per spec, so two
// conversations with the same unread-ness and timestamp keep their incoming
// relative order instead of jittering between renders.
export function sortConversationsUnreadFirst<T extends UnreadSortable>(
  conversations: readonly T[],
): T[] {
  return [...conversations].sort((a, b) => {
    const unreadRank = (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0);
    if (unreadRank !== 0) return unreadRank;
    return b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
  });
}

// Sum of unreadCount across whatever conversation list the Inbox tab is
// about to render -- used for the "N unread" hint in the Inbox tab.
export function countUnreadConversations(conversations: readonly { unreadCount: number }[]): number {
  return conversations.reduce((sum, c) => sum + c.unreadCount, 0);
}

// Transcript kind sub-filter (match/dispute/support) -- the same three
// values transcripts/page.tsx already recognized, pulled out so the merged
// page validates the `?kind=` param the same way instead of re-deriving the
// allow-list inline.
export type TranscriptKind = "match" | "dispute" | "support";
export const TRANSCRIPT_KINDS: readonly TranscriptKind[] = ["match", "dispute", "support"];

export function isTranscriptKind(value: string | undefined): value is TranscriptKind {
  return !!value && (TRANSCRIPT_KINDS as readonly string[]).includes(value);
}

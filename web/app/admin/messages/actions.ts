"use server";

// Server actions for the merged /admin/messages page. Moved here (behaviour
// unchanged) from web/app/admin/dms/actions.ts and web/app/admin/message/actions.ts,
// which are deleted now that the DMs/Message pages are thin redirects into this
// page -- see web/app/admin/dms/page.tsx and web/app/admin/message/page.tsx.
// Every redirect below now targets /admin/messages?tab=inbox (the only tab any
// of these actions act on) instead of the old /admin/dms or /admin/message paths.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { recordAudit, actorFromAdminUser } from "@/lib/audit";
import { enqueueDm } from "@/lib/queue";
import { formatStaffReply, pickStaffDisplayName } from "@/lib/dm-format-core";
import { selectUnansweredMessageIds } from "@/lib/dm-inbox-core";

const PAGE = "/admin/messages";
const INBOX_TAB = "tab=inbox";

// Bulk/per-card actions redirect back to the same tab + search query the
// staff member was looking at, instead of always bouncing to the default
// view -- so archiving a page of results doesn't lose their place.
function backToPage(view: string, q: string, params: { ok?: string; err?: string }): string {
  const search = new URLSearchParams();
  search.set("tab", "inbox");
  if (view) search.set("view", view);
  if (q) search.set("q", q);
  if (params.ok) search.set("ok", params.ok);
  if (params.err) search.set("err", params.err);
  return `${PAGE}?${search.toString()}`;
}

// Resolve how the player will see the replying staff member: the daily-synced
// GuildMember cache (nickname > globalName > @handle) first, else the admin's
// own session name, else their raw discordId as a last resort. The precedence
// itself is pure (dm-format-core.ts); this just gathers the one DB read.
async function resolveStaffName(discordId: string, fallbackName: string | null | undefined): Promise<string> {
  const member = await prisma.guildMember.findUnique({
    where: { discordId },
    select: { nickname: true, globalName: true, username: true },
  });
  return pickStaffDisplayName(member, fallbackName, discordId);
}

// Reply to a player's thread: quotes the latest message of theirs that hasn't
// been answered yet, sends ONE DM (named + quoted via formatStaffReply), and
// marks every one of their unread/read inbound messages as replied - a single
// reply answers the whole backlog, not just one row. The bot sends the content
// unchanged (enqueueDm/notify.dm records the DmDelivery row with kind
// "staff-reply" so the thread view can show who sent it and what it said).
export async function replyToDm(formData: FormData) {
  const { user } = await requireAdmin();
  const discordId = String(formData.get("discordId") ?? "").trim();
  const replyText = String(formData.get("reply") ?? "").trim();
  if (!discordId) redirect(`${PAGE}?${INBOX_TAB}&err=${encodeURIComponent("Missing recipient.")}`);
  if (!replyText) redirect(`${PAGE}?${INBOX_TAB}&err=${encodeURIComponent("Write a reply before sending.")}`);

  const pending = await prisma.inboundDm.findMany({
    where: { authorDiscordId: discordId, status: { in: ["unread", "read"] } },
    orderBy: { receivedAt: "desc" },
    select: { id: true, content: true, authorName: true },
  });

  // Nothing outstanding (e.g. staff is following up after everything was
  // already answered) - quote the most recent message of theirs regardless
  // of status, so the DM still has context.
  const latest =
    pending[0] ??
    (await prisma.inboundDm.findFirst({
      where: { authorDiscordId: discordId },
      orderBy: { receivedAt: "desc" },
      select: { id: true, content: true, authorName: true },
    }));

  const authorName = latest?.authorName ?? discordId;
  const staffName = await resolveStaffName(user.discordId, user.name);
  const content = formatStaffReply({ staffName, quoted: latest?.content ?? null, reply: replyText });

  await enqueueDm({
    discordId,
    content,
    batchKind: "reply",
    kind: "staff-reply",
    senderDiscordId: user.discordId,
    senderName: staffName,
    inReplyToInboundDmId: latest?.id,
  });

  const now = new Date();
  if (pending.length > 0) {
    await prisma.inboundDm.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { status: "replied", repliedAt: now, repliedBy: user.discordId, repliedByName: staffName, replyText },
    });
  } else if (latest) {
    // Nothing was pending, but we still replied to their most recent message -
    // stamp it so the thread shows the exchange.
    await prisma.inboundDm.update({
      where: { id: latest.id },
      data: { repliedAt: now, repliedBy: user.discordId, repliedByName: staffName, replyText },
    });
  }

  const actor = actorFromAdminUser(user);
  await recordAudit({
    actor,
    action: "dm.reply",
    targetType: "InboundDm",
    targetId: latest?.id ?? discordId,
    summary: `Replied to DM from ${authorName}`,
    metadata: { authorDiscordId: discordId, markedRepliedCount: pending.length },
  });

  revalidatePath(PAGE);
  redirect(`${PAGE}?${INBOX_TAB}&ok=${encodeURIComponent("Sent.")}`);
}

// Mark an unread DM as read. updateMany with a status guard so we only ever
// promote unread -> read and never downgrade a replied message.
export async function markDmRead(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) redirect(`${PAGE}?${INBOX_TAB}&err=${encodeURIComponent("Missing message id.")}`);

  await prisma.inboundDm.updateMany({
    where: { id, status: "unread" },
    data: { status: "read", readAt: new Date() },
  });

  revalidatePath(PAGE);
  redirect(`${PAGE}?${INBOX_TAB}&ok=${encodeURIComponent("Marked read.")}`);
}

// Shared formData reader for the bulk/per-card actions below: the selected
// discordIds, plus the view/q the toolbar form carries as hidden fields so
// the redirect lands back on the same tab + search the staff member had open.
function readBulkRequest(formData: FormData): { ids: string[]; view: string; q: string } {
  const ids = [...new Set(formData.getAll("ids").map((v) => String(v).trim()).filter(Boolean))];
  const view = String(formData.get("view") ?? "").trim();
  const q = String(formData.get("q") ?? "").trim();
  return { ids, view, q };
}

// Bulk/per-card "Mark read" (card-level button reads "Mark all read" --
// it's this same action called with a single discordId): every unanswered
// (unread or read, not yet replied) inbound row of each selected player ->
// status "read". Gather (fetch candidate rows) -> decide (pure
// selectUnansweredMessageIds) -> write (update exactly those ids), so which
// rows qualify is a plain-data decision, not something re-derived inside a
// DB WHERE clause.
export async function markManyRead(formData: FormData) {
  const { user } = await requireAdmin();
  const { ids, view, q } = readBulkRequest(formData);
  if (ids.length === 0) redirect(backToPage(view, q, { err: "Select at least one conversation." }));

  const candidates = await prisma.inboundDm.findMany({
    where: { authorDiscordId: { in: ids } },
    select: { id: true, authorDiscordId: true, status: true },
  });
  const toMarkRead = selectUnansweredMessageIds(
    candidates.map((c) => ({ id: c.id, authorDiscordId: c.authorDiscordId, status: c.status as "unread" | "read" | "replied" })),
    ids,
  );

  if (toMarkRead.length > 0) {
    await prisma.inboundDm.updateMany({
      where: { id: { in: toMarkRead } },
      data: { status: "read", readAt: new Date() },
    });
  }

  const actor = actorFromAdminUser(user);
  await recordAudit({
    actor,
    action: "dm.bulk-mark-read",
    targetType: "InboundDm",
    summary: `Marked ${toMarkRead.length} DM(s) read across ${ids.length} conversation(s)`,
    metadata: { discordIds: ids, updatedCount: toMarkRead.length },
  });

  revalidatePath(PAGE);
  redirect(backToPage(view, q, { ok: `Marked read for ${ids.length} conversation(s).` }));
}

// Archive: upserts a DmConversationState row per selected player with
// archivedAt = now and the acting staff member's resolved name, same
// resolution precedence replyToDm uses. A player writing again afterwards
// un-archives them automatically (classifyConversation) -- no write needed.
export async function archiveConversations(formData: FormData) {
  const { user } = await requireAdmin();
  const { ids, view, q } = readBulkRequest(formData);
  if (ids.length === 0) redirect(backToPage(view, q, { err: "Select at least one conversation." }));

  const staffName = await resolveStaffName(user.discordId, user.name);
  const now = new Date();
  await Promise.all(
    ids.map((discordId) =>
      prisma.dmConversationState.upsert({
        where: { discordId },
        create: { discordId, archivedAt: now, archivedBy: user.discordId, archivedByName: staffName },
        update: { archivedAt: now, archivedBy: user.discordId, archivedByName: staffName },
      }),
    ),
  );

  const actor = actorFromAdminUser(user);
  await recordAudit({
    actor,
    action: "dm.archive",
    targetType: "DmConversationState",
    summary: `Archived ${ids.length} conversation(s)`,
    metadata: { discordIds: ids },
  });

  revalidatePath(PAGE);
  redirect(backToPage(view, q, { ok: `Archived ${ids.length} conversation(s).` }));
}

// Unarchive: clears archivedAt on each selected player's state row. A no-op
// for players with no row (never archived) -- nothing to clear.
export async function unarchiveConversations(formData: FormData) {
  const { user } = await requireAdmin();
  const { ids, view, q } = readBulkRequest(formData);
  if (ids.length === 0) redirect(backToPage(view, q, { err: "Select at least one conversation." }));

  const staffName = await resolveStaffName(user.discordId, user.name);
  await prisma.dmConversationState.updateMany({
    where: { discordId: { in: ids } },
    data: { archivedAt: null, archivedBy: user.discordId, archivedByName: staffName },
  });

  const actor = actorFromAdminUser(user);
  await recordAudit({
    actor,
    action: "dm.unarchive",
    targetType: "DmConversationState",
    summary: `Unarchived ${ids.length} conversation(s)`,
    metadata: { discordIds: ids },
  });

  revalidatePath(PAGE);
  redirect(backToPage(view, q, { ok: `Unarchived ${ids.length} conversation(s).` }));
}

// Send a one-off DM to a single player via the bot (the "New DM" disclosure).
// The web enqueues a notify.dm job (the bot owns the actual send + throttling);
// audited with the sending admin. On any validation failure, redirects back
// with newdm=1 so the page reopens the New DM disclosure instead of silently
// collapsing it with the error banner shown above a closed form.
export async function sendBotDm(formData: FormData) {
  const { user } = await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();

  const failWith = (err: string) =>
    redirect(`${PAGE}?${INBOX_TAB}&newdm=1&err=${encodeURIComponent(err)}`);

  if (!playerId) failWith("Pick a player.");
  if (!message) failWith("Write a message before sending.");
  if (message.length > 1900) failWith("Message is too long (max 1900 characters).");

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { discordId: true, displayName: true },
  });
  if (!player) failWith("Player not found.");

  await enqueueDm({ discordId: player!.discordId, content: message });

  await recordAudit({
    actor: actorFromAdminUser(user),
    action: "bot.dm",
    targetType: "Player",
    targetId: playerId,
    summary: `DM'd ${player!.displayName} via the bot`,
    metadata: { playerId, length: message.length },
  });

  revalidatePath(PAGE);
  redirect(`${PAGE}?${INBOX_TAB}&ok=${encodeURIComponent(`DM queued to ${player!.displayName}.`)}`);
}

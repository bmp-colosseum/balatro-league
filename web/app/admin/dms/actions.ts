"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { recordAudit, actorFromAdminUser } from "@/lib/audit";
import { enqueueDm } from "@/lib/queue";
import { formatStaffReply, pickStaffDisplayName } from "@/lib/dm-format-core";

const PAGE = "/admin/dms";

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
// marks every one of their unread/read inbound messages as replied — a single
// reply answers the whole backlog, not just one row. The bot sends the content
// unchanged (enqueueDm/notify.dm records the DmDelivery row with kind
// "staff-reply" so the thread view can show who sent it and what it said).
export async function replyToDm(formData: FormData) {
  const { user } = await requireAdmin();
  const discordId = String(formData.get("discordId") ?? "").trim();
  const replyText = String(formData.get("reply") ?? "").trim();
  if (!discordId) redirect(`${PAGE}?err=${encodeURIComponent("Missing recipient.")}`);
  if (!replyText) redirect(`${PAGE}?err=${encodeURIComponent("Write a reply before sending.")}`);

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
  redirect(`${PAGE}?ok=${encodeURIComponent("Sent.")}`);
}

// Mark an unread DM as read. updateMany with a status guard so we only ever
// promote unread -> read and never downgrade a replied message.
export async function markDmRead(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) redirect(`${PAGE}?err=${encodeURIComponent("Missing message id.")}`);

  await prisma.inboundDm.updateMany({
    where: { id, status: "unread" },
    data: { status: "read", readAt: new Date() },
  });

  revalidatePath(PAGE);
  redirect(`${PAGE}?ok=${encodeURIComponent("Marked read.")}`);
}

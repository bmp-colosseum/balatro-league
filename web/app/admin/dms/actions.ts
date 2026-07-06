"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { recordAudit, actorFromAdminUser } from "@/lib/audit";
import { enqueueDm } from "@/lib/queue";

const PAGE = "/admin/dms";

// Reply to an inbound DM: enqueue the outbound DM (the bot sends it + records a
// DmDelivery tagged batchKind "reply"), then stamp the InboundDm as replied.
// Sending again on an already-replied message just overwrites the reply stamp —
// that's intentional (staff can follow up).
export async function replyToDm(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "").trim();
  const replyText = String(formData.get("reply") ?? "").trim();
  if (!id) redirect(`${PAGE}?err=${encodeURIComponent("Missing message id.")}`);
  if (!replyText) redirect(`${PAGE}?err=${encodeURIComponent("Write a reply before sending.")}`);

  const dm = await prisma.inboundDm.findUnique({
    where: { id },
    select: { authorDiscordId: true, authorName: true },
  });
  if (!dm) redirect(`${PAGE}?err=${encodeURIComponent("Message not found.")}`);

  await enqueueDm({ discordId: dm.authorDiscordId, content: replyText, batchKind: "reply" });

  await prisma.inboundDm.update({
    where: { id },
    data: { status: "replied", repliedAt: new Date(), repliedBy: user.discordId, replyText },
  });

  const actor = actorFromAdminUser(user);
  await recordAudit({
    actor,
    action: "dm.reply",
    targetType: "InboundDm",
    targetId: id,
    summary: `Replied to DM from ${dm.authorName}`,
    metadata: { authorDiscordId: dm.authorDiscordId },
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

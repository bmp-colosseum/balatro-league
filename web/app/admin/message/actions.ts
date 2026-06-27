"use server";

// Send a one-off DM to a single player via the bot. The web enqueues a notify.dm
// job (the bot owns the actual send + throttling); audited with the sending admin.

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { enqueueDm } from "@/lib/queue";

export async function sendBotDm(formData: FormData) {
  const { user } = await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();

  if (!playerId) redirect("/admin/message?err=pick-a-player");
  if (!message) redirect("/admin/message?err=empty-message");
  if (message.length > 1900) redirect("/admin/message?err=too-long");

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { discordId: true, displayName: true },
  });
  if (!player) redirect("/admin/message?err=player-not-found");

  await enqueueDm({ discordId: player!.discordId, content: message });

  await recordAudit({
    actor: actorFromAdminUser(user),
    action: "bot.dm",
    targetType: "Player",
    targetId: playerId,
    summary: `DM'd ${player!.displayName} via the bot`,
    metadata: { playerId, length: message.length },
  });

  redirect(`/admin/message?ok=${encodeURIComponent(player!.displayName)}`);
}

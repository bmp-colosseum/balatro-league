"use server";

// Server actions for the "New players" step card on /admin/season-tools.
// Both actions only enqueue pg-boss jobs -- the bot's notify.onboarding-guide
// worker (src/onboarding-dm.ts) does the actual Discord send, and skips
// anyone who already has a "sent" DmDelivery row for this kind.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { enqueueOnboardingGuide } from "@/lib/queue";
import { loadNewcomers } from "@/lib/loaders/newcomers";
import { recordAudit, actorFromAdminUser } from "@/lib/audit";
import type { ActionResult } from "@/lib/action-result";

// DM the signed-in admin a preview of the real onboarding guide (same
// content, same worker, same idempotency) -- always allowed, since it only
// ever targets the admin's own player id, never another player.
export async function previewOnboardingGuide(_prev: ActionResult, _formData: FormData): Promise<ActionResult> {
  const { user } = await requireAdmin();
  const player = await prisma.player.findUnique({ where: { discordId: user.discordId }, select: { id: true } });
  if (!player) {
    return { ok: false, message: "No Player record for your Discord account -- can't preview." };
  }
  await enqueueOnboardingGuide({ playerIds: [player.id] });
  await recordAudit({
    actor: actorFromAdminUser(user),
    action: "onboarding-guide.preview",
    targetType: "Player",
    targetId: player.id,
    summary: "Sent themselves a preview of the onboarding guide",
  });
  revalidatePath("/admin/season-tools");
  return { ok: true, message: "Preview queued -- check your Discord DMs (arrives in a few seconds)." };
}

// Send the real onboarding guide to every first-timer this season. Safe to
// re-run: the worker skips anyone with an existing "sent" delivery, so this
// only ever reaches new players who haven't gotten it yet.
export async function sendOnboardingGuideToAll(_prev: ActionResult, _formData: FormData): Promise<ActionResult> {
  const { user } = await requireAdmin();
  const { newcomers } = await loadNewcomers();
  if (newcomers.length === 0) {
    return { ok: false, message: "No new players this season to send to." };
  }
  const playerIds = newcomers.map((n) => n.playerId);
  await enqueueOnboardingGuide({ playerIds });
  await recordAudit({
    actor: actorFromAdminUser(user),
    action: "onboarding-guide.send-all",
    targetType: "Season",
    summary: `Queued the onboarding guide for ${playerIds.length} new player(s)`,
    metadata: { playerIds },
  });
  revalidatePath("/admin/season-tools");
  return {
    ok: true,
    message: `Queued the onboarding guide for ${playerIds.length} new player${playerIds.length === 1 ? "" : "s"} -- they'll go out over the next few seconds. Anyone already sent it is skipped automatically.`,
  };
}

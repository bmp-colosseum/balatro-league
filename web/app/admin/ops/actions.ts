"use server";

// Server actions for /admin/ops — OWNER/DEVOPS-only infra tools.
// Separate from /admin/config (admin-level) so the permission gate
// is consistent: every action here goes through requireOwnerOrDevops.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireOwnerOrDevops } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { runMatchSweep } from "@/lib/match-sweep";

// Manual trigger for the match-thread sweep. Same three passes that
// run every minute on the bot. Audit-logged for traceability.
export async function runMatchSweepAction() {
  const { user } = await requireOwnerOrDevops();
  const result = await runMatchSweep();
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "match-sweep.manual",
    targetType: "MatchSession",
    targetId: "all",
    summary:
      `Manual match-thread sweep: ${result.expiredInvitesCancelled} expired invite(s), ` +
      `${result.idleSessionsCancelled} idle session(s), ${result.leakedThreadsProcessed} leaked thread(s) processed ` +
      `(${result.leakedThreadsDeleted} deleted)`,
    metadata: { ...result },
  });
  revalidatePath("/admin/ops");
  const summary = encodeURIComponent(
    `Expired invites: ${result.expiredInvitesCancelled} · Idle: ${result.idleSessionsCancelled} · Leaked: ${result.leakedThreadsDeleted}/${result.leakedThreadsProcessed}`,
  );
  redirect(`/admin/ops?sweepOk=${summary}`);
}

"use server";

// Server actions for /admin/ops — OWNER/DEVOPS-only infra tools.
// Separate from /admin/config (admin-level) so the permission gate
// is consistent: every action here goes through requireOwnerOrDevops.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireOwnerOrDevops } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { runMatchSweep } from "@/lib/match-sweep";

// Manual trigger for the match-thread sweep. Runs the same three
// passes the bot's 1-minute cron does, PLUS a fourth orphan-thread
// pass that only the manual button runs (it's a guild-wide REST hit,
// not cheap enough to run every minute). The orphan pass finds Discord
// threads under known match-parent channels (challenges + division
// channels) that have no MatchSession row tracking them and deletes
// them — catches the "we weren't tracking them right" case the user
// flagged.
export async function runMatchSweepAction() {
  const { user } = await requireOwnerOrDevops();
  const result = await runMatchSweep({ includeOrphans: true });
  const o = result.orphan;
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "match-sweep.manual",
    targetType: "MatchSession",
    targetId: "all",
    summary:
      `Manual match-thread sweep: ${result.expiredInvitesCancelled} expired invite(s), ` +
      `${result.idleSessionsCancelled} idle session(s), ${result.leakedThreadsProcessed} leaked thread(s) processed ` +
      `(${result.leakedThreadsDeleted} deleted), ` +
      `${o?.orphanThreadsFound ?? 0} orphan thread(s) found (${o?.orphanThreadsDeleted ?? 0} deleted)`,
    metadata: { ...result, ...(o ?? {}) },
  });
  revalidatePath("/admin/ops");
  // Pack diagnostics into a query param. Page renders them verbatim so
  // we can tell "found 0 because nothing exists" from "found 0 because
  // we couldn't even look (no GUILD_ID, no parents, etc)".
  const diag = encodeURIComponent(JSON.stringify({ ...result, ...(o ?? {}) }));
  redirect(`/admin/ops?sweepDiag=${diag}`);
}

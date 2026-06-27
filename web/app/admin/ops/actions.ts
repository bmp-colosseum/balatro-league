"use server";

// Server actions for /admin/ops — OWNER/DEVOPS-only infra tools.
// Separate from /admin/config (admin-level) so the permission gate
// is consistent: every action here goes through requireOwnerOrDevops.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireOwnerOrDevops } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { runMatchSweep } from "@/lib/match-sweep";
import { prisma } from "@/lib/prisma";

// Re-queue a FAILED pg-boss job by flipping it back to 'created' so a worker
// picks it up again (full retries restored). Same-row retry — keeps the job id.
export async function retryFailedJob(formData: FormData) {
  const { user } = await requireOwnerOrDevops();
  const id = String(formData.get("jobId") ?? "").trim();
  if (!id) redirect("/admin/ops?queueErr=missing-id");
  const n = await prisma.$executeRawUnsafe(
    `UPDATE pgboss.job
        SET state = 'created', start_after = now(), started_on = NULL, completed_on = NULL,
            retry_count = 0, output = NULL
      WHERE id = $1::uuid AND state = 'failed'`,
    id,
  );
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "queue.retry-job",
    targetType: "Queue",
    targetId: id,
    summary: `Retried failed job ${id}`,
    metadata: { jobId: id, affected: n },
  });
  revalidatePath("/admin/ops");
  redirect(`/admin/ops?queueOk=${n > 0 ? "retried" : "nothing"}`);
}

// Delete a single FAILED job (dismiss it from the list).
export async function dismissFailedJob(formData: FormData) {
  const { user } = await requireOwnerOrDevops();
  const id = String(formData.get("jobId") ?? "").trim();
  if (!id) redirect("/admin/ops?queueErr=missing-id");
  const n = await prisma.$executeRawUnsafe(
    `DELETE FROM pgboss.job WHERE id = $1::uuid AND state = 'failed'`,
    id,
  );
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "queue.dismiss-job",
    targetType: "Queue",
    targetId: id,
    summary: `Dismissed failed job ${id}`,
    metadata: { jobId: id, affected: n },
  });
  revalidatePath("/admin/ops");
  redirect(`/admin/ops?queueOk=dismissed`);
}

// Clear a queue's PENDING backlog (created + retry) — e.g. drop a pile of stuck
// jobs that built up during an outage so the stall alert stops firing. Does NOT
// touch active/completed/failed jobs.
export async function clearQueuePending(formData: FormData) {
  const { user } = await requireOwnerOrDevops();
  const name = String(formData.get("queueName") ?? "").trim();
  if (!name) redirect("/admin/ops?queueErr=missing-queue");
  const n = await prisma.$executeRawUnsafe(
    `DELETE FROM pgboss.job WHERE name = $1 AND state IN ('created', 'retry')`,
    name,
  );
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "queue.clear-pending",
    targetType: "Queue",
    targetId: name,
    summary: `Cleared ${n} pending job(s) from queue "${name}"`,
    metadata: { queueName: name, deleted: n },
  });
  revalidatePath("/admin/ops");
  redirect(`/admin/ops?queueOk=cleared-${n}`);
}

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

// Append-only audit log writer for admin actions + key system events.
// Both the bot (this file) and the web app (web/lib/audit.ts) share the
// same database table — keep the action canonical-key conventions in
// sync between both files.
//
// action keys are dot-separated, lowercased, hyphen-separated. The list
// is intentionally open — add new ones as features land. Reading code
// should never assume a closed enum.

import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

export interface AuditActor {
  discordId: string;
  displayName: string;
}

// System-event actor — use this when the action wasn't triggered by a
// human (cron jobs, mutual-consent flows where there's no single actor,
// auto-confirms).
export const SYSTEM_ACTOR: AuditActor = { discordId: "system", displayName: "system" };

export interface RecordAuditInput {
  actor: AuditActor;
  action: string;
  targetType?: string;
  targetId?: string;
  summary: string;
  metadata?: Prisma.InputJsonValue;
}

// Fire-and-forget — best-effort. Audit logging must NEVER fail the
// caller; the worst case is a missing audit row, not a broken admin
// action. All writes go through this so a future move to a queue / S3
// log is a one-place change.
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await prisma.adminAuditEvent.create({
      data: {
        actorDiscordId: input.actor.discordId,
        actorName: input.actor.displayName,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        summary: input.summary,
        metadata: input.metadata,
      },
    });
  } catch (err) {
    console.warn(`[audit] failed to record ${input.action}:`, err);
  }
}

// Convenience: build an AuditActor from a Discord interaction user
// (the common case for slash command handlers).
export function actorFromInteractionUser(user: { id: string; username: string; globalName?: string | null }): AuditActor {
  return {
    discordId: user.id,
    displayName: user.globalName ?? user.username ?? user.id,
  };
}

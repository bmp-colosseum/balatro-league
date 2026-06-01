// Web-side audit logger — shares the AdminAuditEvent table with the
// bot's src/audit.ts. Keep action canonical-key conventions in sync
// between the two files.

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export interface AuditActor {
  discordId: string;
  displayName: string;
}

export const SYSTEM_ACTOR: AuditActor = { discordId: "system", displayName: "system" };

export interface RecordAuditInput {
  actor: AuditActor;
  action: string;
  targetType?: string;
  targetId?: string;
  summary: string;
  metadata?: Prisma.InputJsonValue;
}

// Best-effort write. Never throws — a missing audit row is preferable
// to a broken admin action.
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

// Build an actor record from the user object returned by requireAdmin().
// All web admin actions already have access to this shape after the
// permission check, so callers don't need to thread the raw next-auth
// session in.
export function actorFromAdminUser(user: { discordId: string; name?: string | null }): AuditActor {
  return { discordId: user.discordId, displayName: user.name ?? user.discordId };
}

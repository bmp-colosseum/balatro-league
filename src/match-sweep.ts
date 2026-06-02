// Periodic sweep for expired match invites. Runs on bot boot (to catch invites
// that expired during a redeploy) and every minute thereafter.
//
// Why: handleAccept also checks expiresAt on click, but if nobody clicks at all
// the invite would sit in WAITING_ACCEPT forever. The sweep is the safety net.
//
// Also locks + archives the associated Discord thread immediately on
// expiry — otherwise the abandoned challenge thread sits open until
// the 24h stale-threads cron picks it up, cluttering the channel
// sidebar.

import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { prisma } from "./db.js";
import { env } from "./env.js";

const SWEEP_INTERVAL_MS = 60 * 1000;

let cachedRest: REST | null = null;
function rest(): REST {
  if (!cachedRest) cachedRest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
  return cachedRest;
}

export async function sweepExpiredInvites(): Promise<number> {
  // Select the sessions first so we can hit their threads. Then mark
  // them CANCELLED in bulk. updateMany would have been faster but it
  // doesn't return the rows, and we need threadIds.
  const expired = await prisma.matchSession.findMany({
    where: {
      state: "WAITING_ACCEPT",
      expiresAt: { lt: new Date() },
    },
    select: { id: true, threadId: true, version: true },
  });
  if (expired.length === 0) return 0;

  for (const session of expired) {
    await prisma.matchSession.update({
      where: { id: session.id },
      data: {
        state: "CANCELLED",
        version: { increment: 1 },
      },
    }).catch((err) => {
      console.warn(`[match-sweep] cancel ${session.id} failed:`, err);
    });

    // Close the thread immediately so the abandoned invite doesn't
    // sit open. setLocked + setArchived via REST works even without
    // a live gateway client. Best-effort — failures (thread deleted,
    // permissions revoked) leave threadArchivedAt null so the 24h
    // stale-threads cron can retry.
    if (session.threadId) {
      try {
        await rest().patch(Routes.channel(session.threadId), {
          body: { locked: true, archived: true },
        });
        await prisma.matchSession.update({
          where: { id: session.id },
          data: { threadArchivedAt: new Date() },
        }).catch(() => {});
      } catch (err) {
        console.warn(`[match-sweep] thread close ${session.threadId} failed:`, err);
      }
    }
  }
  console.log(`[match-sweep] cancelled ${expired.length} expired invite(s)`);
  return expired.length;
}

export function startMatchSweep(): void {
  // Run once immediately on boot.
  sweepExpiredInvites().catch((err) => console.warn("[match-sweep] boot sweep failed:", err));
  setInterval(() => {
    sweepExpiredInvites().catch((err) => console.warn("[match-sweep] tick failed:", err));
  }, SWEEP_INTERVAL_MS);
}

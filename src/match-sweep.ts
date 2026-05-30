// Periodic sweep for expired match invites. Runs on bot boot (to catch invites
// that expired during a redeploy) and every minute thereafter.
//
// Why: handleAccept also checks expiresAt on click, but if nobody clicks at all
// the invite would sit in WAITING_ACCEPT forever. The sweep is the safety net.

import { prisma } from "./db.js";

const SWEEP_INTERVAL_MS = 60 * 1000;

export async function sweepExpiredInvites(): Promise<number> {
  const result = await prisma.matchSession.updateMany({
    where: {
      state: "WAITING_ACCEPT",
      expiresAt: { lt: new Date() },
    },
    data: {
      state: "CANCELLED",
      version: { increment: 1 },
    },
  });
  if (result.count > 0) {
    console.log(`[match-sweep] cancelled ${result.count} expired invite(s)`);
  }
  return result.count;
}

export function startMatchSweep(): void {
  // Run once immediately on boot.
  sweepExpiredInvites().catch((err) => console.warn("[match-sweep] boot sweep failed:", err));
  setInterval(() => {
    sweepExpiredInvites().catch((err) => console.warn("[match-sweep] tick failed:", err));
  }, SWEEP_INTERVAL_MS);
}

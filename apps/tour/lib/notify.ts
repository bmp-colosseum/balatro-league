// Fire-and-forget live notifications (C5). Services call notifyLive(scope) post-commit;
// the SSE route (app/api/live/[channel]) relays matching scopes to subscribed browsers,
// which just router.refresh(). One pg NOTIFY channel ("tour_live") carries the scope as
// its payload — scopes: "draft:<seasonId>", "matchup:<matchupId>", "sets".
import { prisma } from "./db";

export async function notifyLive(scope: string): Promise<void> {
  try {
    await prisma.$executeRawUnsafe("SELECT pg_notify('tour_live', $1)", scope);
  } catch {
    /* live refresh is best-effort — never fail the mutation */
  }
}

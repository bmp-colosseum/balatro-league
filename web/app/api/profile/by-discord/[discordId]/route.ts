// Service-to-service resolver: given a Discord id, return this person's league profile
// (internal player id + name + path) so ANOTHER service (the Team Tour site) can cross-link a
// person by their Discord id WITHOUT the raw id ever appearing in public page source. The caller
// resolves server-side, then links using our INTERNAL id (/profile/<id>). Bearer ADMIN_TOKEN
// (the same ops-script token /api/admin/* uses).
import { NextRequest, NextResponse } from "next/server";
import { AdminTokenError, requireAdminToken } from "@/lib/admin-token";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ discordId: string }> }) {
  try {
    requireAdminToken(req);
  } catch (err) {
    if (err instanceof AdminTokenError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
  const { discordId } = await params;
  if (!/^\d+$/.test(discordId)) return NextResponse.json({ error: "invalid discordId" }, { status: 400 });
  const p = await prisma.player.findUnique({ where: { discordId }, select: { id: true, displayName: true } });
  if (!p) return NextResponse.json({ found: false }, { status: 404 });
  return NextResponse.json({ found: true, playerId: p.id, name: p.displayName, path: `/profile/${p.id}` });
}

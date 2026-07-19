// Service-to-service resolver: given a Discord id, return this person's league profile
// (internal player id + name + path) so ANOTHER service (the Team Tour site) can cross-link a
// person by their Discord id WITHOUT the raw id ever appearing in public page source. The caller
// resolves server-side, then links using our INTERNAL id (/profile/<id>). Auth is a dedicated,
// least-privilege PROFILE_LOOKUP_TOKEN (NOT the ADMIN_TOKEN) shared by the two sites.
import { NextRequest, NextResponse } from "next/server";
import { requireProfileToken } from "@/lib/service-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ discordId: string }> }) {
  if (!requireProfileToken(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { discordId } = await params;
  if (!/^\d+$/.test(discordId)) return NextResponse.json({ error: "invalid discordId" }, { status: 400 });
  const p = await prisma.player.findUnique({ where: { discordId }, select: { id: true, displayName: true } });
  if (!p) return NextResponse.json({ found: false }, { status: 404 });
  return NextResponse.json({ found: true, playerId: p.id, name: p.displayName, path: `/profile/${p.id}` });
}

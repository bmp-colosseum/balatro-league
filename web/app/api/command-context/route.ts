// Permission context for the ⌘K command palette: who's looking, and the player
// roster (logged-in only). Lets the palette show admin/authed entries only to
// those who can actually use them. Fetched lazily the first time it opens.

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  const loggedIn = !!session?.user;

  // Division (standings) pages are public, so surface the active season's
  // divisions to everyone — anyone can jump straight to one from the palette.
  const activeSeason = await prisma.season.findFirst({ where: { isActive: true }, select: { id: true } });
  const divisionRows = activeSeason
    ? await prisma.division.findMany({
        where: { seasonId: activeSeason.id },
        select: { id: true, name: true },
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
      })
    : [];
  const divisions = divisionRows.map((d) => ({ id: d.id, label: d.name }));

  if (!loggedIn) {
    return NextResponse.json({ loggedIn: false, admin: false, players: [], divisions });
  }

  const admin = await isAdminUser();
  const players = await prisma.player.findMany({
    select: { id: true, displayName: true, discordId: true, username: true },
    orderBy: { displayName: "asc" },
    take: 1000,
  });
  return NextResponse.json({ loggedIn, admin, players, divisions });
}

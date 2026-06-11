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
  if (!loggedIn) {
    return NextResponse.json({ loggedIn: false, admin: false, players: [] });
  }

  const admin = await isAdminUser();
  const players = await prisma.player.findMany({
    select: { id: true, displayName: true },
    orderBy: { displayName: "asc" },
    take: 1000,
  });
  return NextResponse.json({ loggedIn, admin, players });
}

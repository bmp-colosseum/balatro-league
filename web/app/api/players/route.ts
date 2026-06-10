// Lightweight player list for the ⌘K command palette. Auth-gated (only logged-in
// users get the roster) and capped. Names are already public on standings/
// profiles, but gating keeps the full list behind login like /players.

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ players: [] });

  const players = await prisma.player.findMany({
    select: { id: true, displayName: true },
    orderBy: { displayName: "asc" },
    take: 1000,
  });
  return NextResponse.json({ players });
}

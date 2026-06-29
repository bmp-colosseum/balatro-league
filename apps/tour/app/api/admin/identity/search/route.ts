import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { searchLeagueRef, listTourPlayers } from "@/lib/services/identity";

// Picker backend for the identity manager: league reference (for linking) or Tour
// players (for merging). Dev-admin gated.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ results: [] }, { status: 403 });
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const q = url.searchParams.get("q") ?? "";

  if (type === "league") {
    const league = await searchLeagueRef(q);
    return NextResponse.json({ results: league.map((r) => ({ value: r.discordId, label: r.name, detail: r.discordId })) });
  }
  const rows = await listTourPlayers(q, 20);
  return NextResponse.json({
    results: rows.map((r) => ({ value: r.id, label: r.name, detail: `${r.seasons} sns · ${r.sets} sets${r.linked ? " · linked" : ""}` })),
  });
}

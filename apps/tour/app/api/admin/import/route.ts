// REST trigger for the import service (the same logic the admin button uses, and
// the only home of the import logic — no script reimplements it).
//   POST /api/admin/import?type=historical   → alltime rosters+results+playoffs
//   POST /api/admin/import?type=tt10          → TT10 conference season
import { NextResponse } from "next/server";
import { isApiAdmin } from "@/lib/auth";
import { importHistorical, importTT10 } from "@/lib/services/import";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!(await isApiAdmin(req))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const type = new URL(req.url).searchParams.get("type") ?? "historical";
  try {
    const result = type === "tt10" ? await importTT10() : await importHistorical();
    return NextResponse.json({ type, result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

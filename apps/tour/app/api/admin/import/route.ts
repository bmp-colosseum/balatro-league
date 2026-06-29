// REST trigger for the import service (the same logic the admin button uses, and
// the only home of the import logic — no script reimplements it).
//   POST /api/admin/import?type=historical   → alltime rosters+results+playoffs
//   POST /api/admin/import?type=tt10          → Team Tour 4 conference season
import { NextResponse } from "next/server";
import { isApiAdmin } from "@/lib/auth";
import { importHistorical, importConferenceSeason, applyConferenceData, importConferenceRosters, importConferenceResults } from "@/lib/services/import";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!(await isApiAdmin(req))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const type = new URL(req.url).searchParams.get("type") ?? "historical";
  try {
    let result;
    if (type === "tt10" || type === "tt4") {
      const conference = await importConferenceSeason();
      await applyConferenceData();
      const rosters = await importConferenceRosters();
      const results = await importConferenceResults();
      result = { conference, rosters, results };
    } else {
      result = await importHistorical();
    }
    return NextResponse.json({ type, result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// REST entry to the season service. Same logic the admin UI uses (via the server
// action) — callable programmatically (bot, scripts-as-thin-callers, tooling).
import { NextResponse } from "next/server";
import { isApiAdmin } from "@/lib/auth";
import { listSeasons, createSeason, deleteSeason } from "@/lib/services/seasons";

export async function GET(req: Request) {
  if (!(await isApiAdmin(req))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(await listSeasons());
}

export async function POST(req: Request) {
  if (!(await isApiAdmin(req))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const season = await createSeason(await req.json());
    return NextResponse.json(season, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  if (!(await isApiAdmin(req))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const name = new URL(req.url).searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name query param required" }, { status: 400 });
  try {
    await deleteSeason(name);
    return NextResponse.json({ deleted: name });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

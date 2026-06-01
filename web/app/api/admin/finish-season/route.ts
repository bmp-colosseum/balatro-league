// Ops-script endpoint. Bulk-fills every pending pairing in a season
// with random confirmed results. Same code path as a future admin UI
// button could call. Auth via ADMIN_TOKEN bearer.

import { NextRequest, NextResponse } from "next/server";
import { AdminTokenError, requireAdminToken } from "@/lib/admin-token";
import { bulkFillSeason } from "@/lib/bulk-fill";

interface RequestBody {
  seasonId?: unknown;
  seed?: unknown;
  announce?: unknown;
}

export async function POST(req: NextRequest) {
  let ctx: ReturnType<typeof requireAdminToken>;
  try {
    ctx = requireAdminToken(req);
  } catch (err) {
    if (err instanceof AdminTokenError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const seasonId = typeof body.seasonId === "string" ? body.seasonId.trim() : "";
  if (!seasonId) {
    return NextResponse.json({ error: "seasonId (string) is required" }, { status: 400 });
  }
  const seed = typeof body.seed === "number" ? body.seed : undefined;
  const announce = body.announce === true;

  try {
    const result = await bulkFillSeason({ seasonId, seed, announce, actor: ctx.actor });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Fill a BUILT + ACTIVATED season with persona-driven matches (reuses the
// seed-e2e match generator), then recompute standings. Pairs with seed-signups:
//   seed-signups → build at /admin/signups/[id]/build → Activate → seed-matches.
// ADMIN_TOKEN-gated. Test env only — `reset` DELETES the season's matches.
//
// Body (all optional):
//   { seasonId?: string,        // default: the active season
//     playFraction?: number,    // 0..1 share of matches played (default 0.8)
//     announce?: boolean,       // enqueue Discord result announcements (default false)
//     reset?: boolean }         // delete the season's existing matches first
// Returns { ok, seasonId, matches, games, shootouts }.

import { NextRequest, NextResponse } from "next/server";
import { AdminTokenError, requireAdminToken } from "@/lib/admin-token";
import { prisma } from "@/lib/prisma";
import { seedMatchesForSeason } from "@/lib/seed-e2e";

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export async function POST(req: NextRequest) {
  try {
    requireAdminToken(req);
  } catch (err) {
    if (err instanceof AdminTokenError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // empty body is fine — defaults apply
  }

  const seasonId = typeof body.seasonId === "string" ? body.seasonId : null;
  const season = seasonId
    ? await prisma.season.findUnique({ where: { id: seasonId }, select: { id: true, number: true } })
    : await prisma.season.findFirst({
        where: { isActive: true },
        select: { id: true, number: true },
      });
  if (!season) {
    return NextResponse.json(
      { error: "No season to fill — pass seasonId, or build + activate a season first." },
      { status: 400 },
    );
  }

  // Guard: the season must be built (have divisions) — seedMatchesForSeason
  // walks divisions → members to fabricate matches, so an unbuilt season is a
  // no-op that silently returns zero. Surface it instead.
  const divisions = await prisma.division.findMany({
    where: { seasonId: season.id },
    select: { id: true },
  });
  if (divisions.length === 0) {
    return NextResponse.json(
      { error: `Season ${season.number} has no divisions — build it first at the signup build page.` },
      { status: 400 },
    );
  }

  if (body.reset === true) {
    // Match → Game → GameDeck cascade on delete, so this clears prior results.
    await prisma.match.deleteMany({ where: { divisionId: { in: divisions.map((d) => d.id) } } });
  }

  try {
    const playFraction = Math.max(0, Math.min(1, num(body.playFraction) ?? 0.8));
    const result = await seedMatchesForSeason(season.id, playFraction, body.announce === true);
    return NextResponse.json({ ok: true, seasonId: season.id, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

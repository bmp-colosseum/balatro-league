// Ops-script endpoint: (re)generate balanced sub-groups for every division in a
// season, then optionally activate it (which runs the Discord bootstrap → the
// per-group "Group N" threads). Same service the website "Generate sub-groups"
// button calls.
//
// Auth via ADMIN_TOKEN bearer. Body:
//   {
//     seasonId: string,    // required
//     activate?: boolean   // also flip the season live (bootstraps Discord;
//                          //   generate BEFORE activating so the bot sees the
//                          //   groups and creates the threads)
//   }

import { NextRequest, NextResponse } from "next/server";
import { AdminTokenError, requireAdminToken } from "@/lib/admin-token";
import { prisma } from "@/lib/prisma";
import { planSeasonSubGroups } from "@/lib/sub-grouping-service";
import { performSeasonActivation } from "@/lib/season-activation";

interface RequestBody {
  seasonId?: unknown;
  activate?: unknown;
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

  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { targetGroupSize: true },
  });
  if (!season) {
    return NextResponse.json({ error: "season not found" }, { status: 404 });
  }

  try {
    const plans = await planSeasonSubGroups(seasonId, season.targetGroupSize, { apply: true });

    let activated = false;
    if (body.activate === true) {
      await performSeasonActivation(seasonId, ctx.actor, "manual", { skipDiscord: false });
      activated = true;
    }

    return NextResponse.json({
      ok: true,
      activated,
      groupSize: season.targetGroupSize,
      divisions: plans.map((p) => ({
        name: p.divisionName,
        members: p.memberCount,
        groups: p.groupCount,
        balance: p.balance,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

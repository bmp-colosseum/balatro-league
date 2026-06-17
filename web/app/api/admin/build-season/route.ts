// Ops-script endpoint: build a season from a signup round. Runs the SAME
// buildSeasonFromRound core the admin build page uses, so a script gets
// the real placement logic instead of a parallel reimplementation.
//
// Auth via ADMIN_TOKEN bearer. Body:
//   {
//     roundId: string,            // required — the signup round to build
//     subtitle?: string,          // season subtitle (null/empty clears it)
//     config?: string | object,   // tier shape [{ name, divisionCount }]
//                                  //   (required for a brand-new season)
//     targetGroupSize?: number,    // create-mode only
//     minGroupSize?: number,       // create-mode only
//     matchConfigPresetId?: string,
//     activate?: boolean           // also flip the season live (deactivates
//                                  //   any prior active season)
//   }
//
// The build itself leaves the season isActive:false (same as the UI);
// pass activate:true to also run the real activation path.

import { NextRequest, NextResponse } from "next/server";
import { AdminTokenError, requireAdminToken } from "@/lib/admin-token";
import { buildSeasonFromRound } from "@/lib/build-season";
import { performSeasonActivation } from "@/lib/season-activation";

interface RequestBody {
  roundId?: unknown;
  subtitle?: unknown;
  config?: unknown;
  targetGroupSize?: unknown;
  minGroupSize?: unknown;
  matchConfigPresetId?: unknown;
  activate?: unknown;
  // When activating, skip the Discord bootstrap/announce. For automation
  // (seed/e2e) that flips many seasons live without churning channels.
  skipDiscordSetup?: unknown;
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

  const roundId = typeof body.roundId === "string" ? body.roundId.trim() : "";
  if (!roundId) {
    return NextResponse.json({ error: "roundId (string) is required" }, { status: 400 });
  }

  // config may arrive as a JSON string or an already-parsed array; the
  // core expects a string, so re-stringify objects.
  let config: string | undefined;
  if (typeof body.config === "string") config = body.config;
  else if (body.config != null) config = JSON.stringify(body.config);

  const subtitleRaw = typeof body.subtitle === "string" ? body.subtitle.trim() : "";
  const targetGroupSize = typeof body.targetGroupSize === "number" ? body.targetGroupSize : undefined;
  const minGroupSize = typeof body.minGroupSize === "number" ? body.minGroupSize : undefined;
  const matchConfigPresetId =
    typeof body.matchConfigPresetId === "string" && body.matchConfigPresetId.length > 0
      ? body.matchConfigPresetId
      : null;

  try {
    const result = await buildSeasonFromRound({
      roundId,
      subtitle: subtitleRaw.length > 0 ? subtitleRaw : null,
      config,
      targetGroupSize,
      minGroupSize,
      matchConfigPresetId,
      actor: ctx.actor,
    });

    if (!result) {
      return NextResponse.json(
        {
          error:
            "Build did not run. Check that the round exists and (for a new season) that `config` has at least one tier.",
        },
        { status: 400 },
      );
    }

    let activated = false;
    if (body.activate === true) {
      await performSeasonActivation(result.seasonId, ctx.actor, "manual", {
        skipDiscord: body.skipDiscordSetup === true,
      });
      activated = true;
    }

    return NextResponse.json({ ok: true, activated, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

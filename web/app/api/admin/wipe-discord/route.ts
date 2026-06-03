// DESTRUCTIVE: deletes every league-related artifact the bot created
// in the configured Discord guild. Same triple-gate as
// /api/admin/wipe-test-data:
//   1. ADMIN_TOKEN bearer auth
//   2. ALLOW_DESTRUCTIVE_WIPE=true env var on the web service
//   3. Request body { confirm: "WIPE TEST ENV" } phrase
//
// Designed to be called from the wipe:test-env CLI script with the
// --include-discord flag. Independent of the DB wipe — running this
// alone leaves the DB intact (Player rows etc. survive); running the
// DB wipe alone leaves Discord intact. Use both flags together for
// a fully clean test environment.

import { NextRequest, NextResponse } from "next/server";
import { AdminTokenError, requireAdminToken } from "@/lib/admin-token";
import { wipeDiscordLeagueState } from "@/lib/wipe-discord";

const CONFIRM_PHRASE = "WIPE TEST ENV";

interface RequestBody {
  confirm?: unknown;
  guildId?: unknown;
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

  if (process.env.ALLOW_DESTRUCTIVE_WIPE !== "true") {
    return NextResponse.json(
      {
        error:
          "Refused: ALLOW_DESTRUCTIVE_WIPE env var is not 'true'. " +
          "This endpoint only runs in environments explicitly marked as test environments.",
      },
      { status: 403 },
    );
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  if (body.confirm !== CONFIRM_PHRASE) {
    return NextResponse.json(
      {
        error: `Refused: missing or wrong confirmation phrase. Send { "confirm": "${CONFIRM_PHRASE}" } in the request body.`,
      },
      { status: 400 },
    );
  }

  // Override the env-configured guild ID with a body param if provided.
  // Useful if the test env's DISCORD_GUILD_ID env is empty for some
  // reason but caller knows what guild to clean.
  const guildId =
    (typeof body.guildId === "string" && body.guildId.trim().length > 0
      ? body.guildId.trim()
      : process.env.DISCORD_GUILD_ID) ?? "";
  if (!guildId) {
    return NextResponse.json(
      { error: "No guild id available. Pass guildId in body or set DISCORD_GUILD_ID on the web service." },
      { status: 400 },
    );
  }

  try {
    const result = await wipeDiscordLeagueState(guildId, ctx.actor);
    return NextResponse.json({ ok: true, guildId, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

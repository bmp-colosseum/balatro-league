// Ops-script endpoint: end-to-end demo seed in one curl. Builds N demo
// seasons (real build → persona-driven matches on the new Match/Game/GameDeck
// model → end-season promo/relegation), carrying ratings forward with roster
// churn. The final season is left ACTIVE. ADMIN_TOKEN-gated.
//
// Body (all optional): {
//   seasons?: number,        // default 1
//   players?: number,        // default 12
//   divisions?: number,      // explicit count; else derived from divisionSize
//   divisionSize?: number,   // default 6
//   churn?: number,          // 0..0.9, default 0.1
//   playFraction?: number,   // 0..1, default 0.8
//   activateEach?: boolean,  // each season passes through ACTIVE (no Discord)
//   reset?: boolean          // nuke prior "E2E Demo" data first
// }

import { NextRequest, NextResponse } from "next/server";
import { AdminTokenError, requireAdminToken } from "@/lib/admin-token";
import { runSeedE2E, type SeedE2EOptions } from "@/lib/seed-e2e";

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
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

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // empty body is fine — all options default
  }

  const opts: SeedE2EOptions = {
    seasons: num(body.seasons),
    players: num(body.players),
    divisions: num(body.divisions),
    divisionSize: num(body.divisionSize),
    churn: num(body.churn),
    playFraction: num(body.playFraction),
    activateEach: body.activateEach === true,
    realDiscordEach: body.realDiscordEach === true,
    announce: body.announce === true,
    reset: body.reset === true,
  };

  // Background mode: kick the seed off without awaiting and return now. For
  // long runs (many seasons, realDiscordEach waits on the bot per season) the
  // request would otherwise stay open for tens of minutes. The work continues
  // in the web process; watch the bot/web logs for progress. Best-effort — no
  // durability, so a redeploy mid-run stops it (fine for a test env).
  if (body.background === true) {
    void runSeedE2E(opts, ctx.actor).catch((err) =>
      console.error("[seed-e2e:background] failed:", err),
    );
    return NextResponse.json({ ok: true, started: true, background: true, opts });
  }

  try {
    const result = await runSeedE2E(opts, ctx.actor);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

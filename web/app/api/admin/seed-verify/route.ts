// Ops-script endpoint for the local verify-env: seeds a production-shaped
// dataset (4 tiers, 13 divisions, a finished+archived season, net-lives
// tiebreak, a deterministic points-tie) in one curl. ADMIN_TOKEN-gated, same
// pattern as /api/admin/seed-e2e. See web/lib/seed-verify.ts and
// web/scripts/verify-env.mjs (the caller).
//
// Body (all optional): {
//   players?: number,      // default 80 (owenLadder -> 13 divisions)
//   openSignups?: boolean,  // default true
//   reset?: boolean         // default true
// }

import { NextRequest, NextResponse } from "next/server";
import { AdminTokenError, requireAdminToken } from "@/lib/admin-token";
import { runSeedVerify, type SeedVerifyOptions } from "@/lib/seed-verify";

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
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

  const opts: SeedVerifyOptions = {
    players: num(body.players),
    openSignups: bool(body.openSignups),
    reset: bool(body.reset),
  };

  try {
    const result = await runSeedVerify(opts, ctx.actor);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

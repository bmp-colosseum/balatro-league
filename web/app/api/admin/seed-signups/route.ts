// Seed a CLOSED signup round + N fake signups so you can test the build flow.
// ADMIN_TOKEN-gated. Test env only.
//
// Body (all optional): { count?: number (default 24), reset?: boolean }
// Returns { ok, roundId, count, buildPath } — open buildPath to do the build.

import { NextRequest, NextResponse } from "next/server";
import { AdminTokenError, requireAdminToken } from "@/lib/admin-token";
import { runSeedSignups } from "@/lib/seed-signups";

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

  try {
    const result = await runSeedSignups({ count: num(body.count), reset: body.reset === true });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

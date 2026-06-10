// TEST-ONLY auth bypass for Playwright E2E. Forges a NextAuth session cookie so
// tests can act as an admin without the Discord OAuth dance. Hard-gated on
// E2E_TEST_MODE — returns 404 unless explicitly enabled (never set in prod).

import { encode } from "next-auth/jwt";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  if (process.env.E2E_TEST_MODE !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { discordId?: string; name?: string };
  const discordId = body.discordId ?? process.env.LEAGUE_OWNER_DISCORD_ID ?? "e2e-owner";
  const name = body.name ?? "E2E Admin";

  const token = await encode({
    token: { discordId, username: name, name, sub: discordId },
    secret: process.env.AUTH_SECRET!,
    salt: "authjs.session-token",
  });

  const jar = await cookies();
  jar.set("authjs.session-token", token, { httpOnly: true, sameSite: "lax", path: "/" });
  return NextResponse.json({ ok: true, discordId });
}

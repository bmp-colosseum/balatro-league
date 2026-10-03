// Liveness probe for the rolling league-web-a/league-web-b deploy. The Dockerfile's own
// HEALTHCHECK polls this every 10s; the deploy workflow polls the container's derived
// Docker health status before moving on to the next copy (see
// .github/workflows/deploy.yml). Deliberately NOT behind admin auth and NOT rate limited
// -- it must stay reachable from inside the box's docker network with no session/token.
//
// The DB ping gets ONE retry after 500ms before answering 503: Team Tour's /api/health
// (apps/tour/app/api/health/route.ts, the model for this endpoint) returned a spurious
// 503 on a single slow ping while a neighbouring migration was running, which is exactly
// the kind of blip this rolling deploy must tolerate rather than fail a healthy copy over.
import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildHealthResult } from "@/lib/health-core";

export const dynamic = "force-dynamic";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pingDb(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    await delay(500);
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}

// Drain flag for the rolling deploy: the workflow touches this file inside the OLD copy and
// waits two Traefik health intervals before recreating it, so Traefik has already taken the
// copy out of rotation when the container stops (no 502s mid-roll). The recreated container
// has a fresh filesystem, so the flag clears itself on the new copy.
const DRAIN_FLAG_PATH = "/tmp/league-web.drain";

export async function GET(): Promise<NextResponse> {
  if (existsSync(DRAIN_FLAG_PATH)) {
    return NextResponse.json({ status: "draining" }, { status: 503 });
  }
  const dbReachable = await pingDb();

  const result = buildHealthResult({
    dbReachable,
    sha: process.env.LEAGUE_WEB_SHA ?? "unknown",
    uptimeSeconds: process.uptime(),
  });

  return NextResponse.json(result.body, { status: result.status });
}

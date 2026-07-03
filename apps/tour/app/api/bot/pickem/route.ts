// Bot write endpoint: record a pick'em prediction on behalf of the interacting Discord
// user (the bot vouches for the id — pick'em is open to any signed-in user, same as the
// site). Bearer TOUR_ADMIN_TOKEN. The service enforces the lock-at-start rule.
import { NextResponse } from "next/server";
import { isApiAdmin } from "@/lib/auth";
import { makePick } from "@/lib/services/pickem";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await isApiAdmin(req))) return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  let body: { discordId?: string; name?: string; setId?: string; pickedPlayerId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.discordId || !body.setId || !body.pickedPlayerId) {
    return NextResponse.json({ error: "discordId, setId, pickedPlayerId required" }, { status: 400 });
  }
  try {
    await makePick(body.discordId, body.name ?? null, body.setId, body.pickedPlayerId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "pick failed" }, { status: 400 });
  }
}

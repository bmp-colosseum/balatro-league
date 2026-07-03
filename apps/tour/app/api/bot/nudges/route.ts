// Bot endpoint: the deadline-nudge DM list (current week's unpaired matchups + unplayed/
// unconfirmed sets). The bot's Friday/Sunday crons GET this and DM each entry.
// Bearer TOUR_ADMIN_TOKEN.
import { NextResponse } from "next/server";
import { isApiAdmin } from "@/lib/auth";
import { nudgeList } from "@/lib/services/nudges";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await isApiAdmin(req))) return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  return NextResponse.json({ nudges: await nudgeList() });
}

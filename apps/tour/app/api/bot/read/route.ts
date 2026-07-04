// Bot read endpoint for the /ppt commands — one route, `kind` param, so C4 doesn't sprawl
// across files. Bearer TOUR_ADMIN_TOKEN.
//   ?kind=standings[&season=]        — conference standings
//   ?kind=schedule[&season=][&week=] — a week's matchups (default: latest)
//   ?kind=bracket[&season=]          — playoff bracket / champion run
//   ?kind=mymatch&discordId=         — the invoker's outstanding sets
//   ?kind=pickem&discordId=[&season=]— open pick'em sets + the viewer's picks
import { NextResponse } from "next/server";
import { isApiAdmin } from "@/lib/auth";
import { resolveSeasonName, botStandings, botSchedule, botBracket, botMyMatch, botFantasy } from "@/lib/services/bot-read";
import { getSeasonPickem } from "@/lib/services/pickem";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await isApiAdmin(req))) return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const seasonParam = url.searchParams.get("season");
  const season = await resolveSeasonName(seasonParam);

  if (kind === "mymatch") {
    const discordId = url.searchParams.get("discordId") ?? "";
    if (!discordId) return NextResponse.json({ error: "discordId required" }, { status: 400 });
    return NextResponse.json(await botMyMatch(discordId));
  }
  if (!season) return NextResponse.json({ error: "no season" }, { status: 404 });

  if (kind === "standings") {
    const data = await botStandings(season);
    return data ? NextResponse.json(data) : NextResponse.json({ error: "no standings" }, { status: 404 });
  }
  if (kind === "schedule") {
    const weekRaw = url.searchParams.get("week");
    const week = weekRaw != null ? Number(weekRaw) : null;
    const data = await botSchedule(season, Number.isFinite(week) ? week : null);
    return data ? NextResponse.json(data) : NextResponse.json({ error: "no schedule" }, { status: 404 });
  }
  if (kind === "bracket") {
    const data = await botBracket(season);
    return data ? NextResponse.json(data) : NextResponse.json({ error: "no bracket" }, { status: 404 });
  }
  if (kind === "fantasy") {
    const data = await botFantasy(season);
    return data ? NextResponse.json(data) : NextResponse.json({ error: "no fantasy league" }, { status: 404 });
  }
  if (kind === "pickem") {
    const discordId = url.searchParams.get("discordId") ?? "";
    const data = await getSeasonPickem(season, discordId || null);
    if (!data) return NextResponse.json({ error: "no season" }, { status: 404 });
    // Only open sets are actionable from Discord; trim the payload.
    const open = data.weeks.flatMap((w) => w.sets.filter((s) => !s.locked).map((s) => ({ ...s, week: w.week })));
    return NextResponse.json({ seasonName: season, open, urlPath: `/seasons/${encodeURIComponent(season)}/pickem` });
  }
  return NextResponse.json({ error: "unknown kind" }, { status: 400 });
}

// Deploy diagnostics — does the running container have what it needs? Reports the
// PRESENCE (never the value) of each env var, a live DB reachability check, and the
// signed-in viewer's resolved identity + tier — so "I deployed but I'm not admin"
// and "login won't work" are debuggable in the browser, not just the Railway logs.
import { prisma } from "./db";
import { getViewer } from "./auth";
import { leagueDbConfigured, leaguePlayersLive, leagueGuildMemberCount } from "./league-db";

type Level = "ok" | "warn" | "error" | "info";

export interface VarRow {
  key: string;
  set: boolean;
  level: Level;
  note: string;
}

const present = (k: string) => {
  const v = process.env[k];
  return typeof v === "string" && v.trim().length > 0;
};

export async function getEnvHealth() {
  const prod = process.env.NODE_ENV === "production";
  const ownerListSet = present("TOUR_OWNER_DISCORD_IDS");
  const devAdmin = process.env.TOUR_DEV_ADMIN === "1";

  const vars: VarRow[] = [
    { key: "DATABASE_URL", set: present("DATABASE_URL"), level: present("DATABASE_URL") ? "ok" : "error", note: "the Tour's own Postgres" },
    { key: "DISCORD_CLIENT_ID", set: present("DISCORD_CLIENT_ID"), level: present("DISCORD_CLIENT_ID") ? "ok" : "error", note: "login (same as the league)" },
    { key: "DISCORD_CLIENT_SECRET", set: present("DISCORD_CLIENT_SECRET"), level: present("DISCORD_CLIENT_SECRET") ? "ok" : "error", note: "login (same as the league)" },
    { key: "AUTH_SECRET", set: present("AUTH_SECRET"), level: present("AUTH_SECRET") ? "ok" : "error", note: "signs the session — must match the league for shared SSO" },
    { key: "AUTH_COOKIE_DOMAIN", set: present("AUTH_COOKIE_DOMAIN"), level: present("AUTH_COOKIE_DOMAIN") ? "ok" : "info", note: "set to .balatroleague.com for shared SSO; unset = standalone login (fine for first test)" },
    { key: "TOUR_OWNER_DISCORD_IDS", set: ownerListSet, level: ownerListSet || devAdmin ? "ok" : "warn", note: "your Discord id → OWNER admin (without it + no dev bypass, NOBODY is admin)" },
    { key: "TOUR_DEV_ADMIN", set: devAdmin, level: prod && devAdmin ? "error" : "info", note: prod ? "MUST be unset in prod (it bypasses auth)" : "local dev admin bypass" },
    { key: "TOUR_GUILD_ID", set: present("TOUR_GUILD_ID"), level: "info", note: "optional — resolves tiers via Discord roles (identity uses the league's shared-guild roster instead)" },
    { key: "TOUR_DISCORD_TOKEN", set: present("TOUR_DISCORD_TOKEN"), level: "info", note: "optional — only the bot needs it (Phase C)" },
    { key: "NEXT_PUBLIC_LEAGUE_URL", set: present("NEXT_PUBLIC_LEAGUE_URL"), level: "info", note: "optional — defaults to https://balatroleague.com" },
  ];

  // Live DB reachability.
  let db: { reachable: boolean; error?: string };
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = { reachable: true };
  } catch (e) {
    db = { reachable: false, error: e instanceof Error ? e.message.split("\n")[0] : "unknown error" };
  }

  const viewer = await getViewer();
  const myId = viewer.discordId;
  const inOwnerList = !!myId && (process.env.TOUR_OWNER_DISCORD_IDS ?? "").split(",").map((s) => s.trim()).includes(myId);

  // Headline issues.
  const warnings: string[] = [];
  if (!db.reachable) warnings.push(`Database not reachable: ${db.error ?? ""}`);
  if (!present("AUTH_SECRET")) warnings.push("AUTH_SECRET missing — login/sessions won't work.");
  if (!present("DISCORD_CLIENT_ID") || !present("DISCORD_CLIENT_SECRET")) warnings.push("Discord OAuth creds missing — login won't work.");
  if (prod && devAdmin) warnings.push("TOUR_DEV_ADMIN=1 in production — this bypasses auth; remove it.");
  if (!ownerListSet && !devAdmin) warnings.push("No admins configured — set TOUR_OWNER_DISCORD_IDS to your Discord id.");
  if (viewer.authenticated && myId && ownerListSet && viewer.tier !== "OWNER" && viewer.tier !== "TO" && !inOwnerList) {
    warnings.push(`You're signed in as ${myId} but that id isn't in TOUR_OWNER_DISCORD_IDS — add it (comma-separated) to get admin.`);
  }

  // Live league-DB connection (optional, read-only) — powers always-current identity linking.
  let leagueDb: { configured: boolean; reachable: boolean; players: number | null };
  if (leagueDbConfigured()) {
    try {
      const rows = await leaguePlayersLive();
      leagueDb = { configured: true, reachable: true, players: rows?.length ?? 0 };
    } catch (e) {
      leagueDb = { configured: true, reachable: false, players: null };
      warnings.push(`LEAGUE_DATABASE_URL set but the league DB read failed: ${e instanceof Error ? e.message.split("\n")[0] : ""}`);
    }
  } else {
    leagueDb = { configured: false, reachable: false, players: null };
  }

  // Shared-guild roster from the league (GuildMember table) — the username->id source
  // for resolving tour-only members. null count = table/grant not there yet.
  const guildRoster = { members: leagueDbConfigured() ? await leagueGuildMemberCount() : null };

  return {
    nodeEnv: process.env.NODE_ENV ?? "(unset)",
    vars,
    db,
    leagueDb,
    guildRoster,
    viewer: { authenticated: viewer.authenticated, discordId: myId, tier: viewer.tier, inOwnerList, playerId: viewer.playerId },
    warnings,
  };
}

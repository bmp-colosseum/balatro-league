// DESTRUCTIVE: wipes every gameplay row in the target environment's
// database. Hits POST /api/admin/wipe-test-data which checks
// ALLOW_DESTRUCTIVE_WIPE=true on the web service before doing anything,
// so this script is a footgun-resistant nuke for the test environment.
//
// Optional --include-discord ALSO wipes the Discord-side state
// (league channels, categories, roles) via a separate endpoint. Lets
// you start the entire creation flow from scratch — DB blank, Discord
// blank — to validate bootstrap + season creation end-to-end.
//
// Auth: ADMIN_TOKEN env var (must match the web service's value).
// Defaults to local dev URL; override with --url or WEB_URL env.
//
// Usage:
//   ADMIN_TOKEN=xxx WEB_URL=https://balatro-league-test... \
//     npm run wipe:test-env -- --i-know-what-im-doing
//   # add --include-discord to also nuke the test guild's bot artifacts
//
// The --i-know-what-im-doing flag is a third client-side gate on top
// of the server's env + confirmation checks. Without it the script
// prints the warning and exits without calling the endpoint.

interface Args {
  webUrl: string;
  confirmed: boolean;
  includeDiscord: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string | null): string | null => {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx === argv.length - 1) return def;
    return argv[idx + 1] ?? def;
  };
  const webUrl = get("--url", null) ?? process.env.WEB_URL ?? "http://localhost:3000";
  const confirmed = argv.includes("--i-know-what-im-doing");
  const includeDiscord = argv.includes("--include-discord");
  return { webUrl, confirmed, includeDiscord };
}

async function callEndpoint(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, parsed);
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const { webUrl, confirmed, includeDiscord } = parseArgs();
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    console.error("ADMIN_TOKEN env var is required — set the same value that's on the web service");
    process.exit(1);
  }

  if (!confirmed) {
    console.error("");
    console.error("⚠  This will WIPE EVERY GAMEPLAY ROW in the target database.");
    console.error("    target = " + webUrl);
    console.error("");
    console.error("    Tables wiped: Player, Season, Tier, Division, DivisionMember,");
    console.error("                  Pairing, Shootout, MatchSession, Signup, SignupRound,");
    console.error("                  PlayerMmrSnapshot, DivisionStandings, EasterEggVote,");
    console.error("                  SeasonInterest");
    console.error("");
    console.error("    Preserved:    LeagueConfig, RoleBinding, TierTemplate,");
    console.error("                  MatchConfigPreset, LeagueRulesTemplate, AdminAuditEvent");
    if (includeDiscord) {
      console.error("");
      console.error("    --include-discord ALSO present → will additionally wipe Discord-side:");
      console.error("      League categories + channels (🃏 Balatro League, 🎴 Matches,");
      console.error("      per-season categories, archive categories, all contents)");
      console.error("      League roles (League *, Season N · *, 🏆 ... Champion)");
      console.error("      LeagueConfig channel ID keys + RoleBinding rows");
      console.error("      Division.discordRoleId/ChannelId + Season.discordCategoryId");
    }
    console.error("");
    console.error("    Re-run with --i-know-what-im-doing to actually do it.");
    console.error("    (The web service must also have ALLOW_DESTRUCTIVE_WIPE=true set.)");
    process.exit(2);
  }

  const base = webUrl.replace(/\/$/, "");

  // Order matters: do Discord first if requested, then DB. Reverse
  // order would orphan the Discord channel IDs (DB cleared, channels
  // still exist) — admin would have no record of what to delete next
  // time. Discord-first means if the Discord part fails the DB still
  // has the IDs and we can retry.
  if (includeDiscord) {
    console.log(`POST ${base}/api/admin/wipe-discord`);
    const dResult = await callEndpoint(`${base}/api/admin/wipe-discord`, token, {
      confirm: "WIPE TEST ENV",
    });
    console.log("Discord wipe OK:", dResult);
  }

  console.log(`POST ${base}/api/admin/wipe-test-data`);
  const dbResult = await callEndpoint(`${base}/api/admin/wipe-test-data`, token, {
    confirm: "WIPE TEST ENV",
  });
  console.log("DB wipe OK:", dbResult);
}

await main();

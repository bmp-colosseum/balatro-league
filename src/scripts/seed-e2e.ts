// End-to-end demo in ONE command. Drives the REAL season lifecycle over
// the admin API endpoints (the same cores the admin UI uses) — no parallel
// reimplementation of build/end logic:
//
//   per season:  fake signups (prisma fixtures)
//                → POST /api/admin/build-season   (real placement)
//                → seedTestMatches()              (realistic GameState)
//                → POST /api/admin/end-season     (re-rank: promo/relegation)
//
// With --seasons N it runs the loop N times, carrying ratings forward so
// each season's standings feed the next season's tiers — exactly the
// promotion/relegation drift you'd see over a real league's lifetime. The
// roster churns each season (a few players drop, a few new ones join), so
// you also exercise new-player intake and "previous season" history views.
//
// The FINAL season is left ACTIVE and in-progress (built + matches, not
// ended) so you land on a live season with N-1 completed seasons behind it.
//
// Needs the web service reachable + ADMIN_TOKEN (same token the web service
// has). Defaults to local dev; override with --url or WEB_URL.
//
// Everything is tagged so --reset nukes exactly the demo data:
//   players  discordId "e2e-…"   round name "E2E Demo …"   season subtitle "E2E Demo …"
//
// Usage:
//   ADMIN_TOKEN=xxx npm run seed:e2e                              # 1 season, 12 players
//   ADMIN_TOKEN=xxx npm run seed:e2e -- --seasons 50              # 50-season history
//   ADMIN_TOKEN=xxx npm run seed:e2e -- --seasons 100 --players 24 --divisions 4
//   ADMIN_TOKEN=xxx WEB_URL=https://balatro-league-test... npm run seed:e2e -- --seasons 25
//   ADMIN_TOKEN=xxx npm run seed:e2e -- --seasons 30 --activate-each  # each season goes live then ends
//   ADMIN_TOKEN=xxx npm run seed:e2e -- --players 1000 --seasons 100  # big scale / perf run
//   ADMIN_TOKEN=xxx npm run seed:e2e -- --players 1000 --division-size 6  # ~167 small divisions
//   npm run seed:e2e -- --reset                                   # nuke prior e2e demos first
//
// Scale: divisions auto-derive from --division-size (default 6) so a large
// --players count produces many SMALL divisions (tractable round-robins)
// instead of a few enormous ones. --divisions still forces an exact count.

import { prisma } from "../db.js";
import { seedTestMatches } from "../seed-matches-core.js";

const DEMO_SUBTITLE = "E2E Demo";

interface Args {
  players: number;
  divisions: number; // 0 = auto-derive from divisionSize
  divisionSize: number;
  seasons: number;
  churn: number;
  reset: boolean;
  activateEach: boolean;
  webUrl: string;
  playFraction: number | undefined;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const num = (flag: string, def: number) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1]!, 10) || def : def;
  };
  const flt = (flag: string, def: number) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? parseFloat(argv[i + 1]!) || def : def;
  };
  const str = (flag: string, def: string | null): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
  };
  const playRaw = str("--play", null);
  return {
    players: Math.max(2, num("--players", 12)),
    divisions: num("--divisions", 0), // 0 → derive from --division-size
    divisionSize: Math.max(2, num("--division-size", 6)),
    seasons: Math.max(1, num("--seasons", 1)),
    churn: Math.min(0.9, Math.max(0, flt("--churn", 0.1))),
    reset: argv.includes("--reset"),
    activateEach: argv.includes("--activate-each"),
    webUrl: (str("--url", null) ?? process.env.WEB_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    playFraction: playRaw != null ? parseFloat(playRaw) : undefined,
  };
}

// Deterministic PRNG so a given run is reproducible.
function makeRng(seedStr: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Remove exactly the demo data: e2e seasons (+ their gameplay rows and
// memberships), the demo signup rounds + signups, and e2e-* players.
async function resetDemos(): Promise<void> {
  const seasons = await prisma.season.findMany({
    where: { subtitle: { startsWith: DEMO_SUBTITLE } },
    select: { id: true, divisions: { select: { id: true } } },
  });
  const seasonIds = seasons.map((s) => s.id);
  const divIds = seasons.flatMap((s) => s.divisions.map((d) => d.id));
  if (divIds.length) {
    await prisma.matchSession.deleteMany({ where: { divisionId: { in: divIds } } });
    await prisma.pairing.deleteMany({ where: { divisionId: { in: divIds } } });
    await prisma.shootout.deleteMany({ where: { divisionId: { in: divIds } } });
    await prisma.divisionStandings.deleteMany({ where: { divisionId: { in: divIds } } });
  }
  if (seasonIds.length) {
    await prisma.divisionMember.deleteMany({ where: { seasonId: { in: seasonIds } } });
    await prisma.division.deleteMany({ where: { seasonId: { in: seasonIds } } });
    await prisma.tier.deleteMany({ where: { seasonId: { in: seasonIds } } });
    await prisma.season.deleteMany({ where: { id: { in: seasonIds } } });
  }
  await prisma.signup.deleteMany({ where: { discordId: { startsWith: "e2e-" } } });
  await prisma.signupRound.deleteMany({ where: { name: { startsWith: DEMO_SUBTITLE } } });
  await prisma.player.deleteMany({ where: { discordId: { startsWith: "e2e-" } } });
  console.log(`[reset] cleared ${seasonIds.length} demo season(s) + e2e rounds/players`);
}

interface BuildResponse {
  ok?: boolean;
  error?: string;
  seasonId?: string;
  seasonNumber?: number;
  divisionCount?: number;
  playersPlaced?: number;
  activated?: boolean;
}

async function postJson(url: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text };
  }
  return { status: res.status, json };
}

interface Roster {
  discordId: string;
  displayName: string;
}

// Returners for the next season = the active members of the season just
// completed, minus a churn-sized random dropout, plus the same number of
// brand-new players appended at the bottom of the rankings.
async function nextRoster(
  prevSeasonId: string,
  churn: number,
  rng: () => number,
  allocId: () => number,
): Promise<Roster[]> {
  const members = await prisma.divisionMember.findMany({
    where: { seasonId: prevSeasonId, status: "ACTIVE" },
    include: { player: { select: { discordId: true, displayName: true, rating: true } } },
  });
  const returners = members
    .map((m) => m.player)
    .sort((a, b) => (a.rating ?? 1e9) - (b.rating ?? 1e9));

  const keepMin = Math.max(3, returners.length - Math.floor(returners.length * churn));
  // Randomly drop down to keepMin (drop weighted slightly toward the bottom
  // by shuffling all and slicing — simple + good enough for demo churn).
  const shuffled = returners.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const kept = shuffled.slice(0, keepMin);
  const dropCount = returners.length - kept.length;

  // New players replace the dropped ones (population stays constant). Give
  // them ratings just past the current max so they seed into the bottom tier.
  const maxRating = kept.reduce((mx, p) => Math.max(mx, p.rating ?? 0), 0);
  const newcomers: Roster[] = [];
  for (let k = 0; k < dropCount; k++) {
    const idx = allocId();
    const discordId = `e2e-${idx}`;
    const displayName = `Demo Player ${idx + 1}`;
    await prisma.player.upsert({
      where: { discordId },
      create: { discordId, displayName, rating: maxRating + 1 + k },
      update: { displayName, rating: maxRating + 1 + k },
    });
    newcomers.push({ discordId, displayName });
  }

  return [...kept.map((p) => ({ discordId: p.discordId, displayName: p.displayName })), ...newcomers];
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.reset) await resetDemos();

  const token = process.env.ADMIN_TOKEN;
  if (!token || token.length < 16) {
    console.error("ADMIN_TOKEN env var is required (must match the web service's value).");
    process.exit(1);
  }

  const rng = makeRng("e2e-loop");
  // Monotonic id allocator so churned-in players never reuse a discordId.
  let idCounter = 0;
  const allocId = () => idCounter++;

  // Season 1 roster: a fresh population, ranked 1..P.
  let roster: Roster[] = [];
  for (let i = 0; i < args.players; i++) {
    const idx = allocId();
    const discordId = `e2e-${idx}`;
    const displayName = `Demo Player ${idx + 1}`;
    await prisma.player.upsert({
      where: { discordId },
      create: { discordId, displayName, rating: idx + 1 },
      update: { displayName, rating: idx + 1 },
    });
    roster.push({ discordId, displayName });
  }

  // Division count: explicit --divisions wins, else derive from a target
  // size so big leagues get many small divisions (a 1000-player league in 2
  // divisions would be a 500-player round-robin — ~125k pairs each).
  const divisions =
    args.divisions > 0 ? args.divisions : Math.max(1, Math.round(args.players / args.divisionSize));
  console.log(
    `[plan] ${args.players} players · ${divisions} divisions (~${Math.round(args.players / divisions)}/div) · ` +
      `${args.seasons} season(s)`,
  );

  const tStart = Date.now();
  let totalMatches = 0;
  let totalGames = 0;
  let totalShootouts = 0;

  let prevSeasonId: string | null = null;
  let lastLabel = "";

  for (let s = 1; s <= args.seasons; s++) {
    const seasonStart = Date.now();
    const isLast = s === args.seasons;
    if (prevSeasonId) {
      roster = await nextRoster(prevSeasonId, args.churn, rng, allocId);
    }

    // Fixtures: a CLOSED signup round with this season's roster.
    const round = await prisma.signupRound.create({
      data: {
        name: `${DEMO_SUBTITLE} round (loop ${s})`,
        guildId: "e2e-guild",
        channelId: "e2e-channel",
        messageId: "pending",
        status: "CLOSED",
        closedAt: new Date(),
      },
    });
    await prisma.signup.createMany({
      data: roster.map((r) => ({
        roundId: round.id,
        discordId: r.discordId,
        displayName: r.displayName,
        signedUpAt: new Date(),
      })),
    });

    // Build via the REAL endpoint.
    //   default:          only the final season goes ACTIVE; intermediate
    //                     ones are built then ended (completed history).
    //   --activate-each:  every season also passes through ACTIVE before
    //                     being ended — the full real lifecycle. Intermediate
    //                     activations skip the Discord bootstrap/announce
    //                     (skipDiscordSetup) so we don't churn 100× channels;
    //                     only the final live season sets Discord up for real.
    const activate = isLast || args.activateEach;
    const build = await postJson(`${args.webUrl}/api/admin/build-season`, token, {
      roundId: round.id,
      subtitle: `${DEMO_SUBTITLE} #${s}`,
      config: [{ name: "Rare", divisionCount: divisions }],
      targetGroupSize: Math.max(2, Math.ceil(roster.length / divisions)),
      activate,
      skipDiscordSetup: activate && !isLast,
    });
    const b = build.json as BuildResponse;
    if (build.status !== 200 || !b.ok || !b.seasonId) {
      console.error(`[loop ${s}] build failed (HTTP ${build.status}):`, b.error ?? build.json);
      console.error(`(Is the web service running at ${args.webUrl} with a matching ADMIN_TOKEN?)`);
      process.exit(1);
    }

    // Matches: fabricate realistic GameState in-process.
    const m = await seedTestMatches({ seasonId: b.seasonId, playFraction: args.playFraction });
    lastLabel = m.seasonLabel;

    if (!isLast) {
      // End the season: re-rank (promo/relegation) so ratings carry forward.
      const end = await postJson(`${args.webUrl}/api/admin/end-season`, token, { seasonId: b.seasonId });
      if (end.status !== 200 || !end.json?.ok) {
        console.error(`[loop ${s}] end-season failed (HTTP ${end.status}):`, end.json?.error ?? end.json);
        process.exit(1);
      }
    }

    totalMatches += m.pairingsMade;
    totalGames += m.gamesMade;
    totalShootouts += m.shootoutsMade;
    console.log(
      `[season ${s}/${args.seasons}] ${m.seasonLabel} — ${roster.length} players, ` +
        `${b.divisionCount} divs, ${m.pairingsMade} matches, ${m.dcGames} DCs` +
        (isLast ? " — ACTIVE" : " — ended") +
        ` (${((Date.now() - seasonStart) / 1000).toFixed(1)}s)`,
    );
    prevSeasonId = b.seasonId;
  }

  const elapsed = (Date.now() - tStart) / 1000;
  console.log(
    `\n✅ ${args.seasons} season(s) in ${elapsed.toFixed(1)}s (${(elapsed / args.seasons).toFixed(1)}s/season) — ` +
      `${totalMatches} matches, ${totalGames} games, ${totalShootouts} shootouts written.`,
  );
  console.log(`${lastLabel} is ACTIVE; the prior ${args.seasons - 1} are completed history.`);
  console.log("Explore: /standings · /stats · a player profile (career arc + per-season history + traits).");
  process.exit(0);
}

await main();

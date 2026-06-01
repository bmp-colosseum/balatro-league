// Thin HTTP client over POST /api/admin/finish-season. The endpoint
// does the actual work — this script just parses args, makes the
// call, and prints the result. Same code path as a hypothetical
// admin UI button would use.
//
// Auth: ADMIN_TOKEN env var (must match the value set on the web
// service). Defaults to local dev URL; override with --url.
//
// Usage:
//   ADMIN_TOKEN=xxx WEB_URL=https://balatro-league-test... \
//     node dist/scripts/finish-season.js --season <id> [--seed N] [--announce]

interface Args {
  seasonId: string;
  seed: number | undefined;
  announce: boolean;
  webUrl: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string | null): string | null => {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx === argv.length - 1) return def;
    return argv[idx + 1] ?? def;
  };
  const seasonId = get("--season", null);
  if (!seasonId) {
    console.error("--season <id> is required");
    process.exit(1);
  }
  const seedRaw = get("--seed", null);
  const seed = seedRaw ? Number(seedRaw) : undefined;
  const announce = argv.includes("--announce");
  const webUrl = get("--url", null) ?? process.env.WEB_URL ?? "http://localhost:3000";
  return { seasonId, seed, announce, webUrl };
}

async function main(): Promise<void> {
  const { seasonId, seed, announce, webUrl } = parseArgs();
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    console.error("ADMIN_TOKEN env var is required — set the same value that's on the web service");
    process.exit(1);
  }

  const url = `${webUrl.replace(/\/$/, "")}/api/admin/finish-season`;
  console.log(`POST ${url}`);
  console.log(`  seasonId=${seasonId} seed=${seed ?? "(default)"} announce=${announce}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ seasonId, seed, announce }),
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, body);
    process.exit(1);
  }
  console.log("OK:", body);
}

await main();

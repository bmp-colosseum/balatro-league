#!/usr/bin/env node
// Local verify environment: an embedded Postgres on a dynamically-picked free
// port, a real production `next build` + `next start` on another free port,
// seeded with a production-shaped dataset (web/lib/seed-verify.ts) — so an
// agent can prove a change with a screenshot/measurement without production
// DB access (the sandbox can't reach it anyway; see .claude/skills/verify).
//
// Usage (from web/):
//   node scripts/verify-env.mjs &            (or Bash tool run_in_background)
//                                             build + boot + seed, prints
//                                             VERIFY_URL=http://localhost:<port>,
//                                             then blocks forever -- it IS the
//                                             server supervisor, not a one-shot.
//   node scripts/verify-env.mjs --skip-build  reuse the existing .next build
//   node scripts/verify-env.mjs --players 60 --no-open-signups --no-reset
//   node scripts/verify-env.mjs --stop        tear down by the PID THIS
//                                             script's own process has (reads
//                                             .verify-env-state.json, then
//                                             `taskkill /pid <it> /f /t`) --
//                                             never a system-wide kill.
//
// Why it blocks instead of daemonizing: embedded-postgres spawns its Postgres
// child as a normal (non-detached) child process. On Windows that child's
// lifetime is tied to this script's process — if this process exits (even via
// a deliberate process.exit after printing the URL), Postgres dies with it
// and `next start` is left orphaned pointing at a dead DB. Empirically
// verified while building this script. So: run this file itself in the
// background (Bash tool's run_in_background, or `&`), don't daemonize it.

import EmbeddedPostgres from "embedded-postgres";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, openSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findFreePort } from "./lib/get-free-port.mjs";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_DIR = resolve(WEB_DIR, "..");
const STATE_FILE = resolve(WEB_DIR, ".verify-env-state.json");
const LOG_FILE = resolve(WEB_DIR, ".verify-env.log");
const ADMIN_TOKEN = "verify-env-admin-token-0123456789";

function parseArgs(argv) {
  const opts = { stop: false, skipBuild: false, players: undefined, openSignups: undefined, reset: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stop") opts.stop = true;
    else if (a === "--skip-build") opts.skipBuild = true;
    else if (a === "--players") opts.players = Number(argv[++i]);
    else if (a === "--open-signups") opts.openSignups = true;
    else if (a === "--no-open-signups") opts.openSignups = false;
    else if (a === "--reset") opts.reset = true;
    else if (a === "--no-reset") opts.reset = false;
  }
  return opts;
}

// Targeted, PID-scoped tree kill -- the same mechanism embedded-postgres
// itself uses on Windows to stop its own server. Never a blanket taskkill.
function killPid(pid) {
  if (!pid) return;
  try {
    if (platform() === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // already dead -- fine
  }
}

async function stop() {
  if (!existsSync(STATE_FILE)) {
    console.log("[verify-env] no state file -- nothing to stop");
    return;
  }
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  console.log(`[verify-env] stopping supervisor pid ${state.supervisorPid} (postgres ${state.pgPid}, next ${state.webPid})…`);
  // Killing the supervisor's own PID tree takes its Postgres + Next children
  // with it (taskkill /t walks child PIDs; Windows also ties non-detached
  // child lifetime to the parent). Fall back to killing the children
  // individually too, in case the supervisor already exited on its own.
  killPid(state.supervisorPid);
  killPid(state.pgPid);
  killPid(state.webPid);
  await new Promise((r) => setTimeout(r, 1500)); // let taskkill release file handles before rm
  if (state.pgDataDir) {
    try {
      rmSync(state.pgDataDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[verify-env] could not remove ${state.pgDataDir}: ${err.message}`);
    }
  }
  rmSync(STATE_FILE, { force: true });
  console.log("[verify-env] stopped.");
}

async function waitForUrl(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function start(opts) {
  if (existsSync(STATE_FILE)) {
    const prior = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    console.error(
      `[verify-env] a prior run looks active (supervisor pid ${prior.supervisorPid}). ` +
        `Run with --stop first, or remove ${STATE_FILE} if it's stale.`,
    );
    process.exit(1);
  }

  const pgPort = await findFreePort();
  const webPort = await findFreePort();
  const dbUrl = `postgresql://postgres:postgres@localhost:${pgPort}/verify`;
  const dataDir = mkdtempSync(resolve(tmpdir(), "bl-verify-"));

  console.log(`[verify-env] starting embedded postgres on port ${pgPort} (${dataDir})…`);
  // --encoding=UTF8 --locale=C: embedded-postgres' default initdb on Windows
  // picks up the OS codepage (WIN1252), which then fails to apply any
  // migration whose SQL contains a non-Latin1 character -- e.g. the "↑/↓"
  // arrows quoted straight out of a Prisma schema doc-comment into a
  // generated `COMMENT ON COLUMN` statement. Force UTF8 explicitly.
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port: pgPort,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("verify");
  const pgPid = pg.process?.pid ?? null;

  const sharedEnv = {
    ...process.env,
    DATABASE_URL: dbUrl,
    AUTH_SECRET: "verify-env-test-secret-not-for-prod",
    NEXTAUTH_URL: `http://localhost:${webPort}`,
    DISCORD_TOKEN: "verify-env",
    DISCORD_CLIENT_ID: "0",
    DISCORD_CLIENT_SECRET: "0",
    LEAGUE_OWNER_DISCORD_ID: "verify-env-owner",
    ADMIN_TOKEN,
  };

  try {
    console.log("[verify-env] applying migrations (root prisma, real migration history)…");
    execSync("npx prisma migrate deploy --schema=./prisma/schema.prisma", {
      cwd: ROOT_DIR,
      env: sharedEnv,
      stdio: "inherit",
    });

    if (!opts.skipBuild) {
      console.log("[verify-env] building (next build)…");
      execSync("npx next build", { cwd: WEB_DIR, env: sharedEnv, stdio: "inherit" });
    } else {
      console.log("[verify-env] --skip-build: reusing existing .next build");
    }
  } catch (err) {
    console.error(`[verify-env] setup failed before serving anything: ${err.message}`);
    killPid(pgPid);
    process.exit(1);
  }

  console.log(`[verify-env] starting next start on port ${webPort}…`);
  const nextBin = resolve(WEB_DIR, "node_modules", "next", "dist", "bin", "next");
  const logFd = openSync(LOG_FILE, "a");
  // Deliberately NOT detached -- see the file header. This process (and its
  // run_in_background wrapper) is the supervisor for the whole session.
  const webProcess = spawn(process.execPath, [nextBin, "start", "-p", String(webPort)], {
    cwd: WEB_DIR,
    env: sharedEnv,
    stdio: ["ignore", logFd, logFd],
  });
  const webPid = webProcess.pid;

  const url = `http://localhost:${webPort}`;
  const up = await waitForUrl(url, 120_000);
  if (!up) {
    console.error(`[verify-env] next start did not come up within 120s -- see ${LOG_FILE}`);
    killPid(webPid);
    killPid(pgPid);
    process.exit(1);
  }

  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      { supervisorPid: process.pid, pgPid, webPid, pgDataDir: dataDir, pgPort, webPort, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  );

  console.log("[verify-env] seeding (web/lib/seed-verify.ts via /api/admin/seed-verify)…");
  try {
    const seedRes = await fetch(`${url}/api/admin/seed-verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ players: opts.players, openSignups: opts.openSignups, reset: opts.reset }),
    });
    const seedJson = await seedRes.json();
    if (!seedRes.ok || !seedJson.ok) {
      console.error(`[verify-env] seed failed: ${JSON.stringify(seedJson)} -- server is still up for inspection; --stop when done`);
    } else {
      console.log(`[verify-env] seeded: ${JSON.stringify(seedJson)}`);
    }
  } catch (err) {
    console.error(`[verify-env] seed request failed: ${err.message} -- server is still up for inspection; --stop when done`);
  }

  console.log(`[verify-env] next start log: ${LOG_FILE}`);
  console.log(`VERIFY_URL=${url}`);

  // Block forever -- this process IS the long-lived supervisor. Tear down
  // with `node scripts/verify-env.mjs --stop` from another shell.
  await new Promise(() => {});
}

const opts = parseArgs(process.argv.slice(2));
if (opts.stop) {
  await stop();
} else {
  await start(opts);
}

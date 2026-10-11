# Operations

Deploying, the production box, security scanning, and the Team Tour sibling
repo. `DEPLOY.md` and `DEPLOY-WEB.md` describe the old Railway setup and are
superseded by this page.

Sources: [.github/workflows/deploy.yml](../../.github/workflows/deploy.yml),
[ci.yml](../../.github/workflows/ci.yml),
[security.yml](../../.github/workflows/security.yml),
[uptime.yml](../../.github/workflows/uptime.yml),
[renovate.json](../../renovate.json),
[Dockerfile.league-bot](../../Dockerfile.league-bot),
[web/app/api/health/route.ts](../../web/app/api/health/route.ts),
[src/healthcheck.ts](../../src/healthcheck.ts),
[src/bot-health.ts](../../src/bot-health.ts).

## Where things run

One host, the "Colosseum" box, runs every Balatro service in a shared docker
compose project named `balatro` at `/srv/balatro/repo/infra/compose`. That
compose file, Traefik, the shared Postgres and monitoring belong to the infra
repo (`bmp-colosseum-infra`), not to this one. This repo only advances
`LEAGUE_BOT_TAG` and `LEAGUE_WEB_TAG` in `/srv/balatro/versions.env` and
recreates its own containers.

Containers: `balatro-league-web-a-1`, `balatro-league-web-b-1`,
`balatro-league-bot-1`, `balatro-postgres-1`. Secrets live box-local in
`/srv/balatro/secrets.env` (and `secrets.dev.env` for the `balatro-dev`
project). Nothing in git holds a secret.

## Deploy pipeline

Trigger: push to `master` touching `src/`, `web/`, `prisma/`, the package
files or either Dockerfile; or "Run workflow" with `deploy` ticked (unticked
means build and push only). One deploy at a time (`concurrency: deploy`,
never cancels an in-flight run). Runner: `[self-hosted, balatro]`, which is
the box itself.

Steps:

1. Work out which images changed since the deployed tags and build only
   those: `balatro-league-bot` from `Dockerfile.league-bot`,
   `balatro-league-web` from `web/Dockerfile`. Push to GHCR as `:shortsha`
   and `:latest`.
2. Roll the web, one copy at a time. For `league-web-a` then `league-web-b`:
   if the running image tag differs from the target, touch
   `/tmp/league-web.drain` in the old copy so `/api/health` answers 503 and
   Traefik stops routing to it; wait 12 seconds (two Traefik intervals);
   `docker compose -p balatro ... up -d --no-deps <svc>`; poll the Docker
   health status up to 180 seconds. If a copy does not go healthy,
   `rollback_web` restores the previous `LEAGUE_WEB_TAG`, recreates the web
   services on it and fails the job.
3. Ban-phase guard for the bot: query `MatchSession` for live ban or pick
   states, up to 20 times every 30 seconds, then roll `league-bot` with
   `--no-deps`. The bot has no automatic rollback; a restart is a short
   blip. On boot the bot runs `prisma migrate deploy` then starts
   (`Dockerfile.league-bot` CMD). The web never runs migrations.
4. Best effort: roll `league-web-dev` in the `balatro-dev` project, prune
   images. Neither can fail the job.
5. Verify from outside: curl `https://balatroleague.com` for up to 90
   seconds; on failure dump the web containers' logs and fail.
6. Post the outcome to the devops Discord channel via `DEPLOY_WEBHOOK_URL`
   read from `secrets.env`.

The health gate has three layers: the Dockerfile HEALTHCHECK on each copy,
Traefik only routing to copies whose `/api/health` is 200, and the external
curl. There is no separate chain check beyond these.

### Why `--no-deps` and the drain flag matter

An infra push auto-applies compose changes on the box, so an app `up -d`
without `--no-deps` once recreated Postgres mid-deploy. The drain flag exists
because without it every roll leaked 502s while Traefik still routed to the
dying copy. On 2026-10-03 an unconditional drain flag on a bot-only deploy
left both web copies down for 16 minutes; the tag-difference guard and the
`rm -f` of the flag after `up -d` are the fix. Recovery if it recurs:
`docker exec <copy> rm -f /tmp/league-web.drain`.

### Migration ordering

Web rolls before the bot, so for a few seconds new web code runs against the
old schema. Any web change that reads a new column must tolerate its absence
for that window: land the column in an earlier deploy, make the read
optional, or feature-flag it. Keep migrations additive (expand/contract).

## The prod box rules

1. Never edit code on the box. Everything flows through git and the
   workflow. SSH is for reading logs, checking status and one-off SQL.
2. Reading or fixing data by hand uses `psql` inside the Postgres container.
   The workflow's own example is:

   ```
   docker exec balatro-postgres-1 psql -U postgres -d league -tA -c "SELECT ..."
   ```

   The database is named `league`; the workflow connects as the `postgres`
   superuser. For a longer script, copy the file to the box, then into the
   container, then run it:

   ```
   scp fix.sql box:/tmp/fix.sql
   docker cp /tmp/fix.sql balatro-postgres-1:/tmp/fix.sql
   docker exec balatro-postgres-1 psql -U postgres -d league -f /tmp/fix.sql
   ```

   Nothing in the repo encodes this procedure; it is the organiser's practice.
3. A schema migration that adds a column or table can be pre-applied by hand
   before the push so the web's pre-migration window is harmless. Run it as
   whichever role owns the tables so `prisma migrate deploy` on the bot's
   boot sees it as already applied and does not fight ownership. The repo
   grants only one named role, `tour_ro` (read-only on `GuildMember` for
   Team Tour); it does not define a `league` role. Check `\du` and table
   ownership on the box before assuming a role name.
4. Never run anything with "wipe" in its name on prod (`wipe:test-env`,
   `/api/admin/wipe-*`). See `docs/ops/move-bot-to-new-server.md` for the
   re-home procedure, ignoring its Railway mention.
5. Backups: `src/scripts/backup-db.ts` dumps with `pg_dump` and documents
   the restore (`psql "$DATABASE_URL" -f backups/db-<ts>.sql`);
   `backup-to-bucket.ts` uploads the dump to S3.

## Health and uptime

- Bot: `src/healthcheck.ts` serves `/health` (always 200), `/health/status`
  (200 or 503 with the cached snapshot) and `/metrics`. `src/bot-health.ts`
  ticks every 60 seconds over DB latency, gateway ping, REST error rate,
  queue stalls and discordstatus.com, with debounced ok/degraded/down.
  Transitions post to `#league-devops` and banner `#league-matches`.
- Web: `GET /api/health` returns 503 while the drain file exists, otherwise
  pings the DB (one retry after 500 ms) and returns 200 or 503.
- `uptime.yml` runs on GitHub-hosted runners every 5 minutes (deliberately
  not on the box), curls both domains three times, and on failure posts to
  Discord via `STATUS_WEBHOOK_URL`, mentioning `OWNER_DISCORD_ID`.

## Security and dependencies

- `ci.yml` on every push and PR: Node 24, `npm ci`, typecheck, unit tests,
  integration tests on embedded Postgres.
- `security.yml` on push, PR and Mondays 06:17 UTC: `npm audit --omit=dev
  --audit-level=critical` for the root and `web/`, and CodeQL for
  `javascript-typescript`.
- `renovate.json`: Mondays before 9am New York; minor and patch grouped per
  directory; majors of next, react, next-auth, prisma, discord.js and pg-boss
  get their own PR with a `needs-review` label; automerge for devDependency
  and GitHub Actions minor/patch; Docker digests pinned; OSV alerts on.
  There is no `dependabot.yml`; Dependabot alerts come from GitHub's own
  scanning of the lockfiles and are reviewed on the repo's Security tab.

## Team Tour, the sibling repo

`D:/balatro-team-tour` deploys the same way to the same box and the same
`balatro` compose project (runner label `balatro`, same `versions.env`,
`TOUR_WEB_TAG` and `TOUR_BOT_TAG`, `tour-web-a` and `tour-web-b` behind
Traefik). It reads this league's database read-only through the `tour_ro`
role and shares the Discord sign-in cookie on `.balatroleague.com`.

Its `deploy.yml` has two manual inputs:

- `deploy`: roll the live tour services (unticked = build and push only).
- `preview`: build tour-web and tour-bot from the chosen ref and roll ONLY
  the dev stack (`tour-dev.balatroleague.com` and the test-guild bot). Prod
  is never touched, `:latest` is not moved, and the next push to master puts
  dev back on the prod tags.

As of 2026-10-11 the `preview` input exists on the in-flight branches
(`fix/deps-security`, `feat/shared-fonts-links`) and not yet on Team Tour
`master`, where the dev stack is rolled unconditionally at the end of every
run. Update this paragraph when those branches merge.

The league workflow has no `preview` input; its dev lane is the best-effort
`league-web-dev` roll in step 4.

## Stale documents to be aware of

- `README.md` "Deploying", `DEPLOY.md`, `DEPLOY-WEB.md`: Railway. Superseded.
- `docs/ops/move-bot-to-new-server.md`: says `DATABASE_URL` lives on
  Railway. It lives in `/srv/balatro/secrets.env`. The Discord steps are
  still right.
- `src/healthcheck.ts` header comment mentions Railway's health check.

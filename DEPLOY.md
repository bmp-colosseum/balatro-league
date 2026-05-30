# Deploy to Railway

This walks you through deploying the bot + admin dashboard to Railway with a hosted Postgres database. Estimated time: **20–30 minutes**, most of which is filling forms.

You'll need:
- A GitHub account (the repo will live there)
- A Railway account ([railway.com](https://railway.com), GitHub login works)
- Your Discord application credentials (already in `.env` locally)

---

## Part 1: Push the code to GitHub

```bash
# from D:\BalatroLeague
git init
git add .
git commit -m "Initial commit"
```

Create a **private** repo on github.com (don't include README or .gitignore — we already have both). Then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/balatro-league.git
git branch -M main
git push -u origin main
```

> **Sanity check before pushing**: run `git status` and confirm `.env` is NOT listed. The `.gitignore` should be hiding it. If it's not, **stop and fix the .gitignore** before pushing. Tokens in a git history are extremely hard to fully purge.

---

## Part 2: Set up Railway project + Postgres

1. Go to [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → pick your repo
2. The first build will likely **fail** because there's no database yet and no env vars. That's expected.
3. From the project canvas, click **+ New** → **Database** → **PostgreSQL**. Railway provisions one. It auto-injects `DATABASE_URL` into your service.

### Set the env vars

In the bot service → **Variables** tab → add (paste from your local `.env`):

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Your bot token |
| `DISCORD_CLIENT_ID` | Your application ID |
| `DISCORD_CLIENT_SECRET` | Your OAuth client secret |
| `DISCORD_GUILD_ID` | Your league server ID (or leave blank for global commands — slower to propagate) |
| `LEAGUE_OWNER_DISCORD_ID` | Your Discord user ID |
| `RESULTS_CHANNEL_ID` | Channel ID for auto-announced results (optional) |
| `LEAGUE_ADMIN_ROLE_ID` | Discord role ID for admins (optional — set this once and stop) |
| `ADMIN_DASH_PASSWORD` | A real password (Discord OAuth covers admins, but this is a backup) |
| `SESSION_SECRET` | Run `openssl rand -hex 32` and paste the output (or use any 64-char random string) |
| `DISCORD_OAUTH_REDIRECT` | _Fill this in after deploy — see Part 4_ |

> Don't add `DATABASE_URL` — Railway sets it automatically when you linked the Postgres service.

> Don't add `PORT` — Railway also sets that automatically.

---

## Part 3: Switch from SQLite to Postgres in the code

This is a one-time switch. After this commit, **local development also uses Railway's Postgres** (since you picked that option).

### 3a. Update the Prisma schema

In `prisma/schema.prisma`, change:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

to:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

### 3b. Wipe the SQLite-flavored migrations

```bash
# delete the old migrations and the dev DB
rm -rf prisma/migrations
rm -f prisma/dev.db prisma/dev.db-journal
```

### 3c. Get a DATABASE_URL for local dev

In Railway → Postgres service → **Connect** tab → copy the **Public Network** connection string (looks like `postgresql://postgres:xyz@viaduct.proxy.rlwy.net:12345/railway`).

Put it in your local `.env`:

```
DATABASE_URL="postgresql://postgres:xyz@viaduct.proxy.rlwy.net:12345/railway"
```

(For real apps you'd run a separate dev DB to avoid prod data corruption — for this league bot, sharing the dev/prod Postgres is fine because it's small.)

### 3d. Generate fresh Postgres migrations

```bash
npm install
npm run db:migrate
# When prompted, name it: init
```

This creates `prisma/migrations/<timestamp>_init/migration.sql` with Postgres-flavored SQL. Commit it:

```bash
git add .
git commit -m "Switch to Postgres"
git push
```

Railway picks up the push, runs `npm install` → `prisma generate` (via postinstall) → `npm run build` → `npm start`. Because `start` is just `node dist/index.js` and the `Procfile` says `web: npm run db:deploy && node dist/index.js`, Railway will run migrations on every deploy via `db:deploy` then start the bot.

---

## Part 4: Wire the Discord OAuth redirect to Railway

The OAuth callback URL needs to point at Railway, not localhost.

1. In Railway → your bot service → **Settings** tab → **Domains** → **Generate domain**. You'll get something like `https://balatro-league-production.up.railway.app`.
2. Back in **Variables**, set:
   ```
   DISCORD_OAUTH_REDIRECT=https://balatro-league-production.up.railway.app/auth/discord/callback
   ```
3. In [Discord Developer Portal](https://discord.com/developers/applications) → your app → **OAuth2** → **Redirects** → add the same URL (`https://...up.railway.app/auth/discord/callback`). Don't remove the localhost one — it lets you still use OAuth locally.

Trigger a redeploy (push any commit or use Railway's Redeploy button).

---

## Part 5: Register slash commands to your prod guild

From your laptop (one-time after deploy):

```bash
npm run register
```

This pushes the slash command list to Discord. Without this, `/report` etc. won't appear in your server even though the bot is online.

---

## Part 6: Verify

1. Open `https://YOUR-APP.up.railway.app/standings` — should load the public standings page (or "No active season")
2. Open `https://YOUR-APP.up.railway.app/admin` — should redirect you to Discord OAuth → you log in → land on the dashboard
3. In your Discord server, try `/report`, `/standings`, `/schedule`, `/profile` — they should all work
4. Run `/league create-season name:"Season 1" divisions:true` and verify the divisions show up on the dashboard

If anything doesn't work, **check Railway → your service → Deployments → View logs** for the error.

---

## After deploy: ongoing dev

- **Code changes** → push to GitHub → Railway auto-deploys
- **Schema changes** → `npm run db:migrate` locally (creates migration file) → push → Railway runs `db:deploy` on next start to apply it
- **Slash command changes** → re-run `npm run register` locally to push them

You can keep using `npm run dev` locally — it connects to the Railway Postgres via the connection string in your `.env`.

---

## Cost notes

Railway's hobby plan is $5/month + usage. For a Discord bot + small Postgres, expect $5–10/month total. You can pause the project when not in use.

If you want to drop costs to ~$2/month, Fly.io has a more generous free tier but requires more setup (containerization, more flags). Railway is the path of least resistance for this app shape.

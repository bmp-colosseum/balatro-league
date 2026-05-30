# Deploy the bot to Railway

This walks you through deploying the Discord bot to Railway with a hosted Postgres database. For the web dashboard, see [DEPLOY-WEB.md](./DEPLOY-WEB.md) — it deploys as a separate Railway service sharing the same Postgres.

Estimated time: **15–20 minutes**.

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

Create a **private** repo on github.com. Then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/balatro-league.git
git branch -M main
git push -u origin main
```

> **Sanity check before pushing**: run `git status` and confirm `.env` is NOT listed. Tokens in git history are extremely hard to fully purge.

---

## Part 2: Set up Railway project + Postgres

1. Go to [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → pick your repo
2. The first build will likely fail (no DB or env vars yet). Expected.
3. **+ New** → **Database** → **PostgreSQL**. Railway auto-injects `DATABASE_URL` into the bot service.

### Set the env vars

In the bot service → **Variables**:

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Your bot token |
| `DISCORD_CLIENT_ID` | Your application ID |
| `DISCORD_GUILD_ID` | Your league server ID (or leave blank for global commands — slower to propagate) |
| `LEAGUE_OWNER_DISCORD_ID` | Your Discord user ID |
| `RESULTS_CHANNEL_ID` | Channel ID for auto-announced results (optional) |
| `LEAGUE_ADMIN_ROLE_ID` | Discord role ID for admins (optional — `RoleBinding` table is the modern way) |

> Don't add `DATABASE_URL` — Railway sets it automatically when you linked Postgres.

---

## Part 3: Postgres in `prisma/schema.prisma`

Already set to `postgresql` — no action needed. The Procfile (`web: npm run db:deploy && node dist/index.js`) runs migrations on every deploy, then starts the bot.

---

## Part 4: Register slash commands to your prod guild

From your laptop (one-time per command change):

```bash
npm run register
```

This pushes the slash command list to Discord. Without it, `/report` etc. won't appear in your server even though the bot is online.

---

## Part 5: Verify

1. In your Discord server, try `/report`, `/standings`, `/schedule`, `/profile`, `/start-match` — they should all work.
2. Run `/league create-season name:"Season 1"` and verify the season shows up on the web dashboard (see DEPLOY-WEB.md).

If anything fails, **check Railway → your service → Deployments → View logs**.

---

## Part 6: Deploy the web dashboard

The bot service no longer serves an HTTP dashboard — that lives in the separate `web/` Next.js service. Follow [DEPLOY-WEB.md](./DEPLOY-WEB.md) to add it.

---

## Ongoing dev

- **Code changes** → push to GitHub → Railway auto-deploys
- **Schema changes** → `npm run db:migrate` locally → push → Railway runs `db:deploy` on next start. Also `cp prisma/schema.prisma web/prisma/schema.prisma` (auto-handled by web's postinstall)
- **Slash command changes** → re-run `npm run register` locally

You can keep using `npm run dev` locally — it connects to Railway Postgres via the `.env` connection string.

---

## Cost notes

Railway hobby plan: $5/mo per service. With bot + web + Postgres that's ~$10-15/mo at low traffic.

# Deploy the Next.js web app as a 2nd Railway service

The existing Discord bot keeps running unchanged at the repo root. The new Next.js dashboard at `web/` deploys as a separate service in the same Railway project, sharing the same Postgres.

Time: ~15 minutes.

---

## Part 1: Add a new Railway service

1. Railway → your existing project
2. **+ New** → **GitHub repo** → pick `ChronoFinale/balatro-league` (already connected)
3. Railway creates a 2nd service. Click into it.
4. **Settings** → **Source** → set **Root Directory** to `/web`
5. Settings → **Build & Deploy** → ensure:
   - **Builder**: Railpack (Railway's default, or Nixpacks)
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - Railway will auto-detect Next.js and may set these correctly already

## Part 2: Link the Postgres service to this service

By default the new service has its own (empty) env. Connect it to the existing Postgres so `DATABASE_URL` is auto-injected:

1. On the new web service's **Variables** tab
2. Click **+ New Variable** → **Reference** → pick the Postgres service → `DATABASE_URL`

Railway will auto-set `DATABASE_URL` to the **internal** Postgres URL (free egress, faster than the public URL).

## Part 3: Set env vars on the web service

In Variables, also add (paste from your existing bot service's env):

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Same bot token as the bot service |
| `DISCORD_CLIENT_ID` | `1509693349257285682` |
| `DISCORD_CLIENT_SECRET` | Same as bot service |
| `DISCORD_GUILD_ID` | `1509692752902885527` |
| `LEAGUE_OWNER_DISCORD_ID` | `152639712937508869` |
| `LEAGUE_ADMIN_ROLE_ID` | (optional, if set on bot) |
| `RESULTS_CHANNEL_ID` | (optional, if set on bot — for web announcements) |
| `AUTH_SECRET` | A fresh 64-char hex string (generate with `openssl rand -hex 32`) |
| `AUTH_URL` | `https://www.balatroleague.com` (or the Railway-generated subdomain) |

**Don't add** `DATABASE_URL` (linked from Postgres above) or `PORT` (Railway sets it).

## Part 4: Domain

If you want `www.balatroleague.com` to point at the web service:

1. Web service → **Settings** → **Networking** → **Custom Domain**
2. Add `www.balatroleague.com`
3. Railway shows you a CNAME target — update your Route 53 record to point at this service (not the bot service)
4. Wait a minute for DNS, then Railway issues the cert

If the domain was already on the bot service, you'll need to switch the CNAME to the web service. The bot doesn't need a public domain (it only initiates connections to Discord).

## Part 5: Discord OAuth callback URL

The web app uses next-auth, which expects callbacks at `/api/auth/callback/discord` — different from the bot's old `/auth/discord/callback`.

1. https://discord.com/developers/applications → your app → **OAuth2** → **Redirects**
2. Add: `https://www.balatroleague.com/api/auth/callback/discord`
3. (For local dev: also add `http://localhost:3000/api/auth/callback/discord`)
4. Keep the old `/auth/discord/callback` URL — the bot's Express dashboard still uses it during the transition.

Once Phase 6 deprecates the Express dashboard (separate cleanup commit), you can remove the old redirect URL.

## Part 6: Schema sync (automatic)

The web app has its own copy of the Prisma schema at `web/prisma/schema.prisma`, kept in sync with the root `/prisma/schema.prisma` automatically:

- **Locally + on Railway**: `web/scripts/sync-schema.mjs` runs in `web`'s `postinstall`, copying the root schema down before `prisma generate`. You never need to `cp` manually.
- The bot service runs `prisma migrate deploy` at boot. The web service only regenerates the client — it doesn't run migrations (avoiding a race against the bot).

If the root schema isn't accessible during a web build (shouldn't happen on Railway since both services share the repo), the sync script falls back silently and uses whatever's already committed in `web/prisma/schema.prisma`.

Future cleanup: move both to a shared `packages/db` workspace.

## Part 7: Verify

After both services are up:

- `https://www.balatroleague.com/standings` → public standings (no login)
- `https://www.balatroleague.com/auth/signin` → Discord OAuth → land on `/me`
- `https://www.balatroleague.com/admin` → only loads if your account has OWNER tier (or ADMIN via role binding)

If anything 500s, **Railway → web service → Deployments → click latest → View logs**.

---

## What the 2 services look like running

| Service | Root | Process | Purpose |
|---|---|---|---|
| `balatro-league-bot` (existing) | `/` | `npm start` → `node dist/index.js` | Discord gateway connection, slash commands, button handlers, old Express dashboard (deprecate later) |
| `balatro-league-web` (new) | `/web` | `npm start` → `next start` | Next.js HTTP server, public + admin pages, OAuth |

Both share the same Postgres. Both can connect to Discord (via REST in the web's case). Either can crash and restart without affecting the other.

## Cost

Railway hobby plan: $5/mo per service in usage credits, so two services ~ $10-15/mo total at low traffic. Postgres is a third resource but at this scale is negligible.

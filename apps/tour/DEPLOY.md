# Deploying Team Tour → `tour.balatroleague.com` (Railway)

Team Tour ships as its **own Railway service** in the **same Railway project** as the
league, sharing the league's design system + Discord login so it reads as one site.
Nothing in `web/` (the league) changes.

```
Railway project (existing)
 ├─ league-bot       (existing)
 ├─ league-web       (existing) → balatroleague.com
 ├─ Postgres         (existing) → league DB
 ├─ tour-web         (NEW)      → tour.balatroleague.com
 └─ Postgres (tour)  (NEW)      → tour DB (separate data)
```

## Why this shape
Same dashboard + same Discord app + auto-deploy on push, its **own** Postgres
(separate data, by design), and the shared-auth env (below) means one login works on
both. Vercel would host the Next app fine too, but then the DB + league live
elsewhere — Railway wins here *because the league is already on it*.

## Built from a portable Dockerfile (not Nixpacks)
The build + start are defined in **`apps/tour/Dockerfile`** — a normal multi-stage image,
so the deploy is **host-agnostic** (Railway, Fly, Render, a VPS, anything that runs a
container) with no platform-specific build magic. It handles the one wrinkle for you: the
Tour is an **npm-workspace member** (depends on `@balatro/*`), so the image's build
context is the **repo root** and `npm ci` runs there to link the packages.

- **build (in the image):** `npm ci` at root → `npm run build -w @balatro/tour` (`prebuild`
  = `prisma generate`, custom client output → `next build`)
- **start (CMD):** `prisma db push` → `next start` on `$PORT`

`apps/tour/railway.json` just tells Railway to use that Dockerfile
(`builder: DOCKERFILE`, `dockerfilePath: apps/tour/Dockerfile`). To run it anywhere else:
```
docker build -f apps/tour/Dockerfile -t team-tour .     # from the repo root
docker run -p 3000:3000 --env-file apps/tour/.env team-tour
```

## One-time setup

1. **Postgres (tour)** — in the Railway project: New → Database → PostgreSQL. Copy its
   `DATABASE_URL`.

2. **New service (tour-web)** — New → GitHub Repo → this repo. Then in its **Settings**:
   - **Root Directory:** `/` (repo root — the Docker build context, so workspaces link)
   - **Config-as-code path:** `apps/tour/railway.json` (selects the Dockerfile)
     *(or just set Builder → Dockerfile, path `apps/tour/Dockerfile`, in Settings)*

3. **Env vars** on the service:
   ```
   DATABASE_URL=<the tour Postgres URL from step 1>
   DISCORD_CLIENT_ID=<SAME as the league>
   DISCORD_CLIENT_SECRET=<SAME as the league>
   AUTH_SECRET=<SAME value as the league>
   AUTH_COOKIE_DOMAIN=.balatroleague.com
   TOUR_OWNER_DISCORD_IDS=<your Discord user id(s), comma-separated → OWNER tier>
   # TOUR_TO_DISCORD_IDS / TOUR_HELPER_DISCORD_IDS for extra staff (optional)
   # TOUR_GUILD_ID=<tour guild id>  # optional — also resolves tiers via RoleBinding roles
   # NEXT_PUBLIC_LEAGUE_URL defaults to https://balatroleague.com
   # do NOT set TOUR_DEV_ADMIN in prod — admin fails CLOSED without it; access
   # comes from the tier env vars above (or RoleBinding once the bot syncs roles).
   ```

4. **Discord OAuth** — in the **league's** Discord app → OAuth2 → Redirects, add:
   `https://tour.balatroleague.com/api/auth/callback/discord`

5. **Domain** — service → Settings → Networking → Custom Domain → `tour.balatroleague.com`.
   Railway shows a CNAME target; add that DNS record.

6. **First deploy** runs automatically. On boot, `prisma db push` creates the schema on
   the tour DB. Then **import the data once** — Admin → Import (or
   `POST /api/admin/import?type=historical` then `?type=tt10`). The historical import
   now also **seeds the weekly roster-move log** (`backfillDraftedMoves`, idempotent) so
   the roster timeline + per-week lineups work for imported seasons — no separate step.
   Finally apply the `discordId` mapping / use the Identity manager.

   *Verify after import:* a season page (200), `/seasons/<name>/timeline` shows the
   draft + results, `/admin/seasons/<name>/roster` shows derived lineups, and signing in
   as a `TOUR_OWNER_DISCORD_IDS` user gives admin (the dev bypass is off in prod).

## "Hidden" while you work on it
The app already sends `robots: noindex, nofollow` (in `app/layout.tsx`), so the
deployed site won't be indexed. Just don't link it publicly yet; flip that line to
`index: true` when you're ready to launch.

## Auto-deploy
Every push to the deploy branch rebuilds + redeploys the service automatically — same
as the league.

## Later (not needed to launch)
- League → Tour nav link (one line in `web/`).
- Cross-DB **shared stats** (combined league+tour views) — joinable by `discordId`;
  the Tour can already read the league DB (see `web/scripts/export-league-players.mjs`).

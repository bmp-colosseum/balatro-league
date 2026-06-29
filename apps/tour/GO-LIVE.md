# Team Tour — Go-Live Checklist (Railway + Docker)

We deploy a **Dockerfile** (`apps/tour/Dockerfile`) — host-agnostic, no Railpack/Nixpacks,
no ecosystem lock-in. The same image runs on Fly, Render, a VPS, anything. This is the
exact, ordered runbook.

Verified ready: `npm ci` → `prisma generate` → `next build` all succeed inside the image
(all 35 routes compile). `prisma db push` on boot creates the schema. `.dockerignore`
keeps secrets/`.env`/CSVs/`node_modules` out of the image.

---

## 0. Before you start (the only things ONLY you can do)
- [ ] **Discord OAuth app** — use the **league's** existing Discord application (so login is
      shared). You need its `CLIENT_ID` + `CLIENT_SECRET`, and the league's `AUTH_SECRET`.
- [ ] **Your Discord user ID** (right-click yourself in Discord → Copy User ID; needs Developer
      Mode on). This becomes `TOUR_OWNER_DISCORD_IDS` → makes you admin.

## 1. Railway project + database
- [ ] New service in Railway (new project, or the league's project — doesn't matter; it stays
      a **separate** service).
- [ ] Add a **PostgreSQL** plugin to it. This is the Tour's **OWN** database — do **NOT** point
      it at the league DB. Railway gives you a `DATABASE_URL`.

## 2. Point the service at the Docker build  ⚠️ the one monorepo gotcha
The image must build with the **repo root** as context (the app is an npm-workspace member —
the install has to run at root to link `@balatro/*`). In the service **Settings**:
- [ ] **Source → Root Directory:** `/`  *(repo root, NOT `apps/tour`)*
- [ ] **Build → Builder:** `Dockerfile`
- [ ] **Build → Dockerfile Path:** `apps/tour/Dockerfile`

> Set these **in the Railway UI**. With Root Directory `/`, Railway won't auto-read
> `apps/tour/railway.json`, so the UI settings are what take effect. (The committed
> `railway.json` documents the same thing; you can instead set the service's *Config-as-code
> path* to `apps/tour/railway.json` if you prefer version-controlled config.)

## 3. Environment variables (service → Variables)
```
DATABASE_URL          = <the Tour Postgres URL from step 1>
DISCORD_CLIENT_ID     = <SAME as the league>
DISCORD_CLIENT_SECRET = <SAME as the league>
AUTH_SECRET           = <SAME value as the league>   # lets the Tour read the league's session
AUTH_COOKIE_DOMAIN    = .balatroleague.com           # shares the login cookie across both sites
TOUR_OWNER_DISCORD_IDS = <your Discord user id>      # → OWNER admin (comma-separate for more)
# Optional: TOUR_TO_DISCORD_IDS / TOUR_HELPER_DISCORD_IDS for extra staff
# Do NOT set TOUR_DEV_ADMIN — admin fails CLOSED in prod without it; access = the ids above.
```

## 4. Discord OAuth redirect
- [ ] League's Discord app → **OAuth2 → Redirects** → add:
      `https://tour.balatroleague.com/api/auth/callback/discord`

## 5. Domain
- [ ] Service → **Settings → Networking → Custom Domain** → `tour.balatroleague.com`
- [ ] Add the CNAME record Railway shows to your DNS.

## 6. First deploy + load data
- [ ] Deploy runs automatically. On boot the container runs `prisma db push` (creates the
      schema) then `next start`. Watch the deploy logs for a clean boot.
- [ ] **Import the history once:** on your machine, **zip the sheets folder** (the one with
      `Standings.html` + an `alltime/` subfolder). Then sign in on the site (you're OWNER) →
      **Admin → Import history → upload the .zip**. It imports the Swiss + conference seasons and
      auto-seeds the weekly roster-move log — no local-path/server-side files needed.
- [ ] **Verify:** a season page returns 200, `/seasons/<name>/timeline` shows the draft +
      results, `/admin/seasons/<name>/roster` shows derived lineups, and **you have admin**
      (the dev bypass is off in prod — admin comes from `TOUR_OWNER_DISCORD_IDS`).

## 7. It's hidden by default
The app sends `robots: noindex, nofollow` (`app/layout.tsx`) — deployed but not indexed.
Just don't link it publicly. Flip that to `index: true` when you launch.

---

## Stays separate from the league (on purpose)
- **Database:** two separate Postgres instances. The Tour has its own `Player`/`Match`/`Game`
  tables. A shared DB would let the Tour's schema pushes touch league production — never do
  that. Cross-app value comes from a shared **login** (same Discord app + `AUTH_SECRET`) and,
  later, a **read-only** `LEAGUE_DATABASE_URL` joined by `discordId` — never a shared schema.
- **Build:** the league deploys via its own Procfile; the Tour via this Dockerfile. No conflict.

## Later (needs the bot token, not launch-blocking)
- `TOUR_DISCORD_TOKEN` + `TOUR_GUILD_ID` → run the bot (own Railway service) for role sync
  (the brain is built: `lib/services/discord-roles.ts` + `bot/reconcile.ts`).
- Map historical players → Discord IDs (`/admin/identity`) so old players link + can be roled.

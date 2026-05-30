# Balatro League Bot

Discord bot to run a Balatro league with division pyramid (Common → Legendary), round-robin best-of-2 sets, points-based standings, and opponent-confirmed match reporting.

## Status

**Shipped so far** (Season 1 usable):

- `/report @opponent result:2-0|1-1|0-2` — submit a set result, opponent confirms via button (or disputes for admin override)
- Prisma + SQLite (dev) schema covering Seasons, Divisions (rarity pyramid), Players, Pairings
- Slash-command + button registry — add commands by dropping a file in `src/commands/` and exporting from `src/commands/index.ts`

**Coming next** (priorities in order):

1. `/standings` — current division table
2. `/league force-result` — admin override for disputed pairings
3. `/league create-season` + `/league assign-players` — admin setup
4. Signup button + auto-sort into divisions of 5 (for Season 2 onboarding)
5. `/league end-season` — apply promotion/relegation, open the next season

## Scoring

| Result    | Winner | Loser |
| --------- | ------ | ----- |
| 2-0 / 0-2 | 3 pts  | 0 pts |
| 1-1       | 1 pt   | 1 pt  |

Standings sort by points → head-to-head → shootout (admin-resolved manually).

## Setup

### 1. Create the Discord application

1. Go to https://discord.com/developers/applications → **New Application**.
2. **Bot** tab: reset/copy the token, save for `DISCORD_TOKEN`.
3. **General Information**: copy the Application ID for `DISCORD_CLIENT_ID`.
4. **Installation** → **Install Link** → use a custom URL with these scopes:
   - `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Embed Links`, `Use Application Commands`, `Manage Roles` (only needed once we add the auto-channel/role feature)
5. Invite the bot to your league server with the generated URL.

### 2. Configure `.env`

```bash
cp .env.example .env
```

Fill in:

- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` — from step 1
- `DISCORD_GUILD_ID` — right-click your server icon in Discord (with Developer Mode on) → Copy Server ID. Setting this registers commands per-guild, which propagates instantly.
- `LEAGUE_ADMIN_ROLE_ID`, `RESULTS_CHANNEL_ID` — optional for now; needed once admin commands ship.
- `DATABASE_URL` — defaults to local SQLite. For Postgres, change to `postgresql://...` and update `prisma/schema.prisma` provider to `postgresql`.

### 3. Install + initialize

```bash
npm install
npm run db:migrate    # creates dev.db with the schema
npm run register      # registers slash commands with Discord
```

### 4. Run

```bash
npm run dev    # watch mode, restarts on file changes
# or
npm run build && npm start
```

## Project layout

```
prisma/
  schema.prisma         # data model
  migrations/           # generated SQL
src/
  index.ts              # client bootstrap + interaction dispatcher
  env.ts                # zod-validated env
  db.ts                 # PrismaClient singleton
  scoring.ts            # central scoring rules — change here to tweak points
  players.ts            # Player upsert helper
  commands/
    types.ts            # SlashCommand + ButtonHandler contracts
    index.ts            # registry — add new commands here
    report.ts           # /report command + confirm/dispute button handlers
  scripts/
    register-commands.ts  # one-shot: pushes slash commands to Discord
```

## Adding a new slash command

1. Create `src/commands/yourthing.ts`, export `SlashCommand`.
2. Add it to the `slashCommands` array in `src/commands/index.ts`.
3. `npm run register` to push it to Discord.
4. `npm run dev` to test it.

## Deploying

See **[DEPLOY.md](./DEPLOY.md)** for a click-by-click Railway walkthrough including Postgres setup, Discord OAuth redirect, and secrets.

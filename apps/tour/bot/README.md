# Team Tour Discord bot (Phase C — scaffold)

The "hands" that apply the role-reconciliation **brain** (`lib/services/discord-roles.ts`)
to a real Discord guild. The brain is built + tested and needs **no token**; this bot is
the thin shell that runs when the owner provides one.

## What it will do

1. **Provision roles** — on first run for a season, create the **Player** + **Captain**
   roles (reuse the league's `createGuildRole`) and store their ids on
   `TourSeason.playerRoleId` / `captainRoleId`.
2. **Reconcile** — on a trigger (draft done · sub · captain change · quit/ban · a manual
   "sync" · a timer):
   - read the role's **current** members from Discord,
   - call `getRoleSyncPlan(seasonName, { players, captains })`,
   - apply `plan.players.add/remove` + `plan.captains.add/remove` via the league's
     `addGuildMemberRole` / `removeGuildMemberRole`.
   That's the entire add/move/remove automation — it always re-derives, so it's
   self-healing regardless of how the roster changed.
3. **(later)** `#results`/`#schedule` bootstrap, on-the-clock + Sunday-deadline pings,
   match threads — the same patterns as the league bot (`src/`).

## Wiring (when the token exists)

- `TOUR_DISCORD_TOKEN` — the Tour bot token (Discord developer portal → Bot).
- `TOUR_GUILD_ID` — the Tour guild (already used by web auth for tier resolution).
- Reuse the league's `src/discord-helpers.ts` primitives (role/channel/message) — copy
  or share them; they're framework-agnostic (discord.js).
- Run as its **own** Railway service (long-lived gateway connection), separate from the
  Next.js web service. A timer + a lightweight web hook (or LISTEN/NOTIFY) triggers
  `reconcile(seasonName)`.

## The brain (already done, here today)

`lib/services/discord-roles.ts`:
- `getDesiredRoles(season)` / `getRolePreview(season)` — who SHOULD hold each role
  (derived from rosters + captains + the move log; departed players drop out; legacy
  players without a Discord id surface as `unmappable`).
- `planRoleReconciliation(desired, current)` — pure add/remove diff (unit-tested).
- `getRoleSyncPlan(season, current?)` — the full per-role plan the bot applies.

Admin preview (no token): **/admin/seasons/[name]/discord**.

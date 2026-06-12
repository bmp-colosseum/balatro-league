# Moving the bot to a new Discord server (mid-season) — idiot-proof guide

Goal: the **same bot**, **same season**, now running in a **new Discord server** —
without losing or deleting anything.

## The one thing to understand

All your data — players, the season, divisions, every match — lives in the
**database** (the `DATABASE_URL` env var on Railway). This whole move **never
touches the database.** It only re-creates Discord channels and roles.

So the two rules that make this safe:

1. **NEVER change or clear `DATABASE_URL`.** Leave it exactly as it is.
2. **NEVER run anything with "wipe" in it** (`wipe:test-env`, `/api/admin/wipe-…`).
   Those delete. You will NOT use them. The only button you click is **Re-home**,
   which deletes nothing in your data.

If you only remember those two things, you cannot lose your season.

---

## Before you start (checklist)

- [ ] The **new Discord server** exists and you're its owner/admin.
- [ ] The **bot is invited** to the new server with **Manage Channels, Manage Roles,
      Manage Webhooks** (re-use the same invite link you used originally — same bot).
- [ ] **All your players have joined the new server** (so they can be given their
      division role in one shot — see the note at the end about stragglers).
- [ ] You can get to **Railway** (the bot service's Variables) and the **website's
      `/admin/seasons`** page.

> ⚠️ This guide assumes the **same bot** (same Discord application/token) is moving
> to a new server. If you're setting up a **brand-new bot** (new token), stop and
> ask — that's a different first step.

---

## The steps (do them in this order)

### Step 1 — Get the new server's ID
In Discord: User Settings → Advanced → turn on **Developer Mode**. Then right-click
the **new server's icon** → **Copy Server ID**. Keep it handy.

> ✅ It's a long number like `1509692752902885527`.

### Step 2 — Point the bot at the new server
Railway → your **bot** service → **Variables**:
- Find **`DISCORD_GUILD_ID`** → change its value to the **new server's ID** from
  Step 1 → save. The bot restarts pointing at the new server.
- **Do NOT touch `DATABASE_URL`** or anything else.

> ✅ Check: after a minute, the bot shows online in the **new** server.
> 🛟 **Reversible:** everything up to here is undoable — set `DISCORD_GUILD_ID` back
> to the old ID and you're exactly where you started. (The Re-home in Step 4 is the
> commit point.)

### Step 3 — Build the league shell in the new server
In the **new server**, run **`/league setup`**.
- This creates the category + the league channels (`league-results-bot`,
  `league-announcements`, etc.) and the **League Admin / Helper / DevOps** roles.
- **Assign the `League Admin` role** to yourself (and your staff) in the new server's
  Server Settings → Members. (You stay OWNER regardless, via the env pin.)

> ✅ Check: `#league-info`, `#league-results-bot`, etc. now exist in the new server,
> and `/admin/config` shows the channel IDs filled.

### Step 4 — Re-home the season (the one button that does the work)
On the website: **`/admin/seasons`** → find your **ACTIVE** season → expand **"Discord
channels & roles"** → expand **"⇄ Re-home to a new server"** → type **`REHOME`** in the
box → click **Re-home season**.

What it does (and *only* this):
- Clears the season's **old-server** channel/role IDs from the database (just the IDs
  — it does **not** delete the old server's channels).
- Re-creates each division's **channel + role** in the **new** server.
- **Re-assigns** each division role to its members (who are now in the new server).
- **Touches zero gameplay data** — players, matches, points, standings are untouched.

> ✅ Check: each division now has a channel in the new server, and players have their
> division role.
> ⚠️ **Click Re-home exactly ONCE.** Don't click it again — re-running it would clear
> the (now-correct) IDs and make duplicate channels.

### Step 5 — Verify it worked
- A player can see their **division channel** in the new server.
- **`/standings`** (Discord) and the website standings show the same numbers as before
  (because the data never moved).
- Have someone **report a test result** to confirm reporting works, then it can be
  corrected/ignored.

Done. The season continues in the new server.

---

## What happens to the OLD server?
Nothing is deleted there. Its old channels/roles just sit unused (the bot is no
longer pointed at it). You can delete them by hand later if you want a clean-up —
there's no rush and no requirement.

## Stragglers (players who join the new server AFTER Step 4)
A player who joins late won't automatically get their division role (Re-home assigns
roles to whoever was present when you clicked it, and you only click it once). For a
few late joiners, an admin can give them their division role by hand in Server
Settings. If lots of people will trickle in, ask and we'll add a safe
"re-assign roles to current members" button (which does NOT recreate channels).

## If something looks wrong
- **Before Step 4:** just set `DISCORD_GUILD_ID` back to the old server's ID — fully
  reversible.
- **After Step 4:** your data is still 100% safe (it never moved). If channels look
  off, don't re-click Re-home — grab help and we'll sort the Discord side without
  risking anything.

## ⛔ Never, during any of this
- Don't change/clear `DATABASE_URL`.
- Don't run `wipe:test-env`, `/api/admin/wipe-test-data`, or `/api/admin/wipe-discord`.
- Don't click **Re-home** more than once.

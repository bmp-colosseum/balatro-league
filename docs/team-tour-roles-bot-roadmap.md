# Team Tour — Roles, Permissions & Bot Roadmap

Status: **proposed** (2026-07) · Owner review pending
Scope: the "org functionality" layer for Team Tour — fine-grained mod permissions,
an admin UI to manage them, and a Team Tour Discord bot — building **on top of** the
existing tier system (`lib/auth.ts`, design §13.7), not replacing it.

---

## 0. What already exists (the foundation)

- **Tiers** `OWNER › TO › HELPER › DEVOPS › PLAYER › GUEST`, resolved in `lib/auth.ts`
  from env-pinned Discord IDs **or** `RoleBinding` (Discord guild role → tier).
- **`isAdmin()` = OWNER/TO** gates every admin action today (coarse, all-or-nothing).
- **`isApiAdmin(req)`** — a Bearer `TOUR_ADMIN_TOKEN` path already exists so a bot/
  service can call the web as an admin.
- **Shared SSO** — Discord OAuth cookie shared across `*.balatroleague.com`; sign-in
  captures the user's Tour-guild `roleIds` (`auth.ts`).
- Design §13.7 already specs: Discord roles → org tiers, competition data → captain/
  player, and the bot mirroring roster data into Discord roles.

**Gap:** tiers are *linear* (a rank), so we can't say "news mod but not roster mod."
There's no capability model, no UI to manage access, and no actual bot.

---

## 1. Roles — the backbone: **TO · Captain · Player**

Three first-class roles, each with a **different scope of authority**. Everything else
(mod capabilities in §2) is an overlay a TO uses to delegate slices of their own power.

| Role | Scope | Source of truth | Can do | Discord role |
|---|---|---|---|---|
| **TO** | whole event | `TO` tier (RoleBinding / env-pinned) | everything — all capabilities, all teams, all seasons | a TO Discord role → `RoleBinding` |
| **Captain** | **their own team** | `TeamSeason.captainPlayerId` (data) | subs / re-seeds / captain hand-off, draft picks, pairing + result-report — **for their team only** | `TourSeason.captainRoleId` (bot-synced) |
| **Player** | **themselves** | APPROVED `Signup` / a `RosterEntry` this season (data) | sign up, view set hub, report/confirm **their own** results | `TourSeason.playerRoleId` (bot-synced) |

- **TO** is the org tier (unchanged). **Captain** and **Player** are **data-derived** and
  naturally **season-scoped** — you're a captain *of a team in a season*. The bot mirrors
  both into Discord roles for captain-only / player-only channels (§3d); the data stays
  authoritative.
- This means permission checks are **resource-aware**: `can(ROSTERS, { teamSeasonId })` is
  true for a TO on any team, but for a captain only on *their* team; player actions check
  the acting player owns the result. (See `can()` below.)

## 2. Capability model — delegating a TO's power

Add **capabilities** for *what a person may do*, so a TO can hand out slices without making
someone a full TO. A viewer's capabilities = role-implied ∪ per-user grants ∪ per-role grants.

### Capabilities (owner-selected set)
| Capability | Covers (existing actions today) |
|---|---|
| `NEWS` | News Network articles (previews / recaps) CRUD |
| `RANKINGS` | power rankings — team + player — CRUD |
| `ROSTERS` | adds / drops / subs / re-seeds / captain changes |
| `DRAFT` | run + edit drafts (draft board, pick edits) |
| `SCHEDULE` | matchups, pairings, recording/confirming set results |

`NEWS` and `RANKINGS` are **separate** so a writer can post articles without touching
rankings (and vice-versa). Both are pure content — no competition data — so they're the
safest to hand out widely (casters, contributors). Enum extends easily for more content
roles later (e.g. a caster/`MEDIA` cap) — see §6.

**Reserved to OWNER/TO only** (not separately grantable): identity merge/link,
season create/configure, imports, and **granting permissions itself** (`ACCESS`).

- **OWNER / TO** ⇒ all capabilities, all teams, always.
- **Captain** ⇒ `ROSTERS` / `DRAFT` / `SCHEDULE` **scoped to their own team** (via
  `TeamSeason.captainPlayerId`), not a global grant.
- **Player** ⇒ self-scoped only (report/confirm own results, signup) — no mod caps.
- **HELPER / DEVOPS** ⇒ *only* what they're explicitly granted (HELPER stops being an
  implicit admin-lite; it's just a label unless granted caps). ← open Q (§6).

### Data model (`tour.prisma`)
```prisma
enum Capability { NEWS RANKINGS ROSTERS DRAFT SCHEDULE }
enum GrantSubject { USER ROLE }

model ModGrant {
  id          String       @id @default(cuid())
  subjectType GrantSubject                 // USER = a Discord user, ROLE = a guild role
  subjectId   String                       // discordId (USER) | discordRoleId (ROLE)
  capability  Capability
  seasonId    String?                       // null = all seasons; set = this season only
  label       String?                       // cached username / role name for the admin list
  createdBy   String?                       // granter's discordId (audit)
  createdAt   DateTime     @default(now())
  @@unique([subjectType, subjectId, capability, seasonId])
  @@index([subjectId])
}
```
`RoleBinding` (tier) stays as-is. `ModGrant` layers fine-grained caps on top. Grants are
**optionally season-scoped** — e.g. a one-season draft runner — falling back to global.

### Resolution + enforcement (`lib/auth.ts` + `lib/permissions.ts`)
- `capabilitiesFor(viewer, seasonId?) : Set<Capability>` — OWNER/TO → all; else union of
  matching `ModGrant`s (USER by discordId, ROLE by the session `roleIds`), filtered to
  `seasonId == null || seasonId == given`.
- **`can(capability, { seasonId?, teamSeasonId? }) : Promise<boolean>`** — the new,
  **resource-aware** gate:
  - TO / a matching global grant → true for any team.
  - else if `teamSeasonId` given and the viewer is that team's captain
    (`captainPlayerId == viewer.playerId`) and `capability ∈ {ROSTERS, DRAFT, SCHEDULE}`
    → true (team-scoped captain authority).
  - player self-actions (report own result) check `viewer.playerId` owns the row, not a cap.
  - Services stay auth-agnostic; **callers** (actions/routes) gate, same as today.
- **Migration of existing gates:** replace `assertAdmin()`/`isAdmin()` in each admin action
  with `assertCan(cap, ctx)`, per the table above — and where an action is a captain's own-
  team job, pass its `teamSeasonId` so captains pass too. OWNER/TO-only actions keep
  `assertAdmin()`. Mechanical, testable sweep (each action → one capability + its scope).

---

## 3. Admin UI — `/admin/access`

One page under the admin shell (discoverable where admins already look):
- **Roles at a glance** — who's TO (tier), and each season's captains (from
  `captainPlayerId`) — read-only, since Captain/Player are data-derived, not assigned here.
- **Effective access table** — every USER/ROLE mod grant: subject (name), capabilities,
  season scope, who granted it + when. Revoke inline (ActionFlashForm, visible flash).
- **Grant a mod** — pick subject (search a Player → USER grant, or enter/select a Discord
  role → ROLE grant), check capabilities, optional season scope → create `ModGrant`.
- **"Who can do what"** quick matrix (subjects × the capabilities) for a glance.
- Gated by `ACCESS` (OWNER/TO only). All grant/revoke actions audit `createdBy`.

No schema churn beyond `ModGrant`; reuses `rankingPool`-style player search + the
existing `RoleBinding` role list for role names.

---

## 4. The Team Tour bot

**Principle (matches repo convention):** the **web is the source of truth**; the bot is
a **thin client** that calls the web's service layer via API routes (Bearer
`TOUR_ADMIN_TOKEN`), never a second copy of the logic. Same capability model applies in
Discord as on the web.

### 4a. Hosting & identity
- New workspace app **`apps/tour-bot`** (own process; deployed alongside the web).
- **Reuses the existing league bot token** (per standing decision — never reset it) and
  the Tour guild (`TOUR_GUILD_ID`). Confirm intents: `guilds`, `guild members`
  (for role sync), application commands.

### 4b. Permission-aware commands
- Bot resolves a caller's capabilities by calling a new endpoint
  `GET /api/tour/access/me?discordId=…` (server resolves via §1). So a "news mod" can run
  news commands in Discord but not roster commands — one model, two surfaces.

### 4c. Command surface (phased; ties to design §13.8)
| Group | Commands | Cap |
|---|---|---|
| Read | `/tour standings`, `/tour schedule`, `/tour player`, `/tour bracket` | none (public) |
| News | `/tour news post` (paste → web) | `NEWS` |
| Rankings | `/tour rankings post` (team / player) | `RANKINGS` |
| Rosters | `/tour sub`, `/tour drop`, `/tour reseed`, `/tour captain` | `ROSTERS` |
| Draft | `/tour draft start|pick|status` (the live board) | `DRAFT` |
| Schedule | `/tour pair`, `/tour report`, `/tour confirm` | `SCHEDULE` |
| Admin | `/tour grant`, `/tour season …` | OWNER/TO |

### 4d. Discord role sync — the TO / Captain / Player roles (design §13.7/§13.8)
- **TO** role → `RoleBinding` (already the auth source). **Captain** + **Player** roles are
  per-season, provisioned + kept in sync by the bot from the data:
  `TourSeason.playerRoleId` + `captainRoleId` (schema add).
- The bot keeps the Discord roles in sync as rosters/subs/captaincy change (data →
  Discord, one-way; the web stays authoritative). Enables captain-only / player-only
  channels. Triggered by web events (webhook/queue) or a periodic reconcile.

---

## 5. Phases & dependencies

1. **P1 — Capability model** (`ModGrant` + `capabilitiesFor` + `can()`), seed OWNER/TO,
   sweep existing admin actions → capability gates. *No visible change; safe to ship.*
   → unblocks everything.
2. **P2 — `/admin/access` UI** (grant/revoke, effective view). Depends on P1.
3. **P3 — Bot foundation** — `apps/tour-bot` process, token/intents, `/tour standings`
   + `/api/tour/access/me`. Proves the thin-client + cap model in Discord. Depends on P1.
4. **P4 — Bot write commands** — news → rosters → schedule → draft, each behind its cap.
   Depends on P2/P3 + existing service endpoints (add where missing).
5. **P5 — Discord role sync** — `playerRoleId`/`captainRoleId` provisioning + reconcile.
   Depends on P3. Largest Discord-ops surface; do last.

Each phase is independently shippable and reversible. P1+P2 deliver the "different mods
for different things" ask entirely on the web, before any bot infra.

---

## Future ideas (owner-flagged, not yet scheduled)

- **Twitch integration** (PizzaPower55's channel is the community hub):
  - **Stream overlay endpoints** — chromeless pages sized for OBS browser sources: live
    draft ticker (on the clock + up next), matchup scoreboard, standings strip. Cheap to
    build (they're just server-rendered pages + the existing SSE live refresh).
  - **"LIVE" badges** — Twitch API check for PizzaPower55 (and player streams from signup
    intros) surfaced on the site + a `#now-live` bot post.
  - **Caster view** — a spectator-friendly set page (big score, decks, lives) for casting.
  - Later: pick'em ↔ Twitch predictions sync.

## 6. Open questions (need owner calls before P1)

1. **Captain powers** — the roadmap gives captains team-scoped `ROSTERS` + `DRAFT` +
   `SCHEDULE` (subs, re-seeds within rules, draft picks, pairing + report for their team).
   Is that the right set, or should some of it stay TO-only (e.g. re-seeds)?
2. **HELPER tier** — keep it as an implicit admin-lite bundle (e.g. NEWS+SCHEDULE), or
   make it grant-only like everyone else? (Roadmap assumes grant-only.)
3. **Season-scoped grants** — worth the extra UI now, or global-only v1 and add scope
   later? (`seasonId` column is cheap to keep even if the UI defers it.)
4. **Bot hosting** — same host/process manager as the web, or separate? Does the current
   league bot infra have room to co-host, or is this a new deploy target?
5. **Role-sync trigger** — event-driven (web notifies bot on roster change) vs periodic
   reconcile vs both. Affects P5 complexity.
6. **More content roles?** — `NEWS` + `RANKINGS` are now split. Any other content/media
   caps to add up front (e.g. a `MEDIA`/caster cap for match threads + highlights), or
   add as needed? Also: split `SCHEDULE` later into pairing vs results-confirm? Enum extends easily.

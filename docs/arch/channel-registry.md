# Channel Registry — declarative, idempotent Discord channel setup

**Status:** proposal / migration plan (not yet implemented)
**Scope:** the channel/category/permission setup layer only. Not a re-architecture.

## TL;DR

Every channel-setup bug we've hit (rename churn, support floating at top-level,
stale deny overwrites, results-bot/human collision, config drift, "touch 3 files
to add one channel") has the same root cause: **the facts about a channel are
hand-replicated across ~5 layers, and the bugs are those copies drifting apart.**

The fix is not a redesign. It's to make the channel layer **declarative + enforced**:
one registry of channel specs, and one reconciler that makes Discord match the
spec every run. Everything else (boot auto-create, `/league setup`, the scope
gate, the web admin list) *derives* from the registry instead of restating it.

This is an *operational robustness* fix (idempotency, ID-anchoring, cleanup-on-
change) expressed as a small *structural* change (single source of truth).

---

## 1. The problem: one channel, five definitions

Take `league-announcements`. Its name, category, type, lock policy, and config
key are defined **independently** in five places:

| Layer | What it restates | Where |
|---|---|---|
| Config enum | `announcements_channel_id` (1 of 16 channel/category keys) | `src/league-config.ts` |
| Boot helper | `resolveX()` + `ensureX()` auto-create | `src/announcements-channel.ts` (1 of **6** near-identical files) |
| Setup | `ensureChannel(name, topic, type, key)` + lock perms + persist | `src/commands/league.ts` (**1,154 lines**) |
| Scope gate | which channels a command may run in | `src/command-channels.ts` |
| Web admin | `CHANNEL_KEYS` hand-list (16 entries) | `web/app/admin/config/page.tsx` |

Because the facts are retyped 4–5×, correctness depends on humans keeping the
copies in sync. They drift, and **every drift is a bug we've shipped:**

- **Support floated at top-level** — its boot helper was the one of six that
  didn't call `resolveConfiguredCategory`. Pure copy drift.
- **Results-bot renamed the human channel** — "which names map to which channel"
  lived as an imperative `aliases: ["results","league-results"]` array in setup,
  disconnected from the human channel's own name. They overlapped → wrong channel
  grabbed + renamed.
- **Stale deny on `#league-results`** — the lock was applied imperatively and
  setup only ever *added* overwrites; it never *enforced* "this channel is open",
  so a leftover deny survived a rename and had to be fixed by hand.
- **Scattered locks/reactions** — each lock is a hand-written
  `permissionOverwrites.edit` block in setup; no per-channel policy.
- **Adding `signups_channel_id`** — required edits to the enum, setup, *and* the
  web list. Three edits, one channel.

The smell is textbook *no single source of truth*. The bugs are all *reconciliation
drift*, not wrong design — which is exactly why the fix is localized.

---

## 2. The model

### ChannelSpec

One object per channel. This is the **only** place a channel's facts live.

```ts
type LockPolicy =
  | "open"        // @everyone can post + react
  | "readOnly"    // @everyone view + read history (+ react if reactions:true); bot posts
  | "botOnly"     // readOnly, but @everyone keeps UseApplicationCommands (slash cmds work here)
  | "staffOnly"   // private: deny @everyone ViewChannel; allow admin/helper/owner + bot
  | "devopsOnly"; // private: deny @everyone ViewChannel; allow devops role + bot

interface ChannelSpec {
  /** LeagueConfig key the resolved id is stored under (the stable handle). */
  key: LeagueConfigKey;
  /** Canonical channel name (always "league-" prefixed except casual #challenges). */
  name: string;
  /** Which category it lives under. */
  category: "league" | "matches";
  type: "text" | "announcement";
  lock: LockPolicy;
  /** Only meaningful for readOnly/botOnly; ignored for open/private. */
  reactions: boolean;
  topic: string;
  /** Human label for the web admin page + setup summary. */
  label: string;
  /**
   * bot_commands_channel_id holds a COMMA-SEPARATED LIST (multiple allowed
   * channels). Setup writes the created id but never clobbers a multi-value
   * admin override.
   */
  multi?: boolean;
}

interface CategorySpec {
  key: LeagueConfigKey;     // league_category_id | matches_category_id
  id: "league" | "matches";
  name: string;             // "🃏 Balatro League" | "🎴 Matches"
}
```

### The registry (current inventory, becomes the literal)

| key | name | category | type | lock | reactions |
|---|---|---|---|---|---|
| `league_info_channel_id` | league-info | league | text | readOnly | ❌ |
| `signups_channel_id` | league-signups | league | text | readOnly | ❌ |
| `announcements_channel_id` | league-announcements | league | announcement | readOnly | ✅ |
| `results_channel_id` | league-results-bot | league | text | botOnly | ✅ |
| `results_human_channel_id` | league-results | league | text | open | — |
| `general_channel_id` | league-chat | league | text | open | — |
| `bot_commands_channel_id` | league-bot-commands | league | text | open (multi) | — |
| `feedback_channel_id` | league-feedback | league | text | open | — |
| `support_channel_id` | league-support | league | text | readOnly | ❌ |
| `admin_channel_id` | league-admin | league | text | staffOnly | — |
| `backup_channel_id` | league-backups | league | text | staffOnly | — |
| `devops_channel_id` | league-devops | league | text | devopsOnly | — |
| `challenges_channel_id` | challenges | matches | text | open | — |

Categories: `league_category_id` → "🃏 Balatro League", `matches_category_id` → "🎴 Matches".

**Out of registry (not channels):** `results_webhook_url`,
`challenge_results_channel_id`, `challenge_results_webhook_url`. These are
delivery config, not managed channels — leave them as plain keys. (The challenge
feed posts to `#challenges` by default.)

---

## 3. The reconciler: declare + ENFORCE

One function per channel. The critical word is **enforce** — it asserts the full
desired state every run, so it's self-healing against drift (a leftover deny, a
wrong category, a stale name). This is what neither the boot helpers nor setup do
today (they only ever *add*).

```ts
async function reconcileChannel(guild, spec, categoryId): Promise<Channel> {
  // 1. RESOLVE — id → exact name → create. No alias/"similar" matching.
  let ch = await resolveByPinnedId(guild, spec.key);           // guild-scoped
  ch ??= findByExactName(guild, spec.name, categoryId);
  ch ??= await guild.channels.create({ name: spec.name, type: spec.type, parent: categoryId, topic: spec.topic });

  // 2. ENFORCE shape — name, parent category, type. In-place edits (no data loss).
  if (ch.name !== spec.name)       await ch.edit({ name: spec.name });
  if (ch.parentId !== categoryId)  await ch.edit({ parent: categoryId });
  if (typeOf(ch) !== spec.type)    await ch.edit({ type: spec.type });   // announcement fallback if non-Community

  // 3. ENFORCE permissions from the lock policy — this is the self-healing step.
  await applyLock(guild, ch, spec);   // sets the FULL desired @everyone + bot + role overwrites

  // 4. PERSIST the id (skip clobbering a multi-value override).
  await persistId(spec.key, ch.id, { multi: spec.multi });
  return ch;
}
```

`applyLock` translates a `LockPolicy` into the exact overwrite set — and because
it sets the *complete* desired state (including the `open` case that explicitly
allows `@everyone: SendMessages`), a stale deny can never survive a re-run. That
single property would have prevented the `#league-results` hand-fix.

```ts
function applyLock(guild, ch, spec) {
  const everyone = guild.roles.everyone.id, bot = client.user.id;
  switch (spec.lock) {
    case "open":     return ch.permissionOverwrites.edit(everyone, { ViewChannel:true, SendMessages:true, AddReactions:true, ReadMessageHistory:true });
    case "readOnly": return setReadOnly(ch, { reactions: spec.reactions, useAppCommands:false });
    case "botOnly":  return setReadOnly(ch, { reactions: spec.reactions, useAppCommands:true });
    case "staffOnly":   return setPrivate(ch, [adminRole, helperRole, ...ownerRoles]);
    case "devopsOnly":  return setPrivate(ch, [devopsRole]);
  }
}
```

---

## 4. What derives from the registry (delete the duplicates)

| Today | After |
|---|---|
| 6 `*-channel.ts` boot helpers | boot loop: `for (spec of REGISTRY) reconcileChannel(...)` — **delete the 6 files** |
| `ensureChannel(...)` ×13 + inline locks in `league.ts` | setup loop over the registry — monolith shrinks to a loop + `applyLock` |
| `command-channels.ts` allow-lists | derive allowed channels from specs tagged for command use |
| `CHANNEL_KEYS` hand-list in web | generate from the shared registry (export specs from a shared module) |
| setup summary (hand-built lines) | generate from `spec.label` + `<#id>` |

Adding a channel becomes: **append one spec.** It shows up in boot, setup, the
web config page, and the summary automatically.

---

## 5. Migration plan (phased, each step shippable + reversible)

Pre-launch, no back-compat required — but do it in safe increments anyway so each
deploy is verifiable against the live guild.

1. **Introduce the registry + reconciler, unused.** Add `src/channels/registry.ts`
   (specs) and `src/channels/reconcile.ts` (`reconcileChannel`, `applyLock`).
   Unit-test the registry (below). No behavior change. ✅ ship.
2. **Port `/league setup` to loop the registry.** Replace the 13 `ensureChannel`
   calls + the inline lock blocks with `for (spec of REGISTRY) reconcileChannel`.
   Keep the webhook/category/role bits as-is for now. Re-run setup on the test
   guild, diff the channel list + perms. ✅ ship.
3. **Port boot auto-create to the registry; delete the 6 helpers.** Replace the
   `ensureX()` calls in `src/index.ts` boot with the same loop (or a subset). Grep
   for each `resolveXChannelId` caller and point them at a single
   `resolveChannelId(key)` helper. Delete `announcements-/bot-commands-/backup-/
   devops-/challenges-channel.ts`. ✅ ship.
4. **Generate the web `CHANNEL_KEYS`** from the shared registry (move specs to a
   spot both packages can import, or codegen a small JSON the web reads). ✅ ship.
5. **Derive the scope gate** allow-lists from the registry tags. ✅ ship.

Each step is independently revertible (`DISCORD_GUILD_ID` back, redeploy prior
commit). Steps 2–3 are the ones that actually kill the bug class.

---

## 6. Testing — the payoff the imperative version can't have

A registry is *data*, so it's unit-testable without Discord:

- every `spec.name` is unique (no two channels share a name → no rename collision);
- every `spec.key` is a real `LeagueConfigKey` and unique;
- no spec name collides with another spec's name (the results-bot/human bug as a
  test);
- every `category` resolves to a `CategorySpec`;
- `applyLock` produces the expected overwrite set per policy (table test).

The current imperative setup can't be tested without a live guild — which is why
these bugs only ever surfaced in production. Note: `master` deploys to prod on
push and the 26 existing tests cover scoring/standings/match-state, **none** cover
channel setup. The registry closes that gap cheaply.

---

## 7. Non-goals (keep the blast radius small)

- **Not** a re-architecture. The forked investigation's guardrail stands: this is
  reconciliation/idempotency, not throughput/latency/multi-tenant isolation.
  Don't escalate to a redesign.
- **Not** touching the bot/web split or the two-Prisma-client setup (deliberate
  choices; out of scope).
- **Not** the `match-buttons.ts` god-file (1,970 lines). That's the *same disease*
  in the match engine, but its remedy is already in flight: the `match-core`
  extraction started for Team Tour. Pull the pure ban/pick state machine out, keep
  the Discord glue thin — track that separately.

## 8. Why this is the right call

The recurring failures were never "the design is wrong." They were "the same fact
is written in five places and one of them is stale." A registry makes the fact
exist *once* and a reconciler makes Discord *match* it every run. Small structural
change, kills an entire class of operational bug, and finally makes the buggiest
part of the codebase testable.

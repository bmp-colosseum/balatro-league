// Discord application emojis for Balatro decks and stakes. Application
// emojis (Discord API ~Oct 2024) live on the bot's *application*, not a
// guild — so they don't burn guild emoji slots, the bot can reference
// them anywhere it's installed, and the limit is 2000 per application
// (vs ~50 per guild).
//
// On startup:
//   1. List the application's current emojis (REST API).
//   2. For each canonical deck + stake, check if an emoji with the
//      expected name exists; if not, upload the PNG from
//      src/assets/balatro/{decks,stakes}/<slug>.png.
//   3. Cache name → formatted-mention map in memory.
//
// Render helpers return the full `<:deck_red:1234>` mention string for
// use in message content + select menu options.

import { REST } from "@discordjs/rest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_DECKS,
  CANONICAL_STAKES,
  deckSlug,
  stakeEmojiChar,
  stakeSlug,
} from "./balatro-info.js";
import { env } from "./env.js";
import { attachRestTiming } from "./rate-limit-logger.js";

const ASSET_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)), "src", "assets", "balatro");

interface AppEmoji {
  id: string;
  name: string;
  animated?: boolean;
}

let cachedRest: REST | null = null;
function rest(): REST {
  if (!cachedRest) {
    cachedRest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
    // Standalone instance bypasses client.rest -- time it too so
    // bot_discord_rest_* covers app-emoji sync traffic.
    attachRestTiming(cachedRest);
  }
  return cachedRest;
}

const emojiByName = new Map<string, AppEmoji>();

// Discord allows alphanumeric + underscore in emoji names. Prefix to
// avoid colliding with anything else the bot might upload later.
function deckEmojiName(deckName: string): string {
  return `deck_${deckSlug(deckName)}`;
}
function stakeEmojiName(stakeName: string): string {
  return `stake_${stakeSlug(stakeName)}`;
}

// Format the mention string Discord renders as an inline emoji.
function formatEmoji(e: AppEmoji): string {
  return `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`;
}

export function deckEmoji(deckName: string): string | null {
  const e = emojiByName.get(deckEmojiName(deckName));
  return e ? formatEmoji(e) : null;
}

export function stakeEmoji(stakeName: string): string | null {
  const e = emojiByName.get(stakeEmojiName(stakeName));
  if (e) return formatEmoji(e);
  // No uploaded chip emoji — fall back to the unicode emoji for custom stakes.
  return stakeEmojiChar(stakeName) ?? null;
}

// For StringSelectMenu options — Discord wants `{id, name, animated}`.
export function deckEmojiPartial(deckName: string): { id: string; name: string; animated?: boolean } | undefined {
  const e = emojiByName.get(deckEmojiName(deckName));
  return e ? { id: e.id, name: e.name, animated: e.animated } : undefined;
}

export function stakeEmojiPartial(stakeName: string): { id?: string; name: string; animated?: boolean } | undefined {
  const e = emojiByName.get(stakeEmojiName(stakeName));
  if (e) return { id: e.id, name: e.name, animated: e.animated };
  // Unicode fallback for custom stakes — Discord select menus accept a bare
  // unicode emoji as { name } with no id.
  const char = stakeEmojiChar(stakeName);
  return char ? { name: char } : undefined;
}

// One-shot: list app emojis, upload any missing PNGs, populate the cache.
// Safe to call repeatedly — already-uploaded emojis are skipped and PNGs
// that don't exist on disk are silently skipped (admin uploads later).
export async function ensureBalatroEmojis(applicationId: string): Promise<void> {
  emojiByName.clear();
  const route = `/applications/${applicationId}/emojis` as `/applications/${string}/emojis`;
  let existing: AppEmoji[] = [];
  try {
    const res = (await rest().get(route)) as { items: AppEmoji[] };
    existing = res.items ?? [];
  } catch (err) {
    console.warn("[balatro-emojis] failed to list application emojis:", err);
    return;
  }
  for (const e of existing) emojiByName.set(e.name, e);

  let uploaded = 0;
  let skippedMissingPng = 0;
  for (const deck of CANONICAL_DECKS) {
    const name = deckEmojiName(deck.name);
    if (emojiByName.has(name)) continue;
    const path = resolve(ASSET_ROOT, "decks", `${deckSlug(deck.name)}.png`);
    if (!existsSync(path)) { skippedMissingPng++; continue; }
    const created = await uploadEmoji(applicationId, name, path);
    if (created) { emojiByName.set(name, created); uploaded++; }
  }
  for (const stake of CANONICAL_STAKES) {
    const name = stakeEmojiName(stake.name);
    if (emojiByName.has(name)) continue;
    const path = resolve(ASSET_ROOT, "stakes", `${stakeSlug(stake.name)}.png`);
    if (!existsSync(path)) { skippedMissingPng++; continue; }
    const created = await uploadEmoji(applicationId, name, path);
    if (created) { emojiByName.set(name, created); uploaded++; }
  }
  console.log(
    `[balatro-emojis] cache loaded — ${emojiByName.size} known, ${uploaded} just uploaded` +
      (skippedMissingPng > 0 ? `, ${skippedMissingPng} missing PNGs (add files + restart bot)` : ""),
  );
}

async function uploadEmoji(
  applicationId: string,
  name: string,
  path: string,
): Promise<AppEmoji | null> {
  try {
    const png = readFileSync(path);
    const dataUri = `data:image/png;base64,${png.toString("base64")}`;
    const route = `/applications/${applicationId}/emojis` as `/applications/${string}/emojis`;
    const created = (await rest().post(route, { body: { name, image: dataUri } })) as AppEmoji;
    return created;
  } catch (err) {
    console.warn(`[balatro-emojis] upload failed for ${name}:`, err);
    return null;
  }
}

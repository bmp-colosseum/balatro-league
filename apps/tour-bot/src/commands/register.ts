// Hash-gated guild-scoped command registration (league pattern): only hit the Discord API
// when the command tree actually changed. The hash lives in TourConfig (bot.commandHash)
// so redeploys skip re-registration.
import { createHash } from "node:crypto";
import { Routes, type Client } from "discord.js";
import { env } from "./../env";
import { apiGet, apiPost } from "./../api";
import { commandDefinitions } from "./definitions";

export async function ensureCommandsRegistered(client: Client): Promise<void> {
  const body = commandDefinitions();
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  try {
    const stored = await apiGet<{ key: string; value: string | null }>("/api/bot/config?key=bot.commandHash");
    if (stored.value === hash) {
      console.log("[commands] unchanged — registration skipped");
      return;
    }
  } catch {
    /* config unreachable — register anyway */
  }
  const appId = client.application?.id;
  if (!appId) {
    console.warn("[commands] application id unavailable — will register on next boot");
    return;
  }
  await client.rest.put(Routes.applicationGuildCommands(appId, env.TOUR_GUILD_ID), { body });
  await apiPost("/api/bot/config", { key: "bot.commandHash", value: hash }).catch(() => {});
  console.log(`[commands] registered /ppt (hash ${hash})`);
}

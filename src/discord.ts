// Singleton holder for the Discord client so routes outside src/index.ts can use it
// to fetch users, check roles, etc. Set once during boot.

import type { Client } from "discord.js";

let client: Client | null = null;

export function setDiscordClient(c: Client): void {
  client = c;
}

export function getDiscordClient(): Client {
  if (!client) {
    throw new Error("Discord client not initialized yet. Wait for bot login before using it.");
  }
  return client;
}

export function tryGetDiscordClient(): Client | null {
  return client;
}

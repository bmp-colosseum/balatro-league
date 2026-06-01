// Slash-command registration helpers. Used by:
//   - src/index.ts on bot startup (auto-register if the command shape changed
//     since last boot — uses a hash in LeagueConfig to skip no-op registers).
//   - src/scripts/register-commands.ts manually via `npm run register`.
//
// Discord's global slash-command rate limit is ~200 updates/day. The hash
// gate prevents trivial boot cycles from burning that budget, while still
// auto-registering whenever a command genuinely changes (new option, new
// command, modified description, etc.).
//
// Guild-scoped registration (when DISCORD_GUILD_ID is set) propagates
// instantly; global registration can take up to ~1 hour. Hash key is
// scoped to which target we registered to so changing from guild to global
// (or vice versa) re-triggers a register.

import { createHash } from "node:crypto";
import { REST, Routes } from "discord.js";
import { slashCommands } from "./index.js";
import { env } from "../env.js";
import { getConfig, setConfig, LeagueConfigKey } from "../league-config.js";

function commandsBody() {
  return slashCommands.map((c) => c.data.toJSON());
}

function commandsHash(): string {
  const target = env.DISCORD_GUILD_ID ? `guild:${env.DISCORD_GUILD_ID}` : "global";
  const h = createHash("sha256");
  h.update(target);
  h.update("|");
  h.update(JSON.stringify(commandsBody()));
  return h.digest("hex");
}

// Always register, regardless of hash. Used by the CLI script.
export async function registerCommands(): Promise<void> {
  const body = commandsBody();
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
  const route = env.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID)
    : Routes.applicationCommands(env.DISCORD_CLIENT_ID);
  console.log(
    `[register] ${body.length} command(s) → ${env.DISCORD_GUILD_ID ? `guild ${env.DISCORD_GUILD_ID}` : "global"}`,
  );
  await rest.put(route, { body });
  await setConfig(LeagueConfigKey.LastCommandsHash, commandsHash(), "register-commands");
}

// Diff the current command shape against the last-registered hash; only
// hits Discord if something changed. No-op if hash matches.
export async function ensureCommandsRegistered(): Promise<void> {
  const current = commandsHash();
  const stored = await getConfig(LeagueConfigKey.LastCommandsHash);
  if (stored === current) {
    console.log("[register] commands unchanged — skipping (hash matches)");
    return;
  }
  console.log(
    `[register] command shape changed since last boot (${stored ? "old hash mismatch" : "no prior hash"}) — registering…`,
  );
  await registerCommands();
}

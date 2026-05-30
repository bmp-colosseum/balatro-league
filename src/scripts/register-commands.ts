// One-shot script: registers slash commands with Discord.
//   - If DISCORD_GUILD_ID is set → registers them to that guild (instant, used during dev).
//   - Otherwise → registers globally (can take up to ~1 hour to propagate).
//
// Run: npm run register

import { REST, Routes } from "discord.js";
import { slashCommands } from "../commands/index.js";
import { env } from "../env.js";

const body = slashCommands.map((c) => c.data.toJSON());
const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);

const route = env.DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID)
  : Routes.applicationCommands(env.DISCORD_CLIENT_ID);

console.log(
  `Registering ${body.length} command(s) ${env.DISCORD_GUILD_ID ? `to guild ${env.DISCORD_GUILD_ID}` : "globally"}...`,
);
await rest.put(route, { body });
console.log("Done.");

import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { ensureBackupChannel } from "./backup-channel.js";
import { ensureBotCommandsChannel } from "./bot-commands-channel.js";
import { ensureChallengesChannel } from "./challenges-channel.js";
import { checkChannelScope } from "./command-channels.js";
import { buttonHandlers, selectMenuHandlers, slashCommands } from "./commands/index.js";
import { setDiscordClient } from "./discord.js";
import { env } from "./env.js";
import { startHealthCheck } from "./healthcheck.js";
import { startMatchSweep } from "./match-sweep.js";
import { initQueue } from "./queue.js";
import { attachRateLimitLogging } from "./rate-limit-logger.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = slashCommands.find((c) => c.data.name === interaction.commandName);
      if (!command) {
        await interaction.reply({
          content: `Unknown command \`/${interaction.commandName}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const channelCheck = await checkChannelScope(command.channelScope, interaction.channelId);
      if (!channelCheck.allowed) {
        await interaction.reply({
          content: channelCheck.reason ?? "This command isn't allowed in this channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await command.execute(interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      const command = slashCommands.find((c) => c.data.name === interaction.commandName);
      if (command?.autocomplete) {
        await command.autocomplete(interaction);
      } else {
        await interaction.respond([]);
      }
      return;
    }

    if (interaction.isButton()) {
      const handler = buttonHandlers.find((h) => interaction.customId.startsWith(h.prefix));
      if (!handler) {
        await interaction.reply({
          content: "No handler for this button.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await handler.execute(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const handler = selectMenuHandlers.find((h) => interaction.customId.startsWith(h.prefix));
      if (!handler) {
        await interaction.reply({
          content: "No handler for this menu.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await handler.execute(interaction);
      return;
    }
  } catch (err) {
    console.error("Interaction handler failed:", err);
    const errorMsg = "Something went wrong handling that — check the bot logs.";
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
});

setDiscordClient(client);
attachRateLimitLogging(client);
startHealthCheck();
startMatchSweep();
await client.login(env.DISCORD_TOKEN);
// Start the pg-boss worker AFTER the Discord client is logged in — DM
// jobs need the client to send. Errors here don't abort the bot.
initQueue().catch((err) => console.warn("[pg-boss] init failed:", err));
// Auto-create the bot-commands channel if neither env var nor LeagueConfig
// has one already. Best-effort — admin can always pin manually later.
ensureBotCommandsChannel().catch((err) => console.warn("[bot-commands] init failed:", err));
// Same pattern for the private backup channel — sensitive content
// (full pairings + season config) should not land in public bot-commands.
ensureBackupChannel().catch((err) => console.warn("[backup-channel] init failed:", err));
// And the casual-challenges parent channel under a dedicated '🎴 Matches'
// category so /challenge threads have their own home.
ensureChallengesChannel().catch((err) => console.warn("[challenges-channel] init failed:", err));

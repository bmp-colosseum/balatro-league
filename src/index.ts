import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { ensureAnnouncementsChannel } from "./announcements-channel.js";
import { ensureBalatroEmojis } from "./balatro-emojis.js";
import { ensureCommandsRegistered } from "./commands/register.js";
import { ensureBotCommandsChannel } from "./bot-commands-channel.js";
import { ensureChallengesChannel } from "./challenges-channel.js";
import { ensureDevopsChannel } from "./devops-channel.js";
import { checkChannelScope } from "./command-channels.js";
import { buttonHandlers, modalHandlers, selectMenuHandlers, slashCommands } from "./commands/index.js";
import { setDiscordClient } from "./discord.js";
import { env } from "./env.js";
import { startHealthCheck } from "./healthcheck.js";
import { startMatchSweep } from "./match-sweep.js";
import { bootstrapPresetsAndPointers } from "./match-config.js";
import { initQueue } from "./queue.js";
import { attachRateLimitLogging } from "./rate-limit-logger.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  // Boot-time permission audit. Logs whether the bot has the perms it
  // needs in the configured guild — useful when threads aren't closing,
  // channels aren't being created, etc. We name each perm we care about
  // and check it against the bot's effective permissions.
  if (env.DISCORD_GUILD_ID) {
    try {
      const guild = await c.guilds.fetch(env.DISCORD_GUILD_ID);
      const me = await guild.members.fetchMe();
      const needed: Array<[string, bigint]> = [
        ["ViewChannel", 1n << 10n],
        ["SendMessages", 1n << 11n],
        ["ManageChannels", 1n << 4n],
        ["ManageThreads", 1n << 34n],
        ["CreatePublicThreads", 1n << 35n],
        ["CreatePrivateThreads", 1n << 36n],
        ["SendMessagesInThreads", 1n << 38n],
        ["ManageRoles", 1n << 28n],
        ["ManageMessages", 1n << 13n],
        ["UseExternalEmojis", 1n << 18n],
      ];
      const perms = me.permissions.bitfield;
      const missing: string[] = [];
      const present: string[] = [];
      for (const [name, bit] of needed) {
        if ((perms & bit) === bit) present.push(name);
        else missing.push(name);
      }
      console.log(`[perms] guild=${guild.name} bot=${me.user.tag}`);
      console.log(`[perms]   present: ${present.join(", ") || "(none)"}`);
      if (missing.length > 0) {
        console.warn(`[perms] ⚠ MISSING: ${missing.join(", ")} — these will silently fail when used.`);
      } else {
        console.log(`[perms]   missing: (none)`);
      }
    } catch (err) {
      console.warn("[perms] failed to fetch guild membership for audit:", err);
    }
  }
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

    if (interaction.isModalSubmit()) {
      const handler = modalHandlers.find((h) => interaction.customId.startsWith(h.prefix));
      if (!handler) {
        await interaction.reply({
          content: "No handler for this modal.",
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
// Ensure the canonical "Stock" preset matches match-defaults.json and the
// preset pointers are set. Runs on every boot so editing the defaults +
// redeploying updates the live pool immediately (not just on next match).
bootstrapPresetsAndPointers().catch((err) => console.warn("[presets] bootstrap failed:", err));
// Auto-create the bot-commands channel if neither env var nor LeagueConfig
// has one already. Best-effort — admin can always pin manually later.
ensureBotCommandsChannel().catch((err) => console.warn("[bot-commands] init failed:", err));
// Upload any missing Balatro deck/stake PNGs to the bot's application
// emojis. Self-healing: drop new PNGs in src/assets/balatro/ + restart,
// it picks them up. Missing PNGs are silently skipped.
ensureBalatroEmojis(env.DISCORD_CLIENT_ID).catch((err) =>
  console.warn("[balatro-emojis] init failed:", err),
);
// Auto-register slash commands if the command shape changed since last
// boot. Hash-gated so a normal restart is a free no-op — only burns a
// Discord API call when commands actually changed.
ensureCommandsRegistered().catch((err) =>
  console.warn("[register] auto-register failed:", err),
);
// Casual-challenges parent channel — invisible/empty for players,
// only used as the parent for ephemeral /challenge private threads.
ensureChallengesChannel().catch((err) => console.warn("[challenges-channel] init failed:", err));
// DevOps alert channel — infra-only, distinct from league admin. Used
// by the queue-stall alarm; null is fine (alerts log to console).
ensureDevopsChannel().catch((err) => console.warn("[devops-channel] init failed:", err));
ensureAnnouncementsChannel().catch((err) => console.warn("[announcements-channel] init failed:", err));

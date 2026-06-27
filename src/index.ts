import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import { captureCreate, captureDelete, captureEdit } from "./mod-log.js";
import { ensureBalatroEmojis } from "./balatro-emojis.js";
import { ensureCommandsRegistered } from "./commands/register.js";
import { checkChannelScope } from "./command-channels.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";
import { buttonHandlers, modalHandlers, selectMenuHandlers, slashCommands } from "./commands/index.js";
import { setDiscordClient } from "./discord.js";
import { env } from "./env.js";
import { startHealthCheck } from "./healthcheck.js";
import { startMatchSweep } from "./match-sweep.js";
import { startMatchControlBumper } from "./commands/match-buttons.js";
import { bootstrapPresetsAndPointers } from "./match-config.js";
import { initQueue } from "./queue.js";
import { attachRateLimitLogging } from "./rate-limit-logger.js";

// Time an interaction handler and log it if it exceeds SLOW_OP_MS (default 1.5s)
// — surfaces user-facing slowness (which command/button is dragging) without any
// external tooling. Always awaits the work; logging is in a finally so a thrown
// handler is still timed. Tune the threshold via env, no redeploy.
const SLOW_OP_MS = Number(process.env.SLOW_OP_MS ?? 1500);
async function timed(label: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
  } finally {
    const ms = Date.now() - start;
    if (ms >= SLOW_OP_MS) console.warn(`[slow-op] ${label} took ${ms}ms`);
  }
}

// FULL intents include the privileged MessageContent (for moderation transcript
// capture). If that intent isn't enabled in the Developer Portal, login throws
// "disallowed intents" — which would otherwise crash-loop the ENTIRE bot (no
// signups, no matches, nothing). So we fall back to CORE intents (the bot's
// pre-transcript config) and keep everything working except capture. GuildMessages
// + MessageContent + Partials.Message are what let edits/deletes of uncached
// messages fire so we can capture the original then mark it edited/deleted.
const INTENTS_FULL = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];
const INTENTS_CORE = [GatewayIntentBits.Guilds];

function createClient(intents: GatewayIntentBits[]): Client {
  const client = new Client({
    intents,
    partials: [Partials.Message, Partials.Channel],
  });

// Moderation capture — match + dispute threads only (mod-log.ts scopes it).
// Fire-and-forget; capture must never disrupt the match flow.
client.on(Events.MessageCreate, (message) => {
  captureCreate(message).catch(() => {});
});
client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
  captureEdit(newMessage).catch(() => {});
});
client.on(Events.MessageDelete, (message) => {
  captureDelete(message).catch(() => {});
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
    // Guild lock: this instance only operates in its configured DISCORD_GUILD_ID.
    // If the bot gets added to another server, politely refuse rather than act
    // on the wrong place — a safety net for running/moving across servers.
    if (env.DISCORD_GUILD_ID && interaction.guildId && interaction.guildId !== env.DISCORD_GUILD_ID) {
      if (interaction.isAutocomplete()) {
        await interaction.respond([]);
      } else if (interaction.isRepliable()) {
        await interaction.reply({
          content: "This bot is configured for a different server and doesn't operate here.",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    // Sign-ups-only mode: keep the sign-up flow (the signup: buttons) + /help
    // live, refuse everything else. Lets you soft-launch the bot in a new
    // server with only sign-ups running until the season starts.
    if ((await getConfig(LeagueConfigKey.SignupsOnlyMode)) === "true") {
      const allowed =
        (interaction.isButton() && interaction.customId.startsWith("signup:")) ||
        (interaction.isChatInputCommand() && interaction.commandName === "help");
      if (!allowed) {
        if (interaction.isAutocomplete()) {
          await interaction.respond([]);
        } else if (interaction.isRepliable()) {
          await interaction.reply({
            content:
              "🔒 The league bot is in **sign-ups-only mode** right now — only sign-ups are live. Full functionality opens when the season starts.",
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }
    }

    if (interaction.isChatInputCommand()) {
      const command = slashCommands.find((c) => c.data.name === interaction.commandName);
      if (!command) {
        await interaction.reply({
          content: `Unknown command \`/${interaction.commandName}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // For threads, pass the parent channel id so scoped commands (e.g.
      // /helper) are allowed in a thread spawned under an allowed channel.
      const parentId = interaction.channel?.isThread?.() ? interaction.channel.parentId : null;
      const channelCheck = await checkChannelScope(command.channelScope, interaction.channelId, parentId, {
        commandName: interaction.commandName,
      });
      if (!channelCheck.allowed) {
        await interaction.reply({
          content: channelCheck.reason ?? "This command isn't allowed in this channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await timed(`cmd:${interaction.commandName}`, () => command.execute(interaction));
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
      await timed(`btn:${interaction.customId}`, () => handler.execute(interaction));
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
      await timed(`menu:${interaction.customId}`, () => handler.execute(interaction));
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
      await timed(`modal:${interaction.customId}`, () => handler.execute(interaction));
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

  return client;
}

// Boot the gateway connection. Try FULL intents (incl. privileged MessageContent
// for transcript capture); if Discord rejects them ("disallowed intents" —
// because the portal toggle is off), fall back to CORE intents so the league
// keeps running. Crucially this stops the crash-LOOP that a fatal login error
// would cause — repeated restarts hammer Discord's gateway and trip a long
// connection rate-limit (429 on /gateway/bot) that locks the bot out entirely.
let client = createClient(INTENTS_FULL);
try {
  await client.login(env.DISCORD_TOKEN);
} catch (err) {
  const msg = String((err as Error)?.message ?? err);
  if (/disallowed intents/i.test(msg)) {
    console.error(
      "[boot] ⚠ MessageContent intent is DISABLED in the Discord Developer Portal — " +
        "moderation transcript capture is OFF. Booting with core intents so signups/matches keep working. " +
        "Enable Bot → Privileged Gateway Intents → Message Content to restore capture.",
    );
    try { client.destroy(); } catch { /* ignore */ }
    client = createClient(INTENTS_CORE);
    await client.login(env.DISCORD_TOKEN);
  } else {
    throw err;
  }
}

setDiscordClient(client);
attachRateLimitLogging(client);
startHealthCheck();
startMatchSweep();
startMatchControlBumper(client);
// Start the pg-boss worker AFTER the Discord client is logged in — DM
// jobs need the client to send. Errors here don't abort the bot.
initQueue().catch((err) => console.warn("[pg-boss] init failed:", err));
// Ensure the Standard / Challenge / Custom starter presets exist and each
// role points at its own. Standard is force-synced to match-defaults.json
// every boot (editing defaults + redeploying updates the live pool); the
// others are seeded once, then admin-editable.
bootstrapPresetsAndPointers().catch((err) => console.warn("[presets] bootstrap failed:", err));
// NOTE: league Discord CHANNELS (#bot-commands, #challenges, #support, #devops,
// #announcements, results, …) are deliberately NOT auto-created on boot —
// silently spawning channels in whatever server the bot is in is exactly the
// kind of unacknowledged side-effect we want to avoid (especially when moving
// servers). They're created only when an owner explicitly runs
// `/league bootstrap-server`.
//
// Upload any missing Balatro deck/stake PNGs to the bot's APPLICATION emojis
// (not server channels — global to the bot, harmless). Self-healing: drop new
// PNGs in src/assets/balatro/ + restart; missing PNGs are silently skipped.
ensureBalatroEmojis(env.DISCORD_CLIENT_ID).catch((err) =>
  console.warn("[balatro-emojis] init failed:", err),
);
// Auto-register slash commands if the command shape changed since last
// boot. Hash-gated so a normal restart is a free no-op — only burns a
// Discord API call when commands actually changed.
ensureCommandsRegistered().catch((err) =>
  console.warn("[register] auto-register failed:", err),
);

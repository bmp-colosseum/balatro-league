// Pizza Power Team Tour bot — entry point. Mirrors the league bot's boot pattern:
// graceful intent fallback (GuildMembers is privileged; without it role sync degrades to
// adds-only), a hard guild lock (TOUR_GUILD_ID), a Railway healthcheck, and pg-boss
// workers for web-enqueued jobs. The bot is "thin hands": ALL reads/writes go through the
// tour web's /api/bot/* service layer (src/api.ts) — no Prisma, no domain logic here.
import { Client, GatewayIntentBits, Events } from "discord.js";
import { env } from "./env";
import { startHealthCheck } from "./healthcheck";
import { startQueue } from "./queue";
import { ensureCommandsRegistered } from "./commands/register";
import { handlePptCommand, handlePickemButton } from "./commands/handlers";

// Intent ladder: try with GuildMembers (needed to enumerate role holders for full
// reconciliation); if the portal doesn't grant it, fall back to Guilds-only and keep
// running (role sync becomes adds-only and logs it).
const INTENT_LADDER: { name: string; intents: GatewayIntentBits[] }[] = [
  { name: "full (Guilds + GuildMembers)", intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] },
  { name: "reduced (Guilds only)", intents: [GatewayIntentBits.Guilds] },
];

async function login(): Promise<Client> {
  let lastErr: unknown;
  for (const rung of INTENT_LADDER) {
    const client = new Client({ intents: rung.intents });
    try {
      await client.login(env.DISCORD_TOKEN);
      console.log(`[boot] logged in with ${rung.name} intents`);
      return client;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/disallowed intents/i.test(msg)) {
        console.warn(`[boot] ${rung.name} rejected (privileged intent not enabled) — trying the next rung`);
        client.destroy();
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function main() {
  startHealthCheck();
  const client = await login();

  // The ready event can fire BEFORE this listener attaches (login() resolves around the
  // same time), so handle the already-ready case explicitly or registration never runs.
  const onReady = async () => {
    console.log(`[boot] ready as ${client.user?.tag ?? "?"}`);
    const guild = client.guilds.cache.get(env.TOUR_GUILD_ID) ?? (await client.guilds.fetch(env.TOUR_GUILD_ID).catch(() => null));
    if (guild) console.log(`[boot] guild lock: ${guild.name} (${guild.id})`);
    else console.warn(`[boot] NOT in the configured guild ${env.TOUR_GUILD_ID} yet — invite the bot there.`);
    await ensureCommandsRegistered(client).catch((err) => console.warn("[commands] registration failed:", err));
  };
  if (client.isReady()) await onReady();
  else client.once(Events.ClientReady, () => void onReady());

  // Invited AFTER boot? Register commands the moment we land in the configured guild —
  // no restart needed.
  client.on(Events.GuildCreate, async (guild) => {
    if (guild.id !== env.TOUR_GUILD_ID) return;
    console.log(`[boot] joined the configured guild: ${guild.name}`);
    await ensureCommandsRegistered(client).catch((err) => console.warn("[commands] registration failed:", err));
  });

  // Guild lock — refuse interactions anywhere but the configured guild.
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.guildId !== env.TOUR_GUILD_ID) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "This bot only serves the Pizza Power Team Tour server.", ephemeral: true }).catch(() => {});
      }
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "ppt") {
      await handlePptCommand(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("pickem:")) {
      await handlePickemButton(interaction);
      return;
    }
  });

  await startQueue(client);

  const shutdown = () => {
    console.log("[boot] shutting down");
    client.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[boot] fatal:", err);
  process.exit(1);
});

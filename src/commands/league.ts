// Slim /league command — initial server setup + role-tier bindings only.
// Everything else (create-season, signups, assign-player, etc.) moved to
// the web dashboard at www.balatroleague.com.

import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { PermissionTier } from "@prisma/client";
import { prisma } from "../db.js";
import { clearConfig, LeagueConfigKey, setConfig } from "../league-config.js";
import { requireOwner } from "../permissions.js";
import type { SlashCommand } from "./types.js";

const WEBHOOK_URL_RE = /^https:\/\/(discord\.com|discordapp\.com)\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+$/;

export const league: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("league")
    .setDescription("League server setup + permission management.")
    .addSubcommand((sub) =>
      sub
        .setName("bootstrap-server")
        .setDescription("Create category + channels + roles for the league. Owner only — idempotent on re-run.")
        .addStringOption((opt) =>
          opt.setName("category-name").setDescription("Name of the category to create (default: '🃏 Balatro League')").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-role")
        .setDescription("Bind a Discord role to a bot permission tier. Owner only.")
        .addStringOption((opt) =>
          opt
            .setName("tier")
            .setDescription("Permission tier this role grants")
            .setRequired(true)
            .addChoices(
              { name: "OWNER", value: "OWNER" },
              { name: "ADMIN", value: "ADMIN" },
              { name: "MOD", value: "MOD" },
            ),
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Discord role to bind").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unset-role")
        .setDescription("Remove a role's binding to a permission tier. Owner only.")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to unbind").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list-roles")
        .setDescription("Show all roles bound to bot permission tiers."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("setup-results-webhook")
        .setDescription("Auto-create a webhook in this channel for the results announces. Owner only.")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel for the results webhook (defaults to current channel)")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-results-webhook")
        .setDescription("Paste an existing webhook URL to use for results announces. Owner only.")
        .addStringOption((opt) =>
          opt.setName("url").setDescription("Webhook URL (from Discord channel Integrations)").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unset-results-webhook")
        .setDescription("Stop using a webhook for results announces (falls back to bot REST). Owner only."),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "list-roles") return listRoles(interaction);
    // Owner-only for state-changing role-binding + bootstrap + webhook config
    if (!(await requireOwner(interaction))) return;
    if (sub === "bootstrap-server") return bootstrapServer(interaction);
    if (sub === "set-role") return setRole(interaction);
    if (sub === "unset-role") return unsetRole(interaction);
    if (sub === "setup-results-webhook") return setupResultsWebhook(interaction);
    if (sub === "set-results-webhook") return setResultsWebhook(interaction);
    if (sub === "unset-results-webhook") return unsetResultsWebhook(interaction);
  },
};

async function bootstrapServer(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Run this command in your league's Discord server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const categoryName = interaction.options.getString("category-name") ?? "🃏 Balatro League";

  await interaction.deferReply();

  const me = interaction.guild.members.me;
  if (!me) {
    await interaction.editReply("Couldn't find bot member in this server.");
    return;
  }
  const required = ["ManageChannels", "ManageRoles"] as const;
  const missing = required.filter((perm) => !me.permissions.has(perm));
  if (missing.length > 0) {
    await interaction.editReply(
      `⚠️ Bot is missing required permission(s): **${missing.join(", ")}**. ` +
        `Re-invite the bot with elevated permissions, or grant them to the bot's role manually in Server Settings → Roles.`,
    );
    return;
  }

  const { ChannelType, PermissionsBitField } = await import("discord.js");

  try {
    const guild = interaction.guild;
    const created: string[] = [];
    const reused: string[] = [];

    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === categoryName,
    );
    if (!category) {
      category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
      created.push(`category "${categoryName}"`);
    } else {
      reused.push(`category "${categoryName}"`);
    }
    const categoryId = category.id;

    // Tracks whether each ensured channel was newly created — used below
     // to decide whether to seed it with onboarding messages (we don't want
     // to spam an existing channel admin has already curated).
    const justCreated = new Set<string>();
    async function ensureChannel(name: string, topic: string) {
      const existing = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === name && c.parentId === categoryId,
      );
      if (existing && existing.type === ChannelType.GuildText) {
        reused.push(`#${name}`);
        return existing;
      }
      const ch = await guild.channels.create({ name, type: ChannelType.GuildText, parent: categoryId, topic });
      created.push(`#${name}`);
      justCreated.add(ch.id);
      return ch;
    }
    const infoChan = await ensureChannel("league-info", "League rules, schedule, announcements. Read-only for most.");
    const signupChan = await ensureChannel("signups", "Signup embeds posted here by the web admin. Players click the button to register.");
    const resultsChan = await ensureChannel("results", "Auto-posted by the bot whenever a set is recorded.");
    const chatChan = await ensureChannel("league-chat", "General league chat. Match scheduling, banter, etc.");

    // Always (re-)seed #league-info with a pinned 'how it works' message.
    // If the bot already pinned one, edit it in place so re-running bootstrap
    // refreshes the content; otherwise post + pin a new one. Idempotent.
    const intro = [
      "# 🃏 Welcome to the league",
      "",
      "**How it works**",
      "• Each season splits players into tiers + divisions by rating.",
      "• Inside a division it's round-robin: you play everyone once, best-of-2 set.",
      "• Top finishers promote up a tier; bottom finishers drop down.",
      "",
      "**Scoring**",
      "• `2-0` win → **3 pts** winner, 0 loser",
      "• `1-1` draw → **1 pt** each",
      "• Standings sort: points → wins → draws.",
      "",
      "**Slash commands**",
      "• `/standings` — current division table",
      "• `/profile` — your match history & ranks",
      "• `/schedule` — sets you still need to play",
      "• `/start-match @opponent` — guided ban/pick flow (bot picks the deck/stake)",
      "• `/report @opponent result:2-0` — log a played set (auto-confirmed)",
      "• `/help` — full command list",
      "",
      "**Website:** <https://www.balatroleague.com> — standings, profiles, signup, settings.",
    ].join("\n");
    try {
      const pinned = await infoChan.messages.fetchPinned();
      const existing = pinned.find((m) => m.author.id === interaction.client.user.id);
      if (existing) {
        await existing.edit({ content: intro });
        reused.push(`#league-info pinned intro (refreshed)`);
      } else {
        const msg = await infoChan.send({ content: intro });
        await msg.pin().catch(() => { /* MANAGE_MESSAGES may be missing */ });
        created.push(`#league-info pinned intro`);
      }
    } catch (e) {
      console.warn(`[bootstrap] couldn't seed/refresh intro in #league-info: ${(e as Error).message}`);
    }

    async function ensureRole(name: string, reason: string) {
      const existing = guild.roles.cache.find((r) => r.name === name);
      if (existing) {
        reused.push(`role "${name}"`);
        return existing;
      }
      const r = await guild.roles.create({ name, mentionable: true, permissions: new PermissionsBitField(), reason });
      created.push(`role "${name}"`);
      return r;
    }
    const playerRole = await ensureRole("League Player", "Created by /league bootstrap-server");
    const adminRole = await ensureRole("League Admin", "Created by /league bootstrap-server — bound to bot's ADMIN tier");
    const modRole = await ensureRole("League Mod", "Created by /league bootstrap-server — bound to bot's MOD tier");

    // Wire the management roles to the bot's permission tiers so anyone
    // assigned the Discord role gets the matching permission on the web
    // dashboard + /league commands without further setup.
    await Promise.all([
      prisma.roleBinding.upsert({
        where: { discordRoleId: adminRole.id },
        create: { discordRoleId: adminRole.id, tier: "ADMIN", createdBy: interaction.user.id },
        update: { tier: "ADMIN" },
      }),
      prisma.roleBinding.upsert({
        where: { discordRoleId: modRole.id },
        create: { discordRoleId: modRole.id, tier: "MOD", createdBy: interaction.user.id },
        update: { tier: "MOD" },
      }),
    ]);

    const lines = [
      `✅ **${categoryName}** scaffolded.`,
      created.length > 0 ? `  Created: ${created.join(", ")}` : `  (nothing new — everything already existed)`,
      reused.length > 0 ? `  Reused: ${reused.join(", ")}` : null,
      ``,
      `📌 <#${infoChan.id}> — league-info`,
      `📝 <#${signupChan.id}> — signups`,
      `🏆 <#${resultsChan.id}> — results (auto-announce target)`,
      `💬 <#${chatChan.id}> — league-chat`,
      ``,
      `🎭 Roles:`,
      `• <@&${playerRole.id}> — League Player`,
      `• <@&${adminRole.id}> — League Admin (bound to ADMIN tier)`,
      `• <@&${modRole.id}> — League Mod (bound to MOD tier)`,
      ``,
      `Assign Admin/Mod to staff in **Server Settings → Members** and they immediately get the matching permissions on www.balatroleague.com.`,
      ``,
      `**Next**: set this env var on your bot host so result announcements land in the right channel:`,
      `\`RESULTS_CHANNEL_ID=${resultsChan.id}\``,
    ].filter((l): l is string => l !== null);

    await interaction.editReply(lines.join("\n"));
  } catch (err) {
    await interaction.editReply(
      `Bootstrap failed: ${(err as Error).message}. The bot may need additional permissions.`,
    );
  }
}

async function setRole(interaction: ChatInputCommandInteraction) {
  const tier = interaction.options.getString("tier", true) as PermissionTier;
  const role = interaction.options.getRole("role", true);
  await interaction.deferReply();
  await prisma.roleBinding.upsert({
    where: { discordRoleId: role.id },
    create: { discordRoleId: role.id, tier, createdBy: interaction.user.id },
    update: { tier, createdBy: interaction.user.id },
  });
  await interaction.editReply(`Bound role <@&${role.id}> → **${tier}**.`);
}

async function unsetRole(interaction: ChatInputCommandInteraction) {
  const role = interaction.options.getRole("role", true);
  await interaction.deferReply();
  const existing = await prisma.roleBinding.findUnique({ where: { discordRoleId: role.id } });
  if (!existing) {
    await interaction.editReply(`<@&${role.id}> isn't bound to any tier.`);
    return;
  }
  await prisma.roleBinding.delete({ where: { discordRoleId: role.id } });
  await interaction.editReply(`Removed binding for <@&${role.id}> (was **${existing.tier}**).`);
}

async function listRoles(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const bindings = await prisma.roleBinding.findMany({
    orderBy: [{ tier: "asc" }, { createdAt: "asc" }],
  });
  if (bindings.length === 0) {
    await interaction.editReply("No role bindings yet. The owner can set them with `/league set-role`.");
    return;
  }
  const lines = bindings.map((b) => `  • **${b.tier}** — <@&${b.discordRoleId}>`);
  await interaction.editReply(["**Role bindings**", ...lines].join("\n"));
}

// Auto-create a webhook in the chosen channel and store its URL.
// Needs the bot to have Manage Webhooks in that channel.
async function setupResultsWebhook(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channelArg = interaction.options.getChannel("channel");
  const channelId = channelArg?.id ?? interaction.channelId;
  if (!channelId) {
    await interaction.editReply("Run this in a text channel, or pass `channel:`.");
    return;
  }
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply("That isn't a text channel.");
      return;
    }
    const wh = await (channel as TextChannel).createWebhook({
      name: "Match Results",
      reason: `Created by /league setup-results-webhook (by ${interaction.user.tag})`,
    });
    if (!wh.url) {
      await interaction.editReply("Discord didn't return a webhook URL. Try `/league set-results-webhook url:...` manually.");
      return;
    }
    await setConfig(LeagueConfigKey.ResultsWebhookUrl, wh.url, interaction.user.id);
    await interaction.editReply(
      `✅ Results announces will now post in <#${channelId}> via webhook \`${wh.name}\`.\n` +
        `(URL stored in the DB — not shown here.)`,
    );
  } catch (err) {
    await interaction.editReply(
      `Couldn't create the webhook: ${(err as Error).message}\n` +
        `Either grant the bot **Manage Webhooks** in that channel, or create one in **Channel Settings → Integrations → Webhooks**, then paste the URL with \`/league set-results-webhook url:...\`.`,
    );
  }
}

// Manual paste — admin made the webhook themselves via the Discord UI.
async function setResultsWebhook(interaction: ChatInputCommandInteraction) {
  const url = interaction.options.getString("url", true).trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!WEBHOOK_URL_RE.test(url)) {
    await interaction.editReply("That doesn't look like a Discord webhook URL. Expected `https://discord.com/api/webhooks/.../...`");
    return;
  }
  await setConfig(LeagueConfigKey.ResultsWebhookUrl, url, interaction.user.id);
  await interaction.editReply("✅ Results webhook URL saved. (Not echoed back — keep the URL secret.)");
}

async function unsetResultsWebhook(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await clearConfig(LeagueConfigKey.ResultsWebhookUrl);
  await interaction.editReply(
    `Cleared. Results announces will fall back to bot REST via \`RESULTS_CHANNEL_ID\` env var (if set).`,
  );
}

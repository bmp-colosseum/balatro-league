// Slim /league command — initial server setup + role-tier bindings only.
// Everything else (create-season, signups, assign-player, etc.) moved to
// the web dashboard at www.balatroleague.com.

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { PermissionTier } from "@prisma/client";
import { prisma } from "../db.js";
import { requireOwner } from "../permissions.js";
import type { SlashCommand } from "./types.js";

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
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "list-roles") return listRoles(interaction);
    // Owner-only for state-changing role-binding + bootstrap
    if (!(await requireOwner(interaction))) return;
    if (sub === "bootstrap-server") return bootstrapServer(interaction);
    if (sub === "set-role") return setRole(interaction);
    if (sub === "unset-role") return unsetRole(interaction);
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
      return ch;
    }
    const infoChan = await ensureChannel("league-info", "League rules, schedule, announcements. Read-only for most.");
    const signupChan = await ensureChannel("signups", "Signup embeds posted here by the web admin. Players click the button to register.");
    const resultsChan = await ensureChannel("results", "Auto-posted by the bot whenever a set is recorded.");
    const chatChan = await ensureChannel("league-chat", "General league chat. Match scheduling, banter, etc.");

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
  await interaction.deferReply();
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

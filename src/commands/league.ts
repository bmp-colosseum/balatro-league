import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { PermissionTier } from "@prisma/client";
import { prisma } from "../db.js";
import { requireAdmin, requireOwner } from "../permissions.js";
import { getOrCreatePlayer } from "../players.js";
import { DEFAULT_PYRAMID, PLAYERS_PER_DIVISION } from "../pyramid.js";
import { signupButtons, signupEmbed } from "../signup.js";
import { commitSeason, planSeason } from "../build-season.js";
import { divisionNameAutocomplete } from "./autocomplete.js";
import type { SlashCommand } from "./types.js";

export const league: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("league")
    .setDescription("League management commands.")
    .addSubcommand((sub) =>
      sub
        .setName("create-season")
        .setDescription("Start a new season. Optionally scaffolds the full 17-division pyramid.")
        .addStringOption((opt) =>
          opt.setName("name").setDescription("Season name (e.g. 'Season 1')").setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("deadline")
            .setDescription("ISO date/time when the season ends (e.g. 2026-06-13T18:00:00Z)")
            .setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("divisions")
            .setDescription("Also create the 17 default divisions (1 Legendary, 4 Rare, 6 Uncommon, 6 Common). Default: yes.")
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName("from-signups")
            .setDescription("Optional: pull players from a finalized signup round (applies promo/relegation).")
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("group-size")
            .setDescription("Target players per division. Default 5. Lower = fewer games per player.")
            .setRequired(false)
            .setMinValue(2)
            .setMaxValue(20),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("min-group-size")
            .setDescription("Minimum players per division (smaller buckets stay unassigned). Default 3.")
            .setRequired(false)
            .setMinValue(2)
            .setMaxValue(20),
        )
        .addStringOption((opt) =>
          opt
            .setName("visibility")
            .setDescription("PUBLIC (default) = visible to players. INTERNAL = admin-only test season.")
            .setRequired(false)
            .addChoices(
              { name: "PUBLIC (visible to players)", value: "PUBLIC" },
              { name: "INTERNAL (admin-only, for testing)", value: "INTERNAL" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("info")
        .setDescription("Show the active season summary."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("activate")
        .setDescription("Activate a season (and demote whichever is currently active).")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Name of the season to activate")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("assign-player")
        .setDescription("Add a player to a division in the current season.")
        .addUserOption((opt) =>
          opt.setName("player").setDescription("Player to assign").setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("division")
            .setDescription("Division name (e.g. 'Rare 2')")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove-player")
        .setDescription("Remove a player from their division this season.")
        .addUserOption((opt) =>
          opt.setName("player").setDescription("Player to remove").setRequired(true),
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
        .setName("post-signup")
        .setDescription("Post a time-bounded signup round. Players click to join.")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Name of this signup round (e.g. 'Season 2 Signups')")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("finalize-signups")
        .setDescription("Lock the current open signup round so no more players can register.")
        .addStringOption((opt) =>
          opt
            .setName("round-id")
            .setDescription("Round ID (from the signup embed footer). Defaults to the most recent open round.")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("signups")
        .setDescription("List players signed up for the most recent open round."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("preview-from-signups")
        .setDescription("Preview the division layout that create-season with from-signups would produce.")
        .addStringOption((opt) =>
          opt.setName("round-id").setDescription("Finalized signup round id").setRequired(true),
        ),
    ),

  autocomplete: divisionNameAutocomplete,

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    // Owner-only subcommands
    if (sub === "set-role" || sub === "unset-role") {
      if (!(await requireOwner(interaction))) return;
      if (sub === "set-role") return setRole(interaction);
      return unsetRole(interaction);
    }
    // Everyone-readable
    if (sub === "list-roles") return listRoles(interaction);
    // Admin-or-above
    if (!(await requireAdmin(interaction))) return;
    if (sub === "create-season") return createSeason(interaction);
    if (sub === "info") return info(interaction);
    if (sub === "activate") return activateSeason(interaction);
    if (sub === "assign-player") return assignPlayer(interaction);
    if (sub === "remove-player") return removePlayer(interaction);
    if (sub === "post-signup") return postSignup(interaction);
    if (sub === "finalize-signups") return closeSignups(interaction);
    if (sub === "signups") return listSignups(interaction);
    if (sub === "preview-from-signups") return previewSeason(interaction);
  },
};

async function previewSeason(interaction: ChatInputCommandInteraction) {
  const roundId = interaction.options.getString("round-id", true);
  await interaction.deferReply();
  try {
    const plan = await planSeason(roundId);
    const lines: string[] = [`**Preview for round \`${roundId}\`**`];
    lines.push(
      `Bucket totals — Legendary ${plan.rarityCounts.LEGENDARY}, Rare ${plan.rarityCounts.RARE}, Uncommon ${plan.rarityCounts.UNCOMMON}, Common ${plan.rarityCounts.COMMON}`,
    );
    for (const div of plan.divisions) {
      if (div.signupIds.length === 0) {
        lines.push(`  • **${div.name}** — _empty_`);
      } else {
        lines.push(`  • **${div.name}** — ${div.signupIds.length} player(s)`);
      }
    }
    if (plan.warnings.length) {
      lines.push("", "⚠️ **Warnings**");
      for (const w of plan.warnings) lines.push(`  • ${w}`);
    }
    lines.push("", `Run \`/league create-season name:... from-signups:${roundId}\` to commit.`);
    await interaction.editReply(lines.join("\n"));
  } catch (err) {
    await interaction.editReply(`Plan failed: ${(err as Error).message}`);
  }
}

async function postSignup(interaction: ChatInputCommandInteraction) {
  const name = interaction.options.getString("name", true);
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText || !interaction.guildId) {
    await interaction.reply({
      content: "Run this in a regular text channel of your server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Create the round with placeholder message id, post the message, then fill the id in.
  const round = await prisma.signupRound.create({
    data: {
      name,
      guildId: interaction.guildId,
      channelId: channel.id,
      messageId: "pending",
    },
  });
  const message = await (channel as TextChannel).send({
    embeds: [signupEmbed(round, [])],
    components: [signupButtons(round)],
  });
  await prisma.signupRound.update({
    where: { id: round.id },
    data: { messageId: message.id },
  });

  await interaction.editReply(
    `Posted signup embed for **${name}**. Round id: \`${round.id}\` (use \`/league finalize-signups\` to lock it).`,
  );
}

async function closeSignups(interaction: ChatInputCommandInteraction) {
  const roundId = interaction.options.getString("round-id");
  await interaction.deferReply();

  const round = roundId
    ? await prisma.signupRound.findUnique({ where: { id: roundId } })
    : await prisma.signupRound.findFirst({
        where: { status: "OPEN" },
        orderBy: { openedAt: "desc" },
      });

  if (!round) {
    await interaction.editReply(
      roundId ? `No round with id \`${roundId}\`.` : "No open signup rounds.",
    );
    return;
  }
  if (round.status !== "OPEN") {
    await interaction.editReply(`Round **${round.name}** is already ${round.status.toLowerCase()}.`);
    return;
  }

  await prisma.signupRound.update({
    where: { id: round.id },
    data: { status: "CLOSED", closedAt: new Date() },
  });

  // Disable the buttons on the original signup message.
  try {
    const channel = await interaction.client.channels.fetch(round.channelId);
    if (channel?.type === ChannelType.GuildText) {
      const message = await (channel as TextChannel).messages.fetch(round.messageId);
      const updated = await prisma.signupRound.findUnique({ where: { id: round.id } });
      const signups = await prisma.signup.findMany({
        where: { roundId: round.id },
        orderBy: { signedUpAt: "asc" },
      });
      if (updated) {
        await message.edit({
          embeds: [signupEmbed(updated, signups)],
          components: [signupButtons(updated)],
        });
      }
    }
  } catch (err) {
    console.warn("Couldn't update signup message after close:", err);
  }

  const activeCount = await prisma.signup.count({
    where: { roundId: round.id, withdrawn: false },
  });
  await interaction.editReply(
    `Finalized **${round.name}**. ${activeCount} player(s) signed up. Next: \`/league create-season name:... from-signups:${round.id}\` to build a season from this round.`,
  );
}

async function listSignups(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const round = await prisma.signupRound.findFirst({
    orderBy: { openedAt: "desc" },
    include: {
      signups: {
        where: { withdrawn: false },
        orderBy: { signedUpAt: "asc" },
      },
    },
  });
  if (!round) {
    await interaction.editReply("No signup rounds yet. Use `/league post-signup` to start one.");
    return;
  }

  const lines = round.signups.length
    ? round.signups.map((s, i) => `${i + 1}. <@${s.discordId}>`).join("\n")
    : "_(none)_";
  await interaction.editReply(
    [
      `**${round.name}** — status: ${round.status}`,
      `${round.signups.length} signed up:`,
      lines,
    ].join("\n"),
  );
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
    await interaction.editReply(
      "No role bindings yet. The owner can set them with `/league set-role`.",
    );
    return;
  }

  const lines = bindings.map((b) => `  • **${b.tier}** — <@&${b.discordRoleId}>`);
  await interaction.editReply(["**Role bindings**", ...lines].join("\n"));
}

async function createSeason(interaction: ChatInputCommandInteraction) {
  const name = interaction.options.getString("name", true);
  const deadlineStr = interaction.options.getString("deadline");
  const buildDivisions = interaction.options.getBoolean("divisions") ?? true;
  const fromSignupsRoundId = interaction.options.getString("from-signups");
  const targetGroupSize = interaction.options.getInteger("group-size") ?? 5;
  const minGroupSize = interaction.options.getInteger("min-group-size") ?? 3;
  const visibility = (interaction.options.getString("visibility") ?? "PUBLIC") as "PUBLIC" | "INTERNAL";

  let deadline: Date | null = null;
  if (deadlineStr) {
    const parsed = new Date(deadlineStr);
    if (Number.isNaN(parsed.getTime())) {
      await interaction.reply({
        content: `Couldn't parse deadline \`${deadlineStr}\`. Use ISO format like \`2026-06-13T18:00:00Z\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    deadline = parsed;
  }

  await interaction.deferReply();

  // Path A: pull players from a finalized signup round (applies promo/relegation).
  if (fromSignupsRoundId) {
    try {
      const result = await commitSeason(fromSignupsRoundId, name, deadline, {
        targetGroupSize,
        minGroupSize,
      });
      await interaction.editReply(
        `✅ Created **${name}** from signup round \`${fromSignupsRoundId}\` (inactive).\n` +
          `${result.divisionsCreated} divisions, ${result.playersPlaced} players placed` +
          (result.unassigned ? `, ${result.unassigned} unassigned (groups too small).\n` : ".\n") +
          `Activate with \`/league activate name:${name}\` when ready.`,
      );
    } catch (err) {
      await interaction.editReply(`Couldn't create from signups: ${(err as Error).message}`);
    }
    return;
  }

  // Path B: empty season + (optionally) default-pyramid divisions, no players.
  const currentlyActive = await prisma.season.findFirst({ where: { isActive: true } });

  const season = await prisma.season.create({
    data: { name, deadline, isActive: false, targetGroupSize, minGroupSize, visibility },
  });

  let divisionsCreated = 0;
  if (buildDivisions) {
    for (const slot of DEFAULT_PYRAMID) {
      await prisma.division.create({
        data: {
          seasonId: season.id,
          rarity: slot.rarity,
          groupNumber: slot.groupNumber,
          name: slot.name,
        },
      });
      divisionsCreated++;
    }
  }

  const lines = [
    `✅ Created **${season.name}** (inactive — won't affect player commands until activated).`,
    currentlyActive ? `Currently active season: **${currentlyActive.name}** (untouched).` : null,
    deadline ? `Deadline: <t:${Math.floor(deadline.getTime() / 1000)}:F>` : null,
    buildDivisions ? `Created ${divisionsCreated} divisions.` : "No divisions created — add some via the dashboard.",
    `\nNext: use \`/league assign-player\` to populate divisions, then activate from the dashboard or with \`/league activate\` when ready.`,
  ].filter(Boolean);

  await interaction.editReply(lines.join("\n"));
}

async function activateSeason(interaction: ChatInputCommandInteraction) {
  const name = interaction.options.getString("name", true);
  await interaction.deferReply();

  const target = await prisma.season.findFirst({ where: { name } });
  if (!target) {
    await interaction.editReply(`No season named **${name}**.`);
    return;
  }
  if (target.isActive) {
    await interaction.editReply(`**${target.name}** is already the active season.`);
    return;
  }

  // Only demote a prior active season of the SAME visibility — PUBLIC and INTERNAL can both be active.
  const prior = await prisma.season.findFirst({
    where: { isActive: true, visibility: target.visibility },
  });
  if (prior && prior.id !== target.id) {
    await prisma.season.update({
      where: { id: prior.id },
      data: { isActive: false, endedAt: new Date() },
    });
  }
  await prisma.season.update({
    where: { id: target.id },
    data: { isActive: true, endedAt: null },
  });

  await interaction.editReply(
    prior && prior.id !== target.id
      ? `✅ **${target.name}** is now the active ${target.visibility} season. **${prior.name}** moved to inactive.`
      : `✅ **${target.name}** is now the active ${target.visibility} season.`,
  );
}

async function info(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const season = await prisma.season.findFirst({
    where: { isActive: true },
    include: {
      divisions: {
        include: { _count: { select: { members: true, pairings: true } } },
        orderBy: [{ rarity: "asc" }, { groupNumber: "asc" }],
      },
    },
  });

  if (!season) {
    await interaction.editReply("No active season. Use `/league create-season` to start one.");
    return;
  }

  const deadlineLine = season.deadline
    ? `Deadline: <t:${Math.floor(season.deadline.getTime() / 1000)}:F>`
    : "Deadline: none";

  // Group divisions by rarity for a compact summary
  const byRarity = new Map<string, typeof season.divisions>();
  for (const d of season.divisions) {
    if (!byRarity.has(d.rarity)) byRarity.set(d.rarity, []);
    byRarity.get(d.rarity)!.push(d);
  }

  const order = ["LEGENDARY", "RARE", "UNCOMMON", "COMMON"] as const;
  const divisionLines: string[] = [];
  for (const r of order) {
    const divs = byRarity.get(r);
    if (!divs || divs.length === 0) continue;
    for (const d of divs) {
      divisionLines.push(
        `  • **${d.name}** — ${d._count.members}/${season.targetGroupSize} players, ${d._count.pairings} sets`,
      );
    }
  }

  await interaction.editReply(
    [
      `**${season.name}**`,
      deadlineLine,
      `Divisions (${season.divisions.length}):`,
      ...(divisionLines.length ? divisionLines : ["  _(none yet)_"]),
    ].join("\n"),
  );
}

async function assignPlayer(interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser("player", true);
  const divisionName = interaction.options.getString("division", true);
  await interaction.deferReply();

  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    await interaction.editReply("No active season.");
    return;
  }

  const division = await prisma.division.findFirst({
    where: { seasonId: season.id, name: divisionName },
    include: { _count: { select: { members: true } } },
  });
  if (!division) {
    await interaction.editReply(
      `No division named \`${divisionName}\` in **${season.name}**. Use \`/league info\` to see division names.`,
    );
    return;
  }

  if (division._count.members >= season.targetGroupSize) {
    await interaction.editReply(
      `**${division.name}** already has ${division._count.members} players (max ${season.targetGroupSize}).`,
    );
    return;
  }

  const player = await getOrCreatePlayer(user);

  // Reject if the player is already in any division this season.
  const existing = await prisma.divisionMember.findFirst({
    where: { playerId: player.id, division: { seasonId: season.id } },
    include: { division: true },
  });
  if (existing) {
    await interaction.editReply(
      `${user.username} is already in **${existing.division.name}** this season. Use \`/league remove-player\` first to move them.`,
    );
    return;
  }

  await prisma.divisionMember.create({
    data: { divisionId: division.id, playerId: player.id },
  });

  await interaction.editReply(
    `Added **${user.username}** to **${division.name}** (${division._count.members + 1}/${season.targetGroupSize}).`,
  );
}

async function removePlayer(interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser("player", true);
  await interaction.deferReply();

  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    await interaction.editReply("No active season.");
    return;
  }

  const player = await getOrCreatePlayer(user);
  const membership = await prisma.divisionMember.findFirst({
    where: { playerId: player.id, division: { seasonId: season.id } },
    include: { division: true },
  });
  if (!membership) {
    await interaction.editReply(`${user.username} isn't in any division this season.`);
    return;
  }

  // Refuse if they have confirmed pairings — that's a transfer, not a remove.
  const playedCount = await prisma.pairing.count({
    where: {
      divisionId: membership.divisionId,
      status: "CONFIRMED",
      OR: [{ playerAId: player.id }, { playerBId: player.id }],
    },
  });
  if (playedCount > 0) {
    await interaction.editReply(
      `${user.username} has ${playedCount} confirmed set(s) in **${membership.division.name}**. ` +
        `Removing them would orphan those results — use a transfer flow instead (coming soon).`,
    );
    return;
  }

  await prisma.divisionMember.delete({ where: { id: membership.id } });
  await interaction.editReply(`Removed **${user.username}** from **${membership.division.name}**.`);
}

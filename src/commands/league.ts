// Slim /league command — initial server setup + role-tier bindings only.
// Everything else (create-season, signups, assign-player, etc.) moved to
// the web dashboard at www.balatroleague.com.

import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { PLAYER_COMMANDS } from "./help.js";
import { PermissionTier } from "@prisma/client";
import { prisma } from "../db.js";
import { PERM_PRESETS, editChannelMessage, postChannelMessage } from "../discord-helpers.js";
import { webUrl, WEB_HOST } from "../web-url.js";
import { clearConfig, getConfig, LeagueConfigKey, setConfig } from "../league-config.js";
import { requireOwner } from "../permissions.js";
import { enqueueLeagueInfoRefresh, enqueueStandingsRefresh, renderDivisionWelcome } from "../queue.js";
import { activePublicSeason } from "../active-season.js";
import { formatSeasonLabel } from "../format-season.js";
import type { SlashCommand } from "./types.js";

const WEBHOOK_URL_RE = /^https:\/\/(discord\.com|discordapp\.com)\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+$/;

export const league: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("league")
    .setDescription("League server setup + permission management.")
    // Hide from non-admin members in the slash-command picker.
    // Bot still runs its own RoleBinding tier check per subcommand
    // (OWNER for bootstrap/set-role, etc.). Server admins can grant
    // access to specific roles via Server Settings → Integrations
    // → bot if they want a broader audience.
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString())
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
              { name: "HELPER", value: "HELPER" },
              { name: "DEVOPS", value: "DEVOPS" },
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
    )
    .addSubcommand((sub) =>
      sub
        .setName("reset-discord-state")
        .setDescription("Clear every Discord ID stored in the DB so bootstrap can rebuild fresh. Owner only.")
        .addStringOption((opt) =>
          opt
            .setName("confirmation")
            .setDescription("Type RESET DISCORD STATE to confirm. League data (seasons, players, results) is preserved.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("check-setup")
        .setDescription("Diagnose what's configured vs missing: channels, webhook, role bindings, presets."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("refresh-welcome")
        .setDescription("Re-render each division's welcome message in place (no re-post, no re-ping)."),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "list-roles") return listRoles(interaction);
    if (sub === "check-setup") return checkSetup(interaction);
    // Owner-only for state-changing role-binding + bootstrap + webhook config
    if (!(await requireOwner(interaction))) return;
    if (sub === "bootstrap-server") return bootstrapServer(interaction);
    if (sub === "set-role") return setRole(interaction);
    if (sub === "unset-role") return unsetRole(interaction);
    if (sub === "setup-results-webhook") return setupResultsWebhook(interaction);
    if (sub === "set-results-webhook") return setResultsWebhook(interaction);
    if (sub === "unset-results-webhook") return unsetResultsWebhook(interaction);
    if (sub === "reset-discord-state") return resetDiscordState(interaction);
    if (sub === "refresh-welcome") return refreshWelcome(interaction);
  },
};

// Re-render each active-season division's welcome message in place. Edits the
// stored message (ping-free) so updated wording/rosters reach players without a
// new post or a re-ping. Re-posts only if the original message is gone.
async function refreshWelcome(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const season = await activePublicSeason();
  if (!season) {
    await interaction.editReply("No active season right now.");
    return;
  }
  const divisions = await prisma.division.findMany({
    where: { seasonId: season.id, discordChannelId: { not: null } },
    select: {
      id: true,
      name: true,
      discordChannelId: true,
      welcomeMessageId: true,
      members: { where: { status: "ACTIVE" }, select: { player: { select: { discordId: true } } } },
    },
  });
  const label = formatSeasonLabel(season);
  let edited = 0;
  let reposted = 0;
  let failed = 0;
  for (const div of divisions) {
    if (!div.discordChannelId || div.members.length === 0) continue;
    const content = await renderDivisionWelcome(div, label);
    let ok = false;
    if (div.welcomeMessageId) {
      ok = await editChannelMessage(div.discordChannelId, div.welcomeMessageId, content);
      if (ok) edited++;
    }
    if (!ok) {
      // No stored id, or the old message was deleted → post a fresh (ping-free) one.
      const newId = await postChannelMessage(div.discordChannelId, content);
      if (newId) {
        await prisma.division.update({ where: { id: div.id }, data: { welcomeMessageId: newId } });
        reposted++;
      } else {
        failed++;
      }
    }
  }
  await interaction.editReply(
    `🔄 Welcome messages refreshed — **${edited}** edited in place` +
      (reposted ? `, **${reposted}** re-posted (original missing)` : "") +
      (failed ? `, **${failed}** failed` : "") +
      `. No pings sent.`,
  );
}

async function bootstrapServer(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Run this command in your league's Discord server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const categoryName = interaction.options.getString("category-name") ?? "🃏 Balatro League";

  // Defer ephemeral so the running summary doesn't dump into a public
  // channel — the final long output goes to the runner's DMs.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

    // Honor a pre-configured league category id (set in /admin/config) when it
    // still resolves — lets bootstrap target an existing category on a server
    // the bot didn't create. Otherwise find-or-create by the (option) name.
    const configuredCatId = await getConfig(LeagueConfigKey.LeagueCategoryId);
    let category = configuredCatId
      ? guild.channels.cache.find((c) => c.id === configuredCatId && c.type === ChannelType.GuildCategory)
      : undefined;
    if (category) {
      reused.push(`category "${category.name}" (from config)`);
    } else {
      category = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === categoryName,
      );
      if (!category) {
        category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
        created.push(`category "${categoryName}"`);
      } else {
        reused.push(`category "${categoryName}"`);
      }
    }
    const categoryId = category.id;
    // Persist the resolved id so the per-channel auto-create helpers + the web
    // all reference the same league category.
    await setConfig(LeagueConfigKey.LeagueCategoryId, categoryId, interaction.user.id);

    // Tracks whether each ensured channel was newly created — used below
     // to decide whether to seed it with onboarding messages (we don't want
     // to spam an existing channel admin has already curated).
    const justCreated = new Set<string>();
    async function ensureChannel(
      name: string,
      topic: string,
      type: ChannelType.GuildText | ChannelType.GuildAnnouncement = ChannelType.GuildText,
      configKey?: LeagueConfigKey,
    ) {
      // 0. Pinned id wins — and it's GUILD-SCOPED. If an admin set this
      // channel's id in /admin/config and that id still resolves *in this
      // guild*, adopt that exact channel: rename it to the canonical name,
      // reparent it into the league category, and fix its type as needed.
      // Every change is an in-place edit — same id, same messages/history/pins,
      // nothing re-created. The lookup is against this guild's cache only, so a
      // stale id pointing at another server (mid-move, when the bot is in both)
      // is simply not found here and is ignored — never reached across and
      // renamed/hijacked.
      if (configKey) {
        const pinnedId = await getConfig(configKey);
        const pinned =
          pinnedId &&
          guild.channels.cache.find(
            (c) =>
              c.id === pinnedId &&
              (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement),
          );
        if (
          pinned &&
          (pinned.type === ChannelType.GuildText || pinned.type === ChannelType.GuildAnnouncement)
        ) {
          let changed = false;
          if (pinned.name !== name) {
            const from = pinned.name;
            await pinned.edit({ name }).then(
              () => {
                created.push(`#${from} → #${name} (renamed — pinned id)`);
                changed = true;
              },
              () => reused.push(`#${from} (couldn't rename to #${name} — rename it manually)`),
            );
          }
          if (pinned.parentId !== categoryId) {
            await pinned.edit({ parent: categoryId }).then(
              () => {
                created.push(`#${name} (moved into ${categoryName})`);
                changed = true;
              },
              () => reused.push(`#${name} (couldn't move into ${categoryName} — move it manually)`),
            );
          }
          if (pinned.type !== type) {
            await pinned.edit({ type }).then(
              () => {
                created.push(
                  `#${name} (converted to ${type === ChannelType.GuildAnnouncement ? "announcement" : "text"} channel)`,
                );
                changed = true;
              },
              () => reused.push(`#${name} (couldn't convert type — convert it manually)`),
            );
          }
          if (!changed) reused.push(`#${name} (pinned id, already correct)`);
          return pinned;
        }
      }
      // 1. Otherwise reuse a channel that ALREADY has this EXACT canonical name
      // in the league category. No alias / "similar name" guessing — that's what
      // let setup grab and rename the wrong channel. We only adopt an exact name
      // match (so a hand-made #league-results-bot isn't duplicated) or, failing
      // that, create a fresh one. No renaming here: the name already matches.
      const existing = guild.channels.cache.find(
        (c) =>
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
          c.name === name &&
          c.parentId === categoryId,
      );
      if (
        existing &&
        (existing.type === ChannelType.GuildText || existing.type === ChannelType.GuildAnnouncement)
      ) {
        // Convert in place if it's the wrong type (e.g. #league-announcements
        // made as a plain text channel before Community was enabled).
        if (existing.type !== type) {
          await existing.edit({ type }).then(
            () =>
              created.push(
                `#${name} (converted to ${type === ChannelType.GuildAnnouncement ? "announcement" : "text"} channel)`,
              ),
            () => reused.push(`#${name} (couldn't convert type — convert it manually in channel settings)`),
          );
        } else {
          reused.push(`#${name}`);
        }
        return existing;
      }
      try {
        const ch = await guild.channels.create({ name, type, parent: categoryId, topic });
        created.push(`#${name}`);
        justCreated.add(ch.id);
        return ch;
      } catch (err) {
        // Announcement channels (type 5) require a Community-enabled server.
        // On a non-Community guild Discord rejects the type outright
        // (BASE_TYPE_CHOICES) — fall back to a normal text channel so
        // bootstrap still succeeds. The bot posts via REST regardless of type.
        if (type !== ChannelType.GuildText) {
          const ch = await guild.channels.create({ name, type: ChannelType.GuildText, parent: categoryId, topic });
          created.push(`#${name} (text channel — enable Community on the server to make it a proper announcement channel)`);
          justCreated.add(ch.id);
          return ch;
        }
        throw err;
      }
    }
    // All public channels are "league-" prefixed so they don't collide with a
    // server's own generic #results / #signups / #announcements when the bot
    // joins an existing community. Each ensureChannel adopts the channel pinned
    // in /admin/config by id, else an existing channel of the exact same name,
    // else creates it — no fuzzy/alias matching.
    const infoChan = await ensureChannel("league-info", "League rules, schedule, announcements. Read-only for most.", ChannelType.GuildText, LeagueConfigKey.LeagueInfoChannelId);
    const signupChan = await ensureChannel("league-signups", "Signup embeds posted here by the web admin. Players click the button to register.", ChannelType.GuildText, LeagueConfigKey.SignupsChannelId);
    const resultsChan = await ensureChannel("league-results-bot", "Bot-only: match results auto-post here. Players can react + use slash commands but can't post.", ChannelType.GuildText, LeagueConfigKey.ResultsChannelId);
    const chatChan = await ensureChannel("league-chat", "General league chat. Match scheduling, banter, etc.", ChannelType.GuildText, LeagueConfigKey.GeneralChannelId);
    const botCmdChan = await ensureChannel("league-bot-commands", "General bot commands: /random, /profile, /standings, etc. Most replies are private (only you see them) so you can run commands from any channel.", ChannelType.GuildText, LeagueConfigKey.BotCommandsChannelId);
    const standingsChan = await ensureChannel("league-standings", "📊 Live standings for the active season — auto-updated by the bot. Read-only.", ChannelType.GuildText, LeagueConfigKey.StandingsChannelId);
    const helpChan = await ensureChannel("league-help", "📖 All the bot commands. You can also type /help anywhere.", ChannelType.GuildText, LeagueConfigKey.HelpChannelId);
    const announcementsChan = await ensureChannel(
      "league-announcements",
      "League-wide announcements: season starts, recaps, league news. Bot-posted, read-only for members.",
      ChannelType.GuildAnnouncement,
      LeagueConfigKey.AnnouncementsChannelId,
    );
    const feedbackChan = await ensureChannel(
      "league-feedback",
      "Player feedback, suggestions, and bug reports for the league. Everyone can post.",
      ChannelType.GuildText,
      LeagueConfigKey.FeedbackChannelId,
    );

    // Persist channel ids in LeagueConfig so the bot's per-channel
    // resolvers (command-channels.ts, announcements-channel.ts, etc.)
    // pick them up without admin having to set env vars, and the
    // boot-time auto-create hooks no-op (they only fire when neither
    // env var nor LeagueConfig has a value).
    await prisma.leagueConfig.upsert({
      where: { key: "bot_commands_channel_id" },
      create: { key: "bot_commands_channel_id", value: botCmdChan.id, updatedBy: interaction.user.id },
      update: { value: botCmdChan.id, updatedBy: interaction.user.id },
    });
    await prisma.leagueConfig.upsert({
      where: { key: "standings_channel_id" },
      create: { key: "standings_channel_id", value: standingsChan.id, updatedBy: interaction.user.id },
      update: { value: standingsChan.id, updatedBy: interaction.user.id },
    });
    await prisma.leagueConfig.upsert({
      where: { key: "help_channel_id" },
      create: { key: "help_channel_id", value: helpChan.id, updatedBy: interaction.user.id },
      update: { value: helpChan.id, updatedBy: interaction.user.id },
    });
    await prisma.leagueConfig.upsert({
      where: { key: "announcements_channel_id" },
      create: { key: "announcements_channel_id", value: announcementsChan.id, updatedBy: interaction.user.id },
      update: { value: announcementsChan.id, updatedBy: interaction.user.id },
    });
    await prisma.leagueConfig.upsert({
      where: { key: "results_channel_id" },
      create: { key: "results_channel_id", value: resultsChan.id, updatedBy: interaction.user.id },
      update: { value: resultsChan.id, updatedBy: interaction.user.id },
    });
    await prisma.leagueConfig.upsert({
      where: { key: "league_info_channel_id" },
      create: { key: "league_info_channel_id", value: infoChan.id, updatedBy: interaction.user.id },
      update: { value: infoChan.id, updatedBy: interaction.user.id },
    });
    await prisma.leagueConfig.upsert({
      where: { key: "signups_channel_id" },
      create: { key: "signups_channel_id", value: signupChan.id, updatedBy: interaction.user.id },
      update: { value: signupChan.id, updatedBy: interaction.user.id },
    });
    await prisma.leagueConfig.upsert({
      where: { key: "feedback_channel_id" },
      create: { key: "feedback_channel_id", value: feedbackChan.id, updatedBy: interaction.user.id },
      update: { value: feedbackChan.id, updatedBy: interaction.user.id },
    });
    await prisma.leagueConfig.upsert({
      where: { key: "general_channel_id" },
      create: { key: "general_channel_id", value: chatChan.id, updatedBy: interaction.user.id },
      update: { value: chatChan.id, updatedBy: interaction.user.id },
    });

    // Lock #league-results-bot to bot-only posting: @everyone keeps view +
    // slash commands + reactions but can't send messages; the bot can post.
    // Best-effort + idempotent (re-running re-applies) — a perms hiccup here
    // must not abort the whole bootstrap.
    try {
      await resultsChan.permissionOverwrites.edit(guild.roles.everyone.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        UseApplicationCommands: true,
        AddReactions: true,
        SendMessages: false,
        SendMessagesInThreads: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
      });
      await resultsChan.permissionOverwrites.edit(interaction.client.user.id, {
        ViewChannel: true,
        SendMessages: true,
        SendMessagesInThreads: true,
        EmbedLinks: true,
        AttachFiles: true,
        ManageMessages: true,
        ManageWebhooks: true,
      });
    } catch (err) {
      console.warn("[bootstrap] couldn't lock #league-results-bot:", err);
      reused.push("#league-results-bot (couldn't set bot-only perms — set '@everyone: deny Send Messages' manually)");
    }

    // Read-only lock for bot/staff-maintained channels: @everyone can view +
    // read history (and react, only if allowReactions) but can't post; the bot
    // can. Best-effort + idempotent — a perms hiccup must not abort bootstrap.
    async function lockReadOnly(
      channel: Awaited<ReturnType<typeof ensureChannel>>,
      label: string,
      allowReactions: boolean,
    ) {
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
          ViewChannel: true,
          ReadMessageHistory: true,
          AddReactions: allowReactions,
          SendMessages: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
        });
        await channel.permissionOverwrites.edit(interaction.client.user.id, {
          ViewChannel: true,
          SendMessages: true,
          EmbedLinks: true,
          AttachFiles: true,
          ManageMessages: true,
        });
      } catch (err) {
        console.warn(`[bootstrap] couldn't lock ${label}:`, err);
        reused.push(`${label} (couldn't set read-only perms — set '@everyone: deny Send Messages' manually)`);
      }
    }
    // Postable lock for channels members chat in: explicitly GRANT @everyone the
    // full posting set so it doesn't depend on the server's base @everyone role.
    // Some servers strip Attach Files / Embed Links / Add Reactions from
    // @everyone to curb spam — without an explicit allow here, members could
    // type text but not post images, links, or react. Best-effort + idempotent.
    async function lockPostable(
      channel: Awaited<ReturnType<typeof ensureChannel>>,
      label: string,
    ) {
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
          SendMessagesInThreads: true,
          AddReactions: true,
          EmbedLinks: true,
          AttachFiles: true,
          UseExternalEmojis: true,
          UseApplicationCommands: true,
        });
      } catch (err) {
        console.warn(`[bootstrap] couldn't set ${label} postable:`, err);
        reused.push(`${label} (couldn't grant @everyone posting perms — set 'Attach Files' + 'Embed Links' manually)`);
      }
    }
    // Reactions are allowed only in #league-announcements (engagement on news);
    // #league-info and #league-signups stay fully silent.
    await lockReadOnly(infoChan, "#league-info", false);
    await lockReadOnly(announcementsChan, "#league-announcements", true);
    await lockReadOnly(signupChan, "#league-signups", false);
    await lockReadOnly(standingsChan, "#league-standings", false);
    await lockReadOnly(helpChan, "#league-help", false);

    // Post (or refresh) the pinned command list in #league-help. Idempotent —
    // edits the bot's stored message if it exists, else posts + pins a new one,
    // so re-running setup keeps the list current without duplicating it.
    try {
      const helpEmbed = new EmbedBuilder()
        .setTitle("📖 League commands")
        .setColor(0x5865f2)
        .setDescription(PLAYER_COMMANDS.map((c) => `• \`${c.cmd}\` — ${c.desc}`).join("\n"))
        .setFooter({ text: "Run any of these, or just type /help anywhere." });
      const helpContent = `Sign up in <#${signupChan.id}> · Standings + history on the website: <${webUrl()}>`;
      const helpTextChan = helpChan as TextChannel;
      const storedId = await getConfig(LeagueConfigKey.HelpMessageId);
      let edited = false;
      if (storedId) {
        const existing = await helpTextChan.messages.fetch(storedId).catch(() => null);
        if (existing && existing.author.id === interaction.client.user?.id) {
          await existing.edit({ content: helpContent, embeds: [helpEmbed] });
          edited = true;
        }
      }
      if (!edited) {
        const sent = await helpTextChan.send({ content: helpContent, embeds: [helpEmbed] });
        await sent.pin().catch(() => {});
        await setConfig(LeagueConfigKey.HelpMessageId, sent.id, interaction.user.id);
      }
    } catch (err) {
      console.warn("[bootstrap] couldn't post #league-help message:", (err as Error).message);
      reused.push("#league-help (couldn't post the command list — re-run /league setup)");
    }
    // The members-chat channels: explicitly postable (images/links/reactions)
    // regardless of the server's base @everyone perms.
    await lockPostable(chatChan, "#league-chat");
    await lockPostable(botCmdChan, "#league-bot-commands");
    await lockPostable(feedbackChan, "#league-feedback");

    // Human-facing results channel — open for manual posting if the bot's
    // auto-post in #league-results-bot ever has an issue. Created after the
    // bot channel so the old "league-results" was already renamed away.
    const humanResultsChan = await ensureChannel(
      "league-results",
      "Post results here manually if the bot's auto-post in #league-results-bot ever misses one. Open to everyone.",
      ChannelType.GuildText,
      LeagueConfigKey.ResultsHumanChannelId,
    );
    await prisma.leagueConfig.upsert({
      where: { key: "results_human_channel_id" },
      create: { key: "results_human_channel_id", value: humanResultsChan.id, updatedBy: interaction.user.id },
      update: { value: humanResultsChan.id, updatedBy: interaction.user.id },
    });
    // Explicitly ensure #league-results is POSTABLE by everyone — including
    // images/links. It's the human-postable backup, but an earlier rename could
    // have left a stale bot-only deny overwrite; lockPostable clears that and
    // grants the full posting set.
    await lockPostable(humanResultsChan, "#league-results");

    // Auto-create a Match Results webhook on #results so the announce
    // path uses the webhook (preferred — gives nicer formatting + no
    // rate-limit risk on the bot's own user). Only fires when the
    // LeagueConfig key isn't already set so re-running bootstrap
    // doesn't keep spawning duplicate webhooks. Falls back silently
    // when the bot lacks Manage Webhooks — admin can run
    // /league setup-results-webhook later.
    const existingWebhook = await prisma.leagueConfig.findUnique({
      where: { key: "results_webhook_url" },
    });
    let webhookWarning: string | null = null;
    if (!existingWebhook && resultsChan.type === ChannelType.GuildText) {
      try {
        const wh = await (resultsChan as TextChannel).createWebhook({
          name: "Match Results",
          reason: `Auto-created by /league bootstrap-server (by ${interaction.user.tag})`,
        });
        if (wh.url) {
          await prisma.leagueConfig.upsert({
            where: { key: "results_webhook_url" },
            create: { key: "results_webhook_url", value: wh.url, updatedBy: interaction.user.id },
            update: { value: wh.url, updatedBy: interaction.user.id },
          });
          created.push("results-channel webhook");
        }
      } catch (err) {
        const msg = (err as Error).message;
        console.warn(`[bootstrap] couldn't auto-create results webhook: ${msg}`);
        webhookWarning = msg;
      }
    }

    // Always (re-)seed #league-info with a pinned 'how it works' message.
    // If the bot already pinned one, edit it in place so re-running bootstrap
    // refreshes the content; otherwise post + pin a new one. Idempotent.
    const intro = [
      "# 🃏 Welcome to the league",
      "",
      "**How it works**",
      "• Each season splits players into tiers + divisions by rating.",
      "• Inside a division you play a set of opponents, **2 games each** — top divisions play everyone, the rest play **4 others**. Run `/schedule` to see your matchups.",
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
      "• `/schedule` — matches you still need to play",
      "• `/start-match @opponent` — bot walks you and your opponent through ban/pick for each game",
      "• `/report @opponent result:2-0` — log a played match (auto-confirmed)",
      "• `/help` — full command list",
      "",
      `**Website:** <${webUrl()}> — standings, profiles, signup, settings.`,
    ].join("\n");
    // Trigger the league-info pinned message refresh via the queue
    // worker (composes static intro + dynamic state). Falls back to a
    // synchronous post if the queue isn't reachable so first-time
    // bootstrap still produces a visible message.
    let refreshQueued = false;
    try {
      await enqueueLeagueInfoRefresh();
      refreshQueued = true;
      reused.push("#league-info pinned message (queued refresh)");
    } catch (qErr) {
      console.warn(`[bootstrap] league-info refresh enqueue failed: ${(qErr as Error).message}`);
    }
    // Populate #league-standings now (also re-renders every 15 min).
    await enqueueStandingsRefresh().catch((qErr) =>
      console.warn(`[bootstrap] standings refresh enqueue failed: ${(qErr as Error).message}`),
    );
    if (!refreshQueued) {
      try {
        const pinned = await infoChan.messages.fetchPinned();
        const existing = pinned.find((m) => m.author.id === interaction.client.user.id);
        if (existing) {
          await existing.edit({ content: intro });
          reused.push(`#league-info pinned intro (refreshed inline)`);
        } else {
          const msg = await infoChan.send({ content: intro });
          await msg.pin().catch(() => { /* MANAGE_MESSAGES may be missing */ });
          created.push(`#league-info pinned intro`);
        }
      } catch (e) {
        console.warn(`[bootstrap] couldn't seed/refresh intro in #league-info: ${(e as Error).message}`);
      }
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
    const helperRole = await ensureRole("League Helper", "Created by /league bootstrap-server — bound to bot's HELPER tier");
    const devopsRole = await ensureRole("League DevOps", "Created by /league bootstrap-server — bound to bot's DEVOPS tier (infra alerts only)");

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
        where: { discordRoleId: helperRole.id },
        create: { discordRoleId: helperRole.id, tier: "HELPER", createdBy: interaction.user.id },
        update: { tier: "HELPER" },
      }),
      prisma.roleBinding.upsert({
        where: { discordRoleId: devopsRole.id },
        create: { discordRoleId: devopsRole.id, tier: "DEVOPS", createdBy: interaction.user.id },
        update: { tier: "DEVOPS" },
      }),
    ]);

    // Backup channel — admin/helper-only via permission overwrites. Needs
    // the staff role IDs we just upserted, so it lives after ensureRole.
    // DevOps channel. Infra alerts
    // (queue stalls, rate-limit floods) post here pinging @League DevOps
    // and don't bother league admins who can't act on tech issues.
    async function ensureDevopsChan() {
      const existing = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText &&
          (c.name === "league-devops" || c.name === "devops") &&
          c.parentId === categoryId,
      );
      if (existing && existing.type === ChannelType.GuildText) {
        if (existing.name !== "league-devops") {
          await existing.edit({ name: "league-devops" }).then(
            () => created.push(`#devops → #league-devops (renamed)`),
            () => reused.push(`#devops (couldn't rename to #league-devops — rename it manually)`),
          );
        } else {
          reused.push(`#league-devops`);
        }
        return existing;
      }
      const ch = await guild.channels.create({
        name: "league-devops",
        type: ChannelType.GuildText,
        parent: categoryId,
        topic: "🔧 Infra alerts: queue stalls, rate-limit floods, anything tech. DevOps-only.",
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: devopsRole.id, allow: [...PERM_PRESETS.MEMBER_ALLOW] },
          // Bot itself needs the wider BOT_ALLOW set so it can manage
          // its own alert messages (edit/delete) in addition to posting.
          { id: interaction.client.user.id, allow: [...PERM_PRESETS.BOT_ALLOW] },
        ],
      });
      created.push(`#league-devops (private, DevOps-only)`);
      return ch;
    }
    const devopsChan = await ensureDevopsChan();
    await prisma.leagueConfig.upsert({
      where: { key: "devops_channel_id" },
      create: { key: "devops_channel_id", value: devopsChan.id, updatedBy: interaction.user.id },
      update: { value: devopsChan.id, updatedBy: interaction.user.id },
    });

    // Admin chat — private coordination channel for league staff (admins +
    // helpers + owners). The bot doesn't post here; it's stored as
    // admin_channel_id so the site/bot can reference it. Staff-only via
    // @everyone deny-ViewChannel + per-role allows.
    async function ensureAdminChan() {
      const existing = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText &&
          (c.name === "league-admin" || c.name === "admin-chat") &&
          c.parentId === categoryId,
      );
      if (existing && existing.type === ChannelType.GuildText) {
        if (existing.name !== "league-admin") {
          await existing.edit({ name: "league-admin" }).then(
            () => created.push(`#admin-chat → #league-admin (renamed)`),
            () => reused.push(`#admin-chat (couldn't rename to #league-admin — rename it manually)`),
          );
        } else {
          reused.push(`#league-admin`);
        }
        return existing;
      }
      const ownerBindings = await prisma.roleBinding.findMany({ where: { tier: "OWNER" } });
      const ch = await guild.channels.create({
        name: "league-admin",
        type: ChannelType.GuildText,
        parent: categoryId,
        topic: "🛠️ League staff chat — admins & helpers coordinate here. Staff-only.",
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: adminRole.id, allow: [...PERM_PRESETS.MEMBER_ALLOW] },
          { id: helperRole.id, allow: [...PERM_PRESETS.MEMBER_ALLOW] },
          ...ownerBindings.map((b) => ({ id: b.discordRoleId, allow: [...PERM_PRESETS.MEMBER_ALLOW] })),
          { id: interaction.client.user.id, allow: [...PERM_PRESETS.BOT_ALLOW] },
        ],
      });
      created.push(`#league-admin (private, staff-only)`);
      return ch;
    }
    const adminChan = await ensureAdminChan();
    await prisma.leagueConfig.upsert({
      where: { key: "admin_channel_id" },
      create: { key: "admin_channel_id", value: adminChan.id, updatedBy: interaction.user.id },
      update: { value: adminChan.id, updatedBy: interaction.user.id },
    });

    // Support channel: where /support opens private ticket threads. Created
    // under the league category like every other channel (id-or-exact-name-or-
    // create), and the id stored. If a loose top-level "#support" already exists
    // and is pinned in support_channel_id, this adopts it — renaming it to
    // league-support and moving it into the league category.
    const supportChan = await ensureChannel(
      "league-support",
      "Need help? Run /support to open a private ticket — a league helper will be pinged.",
      ChannelType.GuildText,
      LeagueConfigKey.SupportChannelId,
    );
    await prisma.leagueConfig.upsert({
      where: { key: "support_channel_id" },
      create: { key: "support_channel_id", value: supportChan.id, updatedBy: interaction.user.id },
      update: { value: supportChan.id, updatedBy: interaction.user.id },
    });
    // Read-only parent: members open tickets via /support (which spins up a
    // private thread); they don't post in the channel itself. No reactions.
    await lockReadOnly(supportChan, "#league-support", false);

    // Casual matches get their own '🎴 Matches' category with a single
    // #challenges parent channel — /challenge threads spawn there.
    // Separate category from the league category so casual play has a
    // visually distinct home (and matches don't clutter the bot-commands
    // channel where the invite is posted).
    const configuredMatchesCatId = await getConfig(LeagueConfigKey.MatchesCategoryId);
    let matchesCategory = configuredMatchesCatId
      ? guild.channels.cache.find((c) => c.id === configuredMatchesCatId && c.type === ChannelType.GuildCategory)
      : undefined;
    if (matchesCategory) {
      reused.push(`category "${matchesCategory.name}" (from config)`);
    } else {
      matchesCategory = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === "🎴 Matches",
      );
      if (!matchesCategory) {
        matchesCategory = await guild.channels.create({ name: "🎴 Matches", type: ChannelType.GuildCategory });
        created.push(`category "🎴 Matches"`);
      } else {
        reused.push(`category "🎴 Matches"`);
      }
    }
    await setConfig(LeagueConfigKey.MatchesCategoryId, matchesCategory.id, interaction.user.id);
    let challengesChan = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        c.name === "challenges" &&
        c.parentId === matchesCategory!.id,
    );
    if (!challengesChan || challengesChan.type !== ChannelType.GuildText) {
      challengesChan = await guild.channels.create({
        name: "challenges",
        type: ChannelType.GuildText,
        parent: matchesCategory.id,
        topic: "Casual /challenge matches spawn private threads here. Browse the thread list for active games.",
      });
      created.push(`#challenges (under 🎴 Matches)`);
    } else {
      reused.push(`#challenges`);
    }
    await prisma.leagueConfig.upsert({
      where: { key: "challenges_channel_id" },
      create: { key: "challenges_channel_id", value: challengesChan.id, updatedBy: interaction.user.id },
      update: { value: challengesChan.id, updatedBy: interaction.user.id },
    });

    const lines = [
      `✅ **${categoryName}** scaffolded.`,
      created.length > 0 ? `  Created: ${created.join(", ")}` : `  (nothing new — everything already existed)`,
      reused.length > 0 ? `  Reused: ${reused.join(", ")}` : null,
      webhookWarning
        ? `\n⚠️ **Match Results webhook didn't get created** — the bot probably needs **Manage Webhooks** in <#${resultsChan.id}>. Either:\n  • Grant the bot Manage Webhooks at the channel or category level, OR\n  • Create the webhook manually in **#league-results-bot → Edit Channel → Integrations → Webhooks**, then paste the URL via \`/league set-results-webhook url:<url>\`\n  Error: \`${webhookWarning}\``
        : null,
      ``,
      `📌 <#${infoChan.id}> — league-info`,
      `📝 <#${signupChan.id}> — league-signups`,
      `🏆 <#${resultsChan.id}> — league-results-bot (bot-only auto-post target)`,
      `🏆 <#${humanResultsChan.id}> — league-results (humans post here manually if needed)`,
      `📣 <#${announcementsChan.id}> — league-announcements (season starts, recaps)`,
      `💬 <#${chatChan.id}> — league-chat`,
      `🗣️ <#${feedbackChan.id}> — league-feedback (player suggestions + bug reports)`,
      `🤖 <#${botCmdChan.id}> — league-bot-commands (casual /challenge, /report)`,
      `🔧 <#${devopsChan.id}> — league-devops (DevOps-only, queue stalls + infra alerts)`,
      `🛠️ <#${adminChan.id}> — league-admin (staff-only chat)`,
      `🎴 <#${challengesChan.id}> — challenges (parent for casual /challenge threads, under 🎴 Matches)`,
      ``,
      `🎭 Roles:`,
      `• <@&${playerRole.id}> — League Player`,
      `• <@&${adminRole.id}> — League Admin (bound to ADMIN tier)`,
      `• <@&${helperRole.id}> — League Helper (bound to HELPER tier)`,
      ``,
      `Assign Admin/Helper to staff in **Server Settings → Members** and they immediately get the matching permissions on ${WEB_HOST}.`,
      ``,
      `**One-time per-server setup** — \`/admin\` and \`/league\` are hidden from non-server-admins in the slash-command picker. To let \`@League Admin\` see them without granting Discord Administrator:`,
      `  1. **Server Settings → Integrations → [bot] → Command Permissions**`,
      `  2. Click \`/admin\` → Roles → add **${adminRole.name}** → Allow`,
      `  3. Repeat for \`/league\``,
      `Skip this step if all your league admins are already Discord server admins.`,
      ``,
      `**Next**: set this env var on your bot host so result announcements land in the right channel:`,
      `\`RESULTS_CHANNEL_ID=${resultsChan.id}\``,
    ].filter((l): l is string => l !== null);

    const fullOutput = lines.join("\n");
    // The summary blows past Discord's 2000-char message limit after a fresh
    // bootstrap (long "Created:" list + every channel line), so chunk it.
    // Try to DM the runner so the wall-of-text doesn't dump into a channel;
    // fall back to the ephemeral reply (+ followups) if DMs are disabled.
    const chunks = chunkForDiscord(fullOutput);
    let dmSent = false;
    try {
      for (const c of chunks) await interaction.user.send(c);
      dmSent = true;
    } catch {
      dmSent = false;
    }
    if (dmSent) {
      await interaction.editReply(`✅ Bootstrap complete — full summary + next steps sent to your DMs.`);
    } else {
      await interaction.editReply(chunks[0] ?? "✅ Bootstrap complete.");
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i]!, flags: MessageFlags.Ephemeral });
      }
    }
  } catch (err) {
    await interaction.editReply(
      `Bootstrap failed: ${(err as Error).message}. The bot may need additional permissions.`,
    );
  }
}

// Split a long message into <2000-char chunks on line boundaries (Discord's
// hard message-content limit). A single overlong line is hard-sliced.
function chunkForDiscord(text: string, max = 1900): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (line.length > max) {
      if (cur) { chunks.push(cur); cur = ""; }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    if (cur.length + line.length + 1 > max) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

// Setup-diagnostic: walks every LeagueConfig channel ID + the
// RoleBinding table + the match-config preset pointers, reporting
// which resolve cleanly vs are missing/broken. Ephemeral so admin
// can run it anywhere without spamming a channel.
async function checkSetup(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const lines: string[] = ["**Setup diagnostic**"];
  let ok = 0;
  let warn = 0;

  // Helper for channel-config keys.
  async function checkChannel(key: string, label: string): Promise<void> {
    const row = await prisma.leagueConfig.findUnique({ where: { key } });
    if (!row?.value) {
      lines.push(`❌ **${label}** — \`${key}\` not set`);
      warn++;
      return;
    }
    try {
      const ch = await interaction.client.channels.fetch(row.value);
      if (!ch) {
        lines.push(`⚠️ **${label}** — \`${key}\` points at \`${row.value}\` but the channel can't be fetched`);
        warn++;
      } else {
        lines.push(`✅ **${label}** — <#${row.value}>`);
        ok++;
      }
    } catch {
      lines.push(`⚠️ **${label}** — \`${key}\` points at \`${row.value}\` but the bot can't see it`);
      warn++;
    }
  }

  lines.push("\n__Channels__");
  await checkChannel("bot_commands_channel_id", "Bot commands");
  await checkChannel("results_channel_id", "Results");
  await checkChannel("announcements_channel_id", "Announcements");
  await checkChannel("devops_channel_id", "DevOps");
  await checkChannel("challenges_channel_id", "Challenges (casual)");

  lines.push("\n__Results webhook__");
  const wh = await prisma.leagueConfig.findUnique({ where: { key: "results_webhook_url" } });
  if (wh?.value && /discord\.com\/api\/webhooks\//i.test(wh.value)) {
    lines.push("✅ Match Results webhook URL is set");
    ok++;
  } else {
    lines.push("❌ Match Results webhook not configured — results fall back to bot REST. Run `/league setup-results-webhook` or wait for bootstrap.");
    warn++;
  }

  lines.push("\n__Role bindings__");
  const bindings = await prisma.roleBinding.groupBy({ by: ["tier"], _count: { _all: true } });
  const tierCounts = new Map(bindings.map((b) => [b.tier, b._count._all]));
  for (const tier of ["OWNER", "ADMIN", "HELPER", "DEVOPS"] as const) {
    const count = tierCounts.get(tier) ?? 0;
    if (count > 0) {
      lines.push(`✅ ${tier} — ${count} role(s) bound`);
      ok++;
    } else {
      lines.push(`⚠️ ${tier} — no role bound. Run \`/league set-role tier:${tier} role:@your-role\`.`);
      warn++;
    }
  }

  lines.push("\n__Match-config presets__");
  const presetCount = await prisma.matchConfigPreset.count();
  if (presetCount === 0) {
    lines.push("❌ No deck/stake presets exist. Open `/admin/deck-bans` to create one.");
    warn++;
  } else {
    lines.push(`✅ ${presetCount} preset(s) exist`);
    ok++;
  }
  const seasonDefault = await prisma.leagueConfig.findUnique({ where: { key: "season_default_preset_id" } });
  const casual = await prisma.leagueConfig.findUnique({ where: { key: "casual_preset_id" } });
  if (seasonDefault?.value) {
    lines.push("✅ Season default preset pointer set");
    ok++;
  } else {
    lines.push("⚠️ Season default preset pointer not set — `/start-match` falls back to first preset.");
    warn++;
  }
  if (casual?.value) {
    lines.push("✅ Casual preset pointer set");
    ok++;
  } else {
    lines.push("⚠️ Casual preset pointer not set — `/challenge` falls back to first preset.");
    warn++;
  }

  lines.push("\n__Discord server invite__");
  const invite = await prisma.leagueConfig.findUnique({ where: { key: "discord_server_invite_url" } });
  if (invite?.value) {
    lines.push("✅ Public invite URL set (used by /join page)");
    ok++;
  } else {
    lines.push("⚠️ No public invite URL set. Visitors to /join can't see one. Set `discord_server_invite_url` on `/admin/config`.");
    warn++;
  }

  lines.push(`\n**Summary**: ${ok} ✓ / ${warn} ⚠️`);
  await interaction.editReply(lines.join("\n"));
}

async function setRole(interaction: ChatInputCommandInteraction) {
  const tier = interaction.options.getString("tier", true) as PermissionTier;
  const role = interaction.options.getRole("role", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await prisma.roleBinding.upsert({
    where: { discordRoleId: role.id },
    create: { discordRoleId: role.id, tier, createdBy: interaction.user.id },
    update: { tier, createdBy: interaction.user.id },
  });
  await interaction.editReply(`Bound role <@&${role.id}> → **${tier}**.`);
}

async function unsetRole(interaction: ChatInputCommandInteraction) {
  const role = interaction.options.getRole("role", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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

const RESET_CONFIRMATION_PHRASE = "RESET DISCORD STATE";

// Wipe every Discord ID we've stashed in the DB so /league bootstrap-server
// (and the season's "Set up Discord channels" admin button) can rebuild
// everything fresh. League DATA — seasons, divisions, players, pairings,
// match sessions, signups — is left untouched.
//
// Cleared:
//   Division.discordChannelId / discordRoleId
//   Season.discordCategoryId / resultsChannelId / resultsWebhookUrl
//   LeagueConfig.BotCommandsChannelId / ResultsWebhookUrl
//   RoleBinding (all rows — bootstrap recreates them)
//
// Doesn't touch MatchSession.threadId or SignupRound.channelId/messageId
// because those self-resolve (completed matches just stay dead-linked;
// open signup rounds the admin will close + reopen separately).
async function resetDiscordState(interaction: ChatInputCommandInteraction) {
  const confirmation = interaction.options.getString("confirmation", true).trim();
  if (confirmation !== RESET_CONFIRMATION_PHRASE) {
    await interaction.reply({
      content:
        `Confirmation phrase didn't match. Type exactly \`${RESET_CONFIRMATION_PHRASE}\` to proceed. ` +
        `Nothing was changed.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [divResult, seasonResult, bindings, configKeys] = await Promise.all([
    prisma.division.updateMany({
      where: {
        OR: [
          { discordChannelId: { not: null } },
          { discordRoleId: { not: null } },
        ],
      },
      data: { discordChannelId: null, discordRoleId: null },
    }),
    prisma.season.updateMany({
      where: {
        OR: [
          { discordCategoryId: { not: null } },
          { resultsChannelId: { not: null } },
          { resultsWebhookUrl: { not: null } },
        ],
      },
      data: { discordCategoryId: null, resultsChannelId: null, resultsWebhookUrl: null },
    }),
    prisma.roleBinding.deleteMany({}),
    prisma.leagueConfig.deleteMany({
      where: {
        key: {
          in: [
            LeagueConfigKey.BotCommandsChannelId,
            LeagueConfigKey.ResultsWebhookUrl,
          ],
        },
      },
    }),
  ]);

  const lines = [
    `✅ Discord state cleared. League data (seasons, players, results) is intact.`,
    ``,
    `Cleared:`,
    `• ${divResult.count} Division row(s): discordChannelId + discordRoleId set to null`,
    `• ${seasonResult.count} Season row(s): discordCategoryId + per-season results overrides cleared`,
    `• ${bindings.count} RoleBinding row(s) deleted`,
    `• ${configKeys.count} LeagueConfig key(s) deleted (bot-commands, backup, results-webhook)`,
    ``,
    `**Next steps**:`,
    `1. Delete the old Discord channels / roles / category if you haven't already`,
    `2. Run \`/league bootstrap-server\` to recreate ALL the channels + staff scaffolding + RoleBindings (channels are no longer auto-created on boot — this is the one place they're made)`,
    `3. On each active season's \`/admin/seasons/[id]\` page, click "Set up Discord channels & roles" to recreate per-division channels`,
  ];
  await interaction.editReply(lines.join("\n"));
}

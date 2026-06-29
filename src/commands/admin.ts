// /admin — admin-only tools that genuinely belong in Discord rather than
// the web dashboard, because admin context is the live chat:
// reading a dispute thread + deciding the result + recording it is one
// continuous flow there, vs context-switching to the web dashboard.
//
// All other admin functions (season setup, signups, division assignment,
// rankings, presets, etc.) live on www.balatroleague.com.

import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { MatchSessionState } from "@prisma/client";
import { enqueueAnnounceResult } from "../queue.js";
import { runDisplayNameRefresh } from "../display-name-refresh.js";
import { runGuildMemberSync } from "../guild-member-sync.js";
import { actorFromInteractionUser, recordAudit } from "../audit.js";
import { purgeBotAccounts } from "../bot-purge.js";
import { activeSeasonMemberAutocomplete } from "./autocomplete.js";
import { prisma } from "../db.js";
import { requireAdmin, requireHelper } from "../permissions.js";
import { getOrCreatePlayer } from "../players.js";
import { gamesFromResult, parsePairingResult } from "../scoring.js";
import { recomputeDivisionStandings } from "../standings-cache.js";
import { formatSeasonLabel } from "../format-season.js";
import type { SlashCommand } from "./types.js";

const RESULT_CHOICES = [
  { name: "2-0 (P1 won both)", value: "2-0" },
  { name: "1-1 (draw)", value: "1-1" },
  { name: "0-2 (P2 won both)", value: "0-2" },
] as const;

export const admin: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Admin tools that make sense in Discord context (dispute resolution).")
    // Hide from non-admin members in the slash-command picker. The
    // bot still does its own RoleBinding tier check inside each
    // subcommand, but this stops the command from cluttering every
    // player's autocomplete. Server admins can override on a per-
    // role basis via Server Settings → Integrations → bot.
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString())
    .addSubcommand((sub) =>
      sub
        .setName("record-match")
        .setDescription("Manually record a match result (e.g. agreed verbally, never reported).")
        .addUserOption((opt) => opt.setName("p1").setDescription("Player 1").setRequired(true))
        .addUserOption((opt) => opt.setName("p2").setDescription("Player 2").setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName("result")
            .setDescription("Result from P1's POV")
            .setRequired(true)
            .addChoices(...RESULT_CHOICES),
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Why (e.g. 'agreed in DMs', 'showdown', 'dispute resolution')")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("override-result")
        .setDescription("Force-resolve a disputed match with the correct result.")
        .addStringOption((opt) =>
          opt.setName("match-id").setDescription("ID of the disputed match (from the dispute embed)").setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("result")
            .setDescription("Result from playerA's POV")
            .setRequired(true)
            .addChoices(...RESULT_CHOICES),
        )
        .addStringOption((opt) => opt.setName("reason").setDescription("Why").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("forfeit")
        .setDescription("Award a 2-0 win by forfeit / DQ (no-show, drop-out, rule violation).")
        .addUserOption((opt) => opt.setName("winner").setDescription("Player who wins by default").setRequired(true))
        .addUserOption((opt) => opt.setName("loser").setDescription("Player who forfeited / was DQ'd").setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Admin-only reason (recorded for audit, NOT shown to other players)")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("void-player")
        .setDescription("DQ a player by VOIDING all their games (no 2-0s to opponents, no losses to them).")
        .addUserOption((opt) => opt.setName("player").setDescription("Player to void + remove from the season").setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Admin-only reason (recorded for audit, NOT shown to other players)")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("void-match")
        .setDescription("Void ONE game (records 0-0 — finished, no points, not a W/L/D). For a misreport / no-contest.")
        .addUserOption((opt) => opt.setName("p1").setDescription("Player 1").setRequired(true))
        .addUserOption((opt) => opt.setName("p2").setDescription("Player 2").setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Admin-only reason (recorded for audit, NOT shown to other players)")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("join-match")
        .setDescription("Add yourself to a private match channel to mediate a dispute.")
        .addStringOption((opt) =>
          opt
            .setName("match-id")
            .setDescription("Match session ID — shown in the embed footer as 'Match {id}'")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("undo-report")
        .setDescription("Remove a reported match so it's back to unplayed (for when something got reported wrong).")
        .addUserOption((opt) => opt.setName("p1").setDescription("Either player in the match").setRequired(true))
        .addUserOption((opt) => opt.setName("p2").setDescription("The other player").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("record-shootout")
        .setDescription("Record a showdown winner to break a tied promo/relegation position.")
        .addStringOption((opt) => opt.setName("p1").setDescription("First tied player").setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName("p2").setDescription("Second tied player").setRequired(true).setAutocomplete(true))
        .addStringOption((opt) =>
          opt.setName("winner")
            .setDescription("Which side won")
            .setRequired(true)
            .addChoices(
              { name: "p1 won", value: "p1" },
              { name: "p2 won", value: "p2" },
            ),
        )
        .addStringOption((opt) => opt.setName("notes").setDescription("Optional context").setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("reload-emojis")
        .setDescription("Re-run the Balatro deck/stake emoji upload. Picks up new PNGs without a bot restart."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("sync-names")
        .setDescription("Resync player display names from their current Discord server names (skips custom-set names)."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("sync-members")
        .setDescription("Sync the full guild member roster (username -> id) for Team Tour resolution."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("scan-bots")
        .setDescription("Check every signup/player against Discord's bot flag and remove any bot accounts from the league."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("cancel-match")
        .setDescription("Force-cancel a wedged match session (any state). Use when players are stuck.")
        .addStringOption((opt) =>
          opt.setName("match-id").setDescription("Match session id (shown in the embed footer)").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("reason").setDescription("Why — recorded for audit").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("strike")
        .setDescription("Log a strike against a player (repeat offenders: no-show, DQ, rule break).")
        .addUserOption((opt) => opt.setName("player").setDescription("Player to strike").setRequired(true))
        .addStringOption((opt) =>
          opt.setName("reason").setDescription("Why (free text — recorded for the strike history)").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("strikes")
        .setDescription("List a player's strikes + count.")
        .addUserOption((opt) => opt.setName("player").setDescription("Player to look up").setRequired(true)),
    ),

  // Only record-shootout has autocompleted options (p1 / p2). Other
  // subcommands' autocomplete focus values fall through to an empty
  // response, which is benign.
  async autocomplete(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "record-shootout") {
      await activeSeasonMemberAutocomplete(interaction);
      return;
    }
    await interaction.respond([]);
  },

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    // Helper+ subcommands: dispute mediation work. League Helpers can
    // join match channels and record verbally-agreed results so they
    // can resolve a dispute end-to-end without escalating to an Admin.
    if (sub === "join-match" || sub === "record-match" || sub === "undo-report" || sub === "record-shootout") {
      if (!(await requireHelper(interaction))) return;
      if (sub === "join-match") return joinMatch(interaction);
      if (sub === "record-match") return recordPairing(interaction);
      if (sub === "undo-report") return undoReport(interaction);
      if (sub === "record-shootout") return recordShootout(interaction);
    }
    // Admin+ subcommands: anything that overrides existing results or
    // exports sensitive data. Helpers can't accidentally rewrite a
    // confirmed pairing or dump league state.
    if (!(await requireAdmin(interaction))) return;
    if (sub === "override-result") return forceResult(interaction);
    if (sub === "forfeit") return recordForfeit(interaction);
    if (sub === "void-player") return voidPlayer(interaction);
    if (sub === "void-match") return voidMatch(interaction);
    if (sub === "strike") return recordStrike(interaction);
    if (sub === "strikes") return listStrikes(interaction);
    if (sub === "reload-emojis") return reloadEmojis(interaction);
    if (sub === "sync-names") return syncNames(interaction);
    if (sub === "sync-members") return syncMembers(interaction);
    if (sub === "scan-bots") return scanBots(interaction);
    if (sub === "cancel-match") return cancelMatch(interaction);
  },
};

// Force-cancel a wedged match session — any state, even mid-game.
// Players' mutual-consent cancel only works during the BAN phase; this
// is the escape hatch when something gets stuck (disputed and players
// gone, mid-pick with someone unreachable, etc). The session row stays
// in the DB for audit — only the state flips to CANCELLED and the
// match channel is locked.
async function cancelMatch(interaction: ChatInputCommandInteraction) {
  const matchId = interaction.options.getString("match-id", true).trim();
  const reason = interaction.options.getString("reason", true).trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const session = await prisma.matchSession.findUnique({ where: { id: matchId } });
  if (!session) {
    await interaction.editReply(`No match session found with id \`${matchId}\`.`);
    return;
  }
  if (session.state === MatchSessionState.COMPLETE) {
    await interaction.editReply(
      "That match is already complete — use `/admin override-result` to fix a recorded result.",
    );
    return;
  }
  if (session.state === MatchSessionState.CANCELLED) {
    await interaction.editReply("That match is already cancelled.");
    return;
  }

  await prisma.matchSession.update({
    where: { id: matchId },
    data: { state: MatchSessionState.CANCELLED },
  });
  recordAudit({
    actor: actorFromInteractionUser(interaction.user),
    action: "match.cancel-admin",
    targetType: "MatchSession",
    targetId: matchId,
    summary: `Cancelled match ${matchId.slice(-6)} (was ${session.state})`,
    metadata: { reason, previousState: session.state, threadId: session.threadId },
  });

  // Best-effort: post the reason into the match thread and lock it so
  // players see what happened.
  if (session.threadId) {
    try {
      const channel = await interaction.client.channels.fetch(session.threadId);
      if (channel?.type === ChannelType.PrivateThread || channel?.type === ChannelType.PublicThread) {
        await channel.send(
          `🛑 Match cancelled by <@${interaction.user.id}> (admin). Reason: ${reason}`,
        );
        // Delete the thread outright — admin cancel is terminal,
        // nothing to preserve.
        await channel.delete(`Admin cancel: ${reason}`).catch(() => {});
      }
    } catch (err) {
      console.warn("[admin cancel-match] failed to post/delete thread:", err);
    }
  }

  await interaction.editReply(`✅ Cancelled match \`${matchId}\`. Reason recorded: ${reason}`);
}

// Re-run the application-emoji upload without restarting the bot.
// Lets admin drop a new PNG in src/assets/balatro/, commit + deploy,
// then run this to pick it up immediately instead of waiting for the
// next natural restart.
async function reloadEmojis(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { ensureBalatroEmojis } = await import("../balatro-emojis.js");
    const { env } = await import("../env.js");
    await ensureBalatroEmojis(env.DISCORD_CLIENT_ID);
    await interaction.editReply("✅ Reloaded. Check the bot log for the upload summary.");
    recordAudit({
      actor: actorFromInteractionUser(interaction.user),
      action: "emojis.reload",
      summary: "Reloaded Balatro deck/stake application emojis",
    });
  } catch (err) {
    console.warn("[admin reload-emojis] failed:", err);
    await interaction.editReply("❌ Reload failed — check the bot logs.");
  }
}

// Resync every player's displayName from their CURRENT Discord server name
// (nickname → global name → username). Skips players who set a custom name via
// /me (hasCustomDisplayName=true) and anyone who left the guild. Runs daily on
// its own, but this is the manual "do it now" trigger — handy right after a
// server move so names reflect the new server immediately.
async function syncNames(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { updated, checked } = await runDisplayNameRefresh();
    await interaction.editReply(
      `✅ Synced display names from Discord — **${updated}** updated of **${checked}** checked (custom-set names were left alone).`,
    );
    recordAudit({
      actor: actorFromInteractionUser(interaction.user),
      action: "players.sync-names",
      summary: `Manual display-name resync: ${updated}/${checked} updated`,
    });
  } catch (err) {
    console.warn("[admin sync-names] failed:", err);
    await interaction.editReply("❌ Name sync failed — check the bot logs.");
  }
}

// Sync the full guild member roster into the GuildMember table (username -> id), the
// source the Team Tour app reads to resolve people who aren't registered league
// players. Runs daily on its own; this is the manual "do it now" trigger. Requires
// GUILD_MEMBER_SYNC=1 + the GuildMembers privileged intent.
async function syncMembers(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { synced, removed } = await runGuildMemberSync();
    if (synced === 0) {
      await interaction.editReply(
        "⚠️ Nothing synced — the GuildMembers (Server Members) privileged intent isn't enabled. Turn it on in the Discord Developer Portal, then it syncs automatically.",
      );
      return;
    }
    await interaction.editReply(`✅ Synced **${synced}** guild members (${removed} departed members pruned).`);
    recordAudit({
      actor: actorFromInteractionUser(interaction.user),
      action: "guild.sync-members",
      summary: `Manual guild-member sync: ${synced} synced, ${removed} pruned`,
    });
  } catch (err) {
    console.warn("[admin sync-members] failed:", err);
    await interaction.editReply("❌ Member sync failed — check the bot logs (is the GuildMembers intent enabled?).");
  }
}

// Delete a pairing (any status) so the set goes back to unplayed.
// Used when something was reported wrong before the game actually
// happened. Helper-tier because it's reversible — just play and
// /report again — and limited blast radius (one set).
async function undoReport(interaction: ChatInputCommandInteraction) {
  const p1User = interaction.options.getUser("p1", true);
  const p2User = interaction.options.getUser("p2", true);
  if (p1User.id === p2User.id) {
    await interaction.reply({ content: "Same player twice — pick two different players.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [p1, p2, activeSeason] = await Promise.all([
    prisma.player.findUnique({ where: { discordId: p1User.id } }),
    prisma.player.findUnique({ where: { discordId: p2User.id } }),
    prisma.season.findFirst({ where: { isActive: true } }),
  ]);
  if (!p1 || !p2) {
    await interaction.editReply("One or both players aren't in the league yet (no Player row).");
    return;
  }
  if (!activeSeason) {
    await interaction.editReply("No active season.");
    return;
  }

  const [canonA, canonB] = p1.id < p2.id ? [p1.id, p2.id] : [p2.id, p1.id];
  // Find the pairing across the active season's divisions (either player
  // could be in any division of this season; the unique constraint is
  // (divisionId, playerAId, playerBId) so we find by canonical pair).
  const pairing = await prisma.match.findFirst({
    where: {
      playerAId: canonA,
      playerBId: canonB,
      format: "LEAGUE_BO2",
      division: { seasonId: activeSeason.id },
    },
    include: { division: { select: { id: true, name: true } } },
  });
  if (!pairing) {
    await interaction.editReply(
      `No set between **${p1User.username}** and **${p2User.username}** in ${formatSeasonLabel(activeSeason)} — nothing to undo.`,
    );
    return;
  }
  await prisma.match.delete({ where: { id: pairing.id } });
  // Standings cache no longer reflects this pairing — recompute the
  // affected division. Fire-and-forget so the user doesn't wait on it.
  recomputeDivisionStandings(pairing.division.id).catch(() => {});

  const oldResult = `${pairing.gamesWonA}-${pairing.gamesWonB}`;
  recordAudit({
    actor: actorFromInteractionUser(interaction.user),
    action: "pairing.undo",
    targetType: "Pairing",
    targetId: pairing.id,
    summary: `Undid ${oldResult} set between ${p1.displayName} and ${p2.displayName} in ${pairing.division.name}`,
    metadata: {
      previous: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB, status: pairing.status },
      divisionId: pairing.division.id,
      divisionName: pairing.division.name,
      seasonId: activeSeason.id,
    },
  });
  await interaction.editReply(
    `Undone: deleted the **${oldResult}** set between **${p1User.username}** and **${p2User.username}** ` +
      `in **${pairing.division.name}**. They can play and report again.`,
  );
}

// Shared helper: persist a Shootout for the active-season division
// these two players are in. Used by both /admin record-shootout
// (mediator-recorded) and /report-shootout (self-reported). Returns
// the division name + winner display on success, or an error string.
async function persistShootout(args: {
  p1DiscordId: string;
  p2DiscordId: string;
  winnerDiscordId: string;
  recordedBy: string; // discord user id, or "self-report"
  notes?: string | null;
}): Promise<{ ok: true; divisionName: string; winnerName: string } | { ok: false; error: string }> {
  if (args.p1DiscordId === args.p2DiscordId) {
    return { ok: false, error: "Pick two different players." };
  }
  if (args.winnerDiscordId !== args.p1DiscordId && args.winnerDiscordId !== args.p2DiscordId) {
    return { ok: false, error: "Winner has to be either p1 or p2." };
  }
  const [p1, p2, winner, activeSeason] = await Promise.all([
    prisma.player.findUnique({ where: { discordId: args.p1DiscordId } }),
    prisma.player.findUnique({ where: { discordId: args.p2DiscordId } }),
    prisma.player.findUnique({ where: { discordId: args.winnerDiscordId } }),
    prisma.season.findFirst({ where: { isActive: true } }),
  ]);
  if (!p1 || !p2 || !winner) return { ok: false, error: "One or both players aren't in the league (no Player row)." };
  if (!activeSeason) return { ok: false, error: "No active season." };

  // Find the division where both players are members in this season.
  const member = await prisma.divisionMember.findFirst({
    where: { playerId: p1.id, division: { seasonId: activeSeason.id } },
    include: { division: true },
  });
  if (!member) return { ok: false, error: `${p1.displayName} isn't in a division this season.` };
  const otherInSameDiv = await prisma.divisionMember.findFirst({
    where: { playerId: p2.id, divisionId: member.divisionId },
  });
  if (!otherInSameDiv) {
    return { ok: false, error: `${p1.displayName} and ${p2.displayName} aren't in the same division — a shootout only makes sense for tied opponents.` };
  }

  const [canonA, canonB] = p1.id < p2.id ? [p1.id, p2.id] : [p2.id, p1.id];
  const winA = winner.id === canonA ? 1 : 0;
  const winB = winner.id === canonB ? 1 : 0;
  const now = new Date();
  await prisma.match.upsert({
    where: {
      divisionId_playerAId_playerBId_format: {
        divisionId: member.divisionId,
        playerAId: canonA,
        playerBId: canonB,
        format: "SHOOTOUT_BO1",
      },
    },
    create: {
      divisionId: member.divisionId,
      playerAId: canonA,
      playerBId: canonB,
      format: "SHOOTOUT_BO1",
      gamesWonA: winA,
      gamesWonB: winB,
      winnerId: winner.id,
      status: "CONFIRMED",
      reportedAt: now,
      confirmedAt: now,
      recordedBy: args.recordedBy,
      notes: args.notes ?? null,
    },
    update: {
      gamesWonA: winA,
      gamesWonB: winB,
      winnerId: winner.id,
      status: "CONFIRMED",
      confirmedAt: now,
      recordedBy: args.recordedBy,
      notes: args.notes ?? null,
    },
  });
  recomputeDivisionStandings(member.divisionId).catch(() => {});
  return { ok: true, divisionName: member.division.name, winnerName: winner.displayName };
}

async function recordShootout(interaction: ChatInputCommandInteraction) {
  const p1DiscordId = interaction.options.getString("p1", true).trim();
  const p2DiscordId = interaction.options.getString("p2", true).trim();
  const winnerKey = interaction.options.getString("winner", true);
  const notes = interaction.options.getString("notes") ?? undefined;
  if (!/^\d{17,20}$/.test(p1DiscordId) || !/^\d{17,20}$/.test(p2DiscordId)) {
    await interaction.reply({
      content: "Pick players from the autocomplete dropdowns — only active-season members are eligible.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const winnerDiscordId = winnerKey === "p1" ? p1DiscordId : p2DiscordId;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await persistShootout({
    p1DiscordId,
    p2DiscordId,
    winnerDiscordId,
    recordedBy: interaction.user.id,
    notes,
  });
  if (!result.ok) {
    await interaction.editReply(result.error);
    return;
  }
  recordAudit({
    actor: actorFromInteractionUser(interaction.user),
    action: "shootout.record",
    targetType: "Shootout",
    summary: `Showdown: ${result.winnerName} wins in ${result.divisionName}`,
    metadata: {
      p1DiscordId,
      p2DiscordId,
      winnerDiscordId,
      divisionName: result.divisionName,
      notes: notes ?? null,
    },
  });
  const loserDiscordId = winnerDiscordId === p1DiscordId ? p2DiscordId : p1DiscordId;
  await interaction.editReply(
    `⚔ Showdown recorded — **${result.winnerName}** beats <@${loserDiscordId}> ` +
      `in **${result.divisionName}**. Standings sort updated.` +
      (notes ? `\n_Notes: ${notes}_` : ""),
  );
}

// Exported so /report-shootout (in src/commands/report.ts) can call the
// same persistence helper without duplicating the validation logic.
export const __shootoutHelper = persistShootout;

// Add the calling admin to a specific match channel's permission overwrites.
// Match channels are private (only the 2 players see them by default), so
// when a dispute comes in admin needs to opt themselves in. Players share
// the match-id from the embed footer; admin pastes it here.
async function joinMatch(interaction: ChatInputCommandInteraction) {
  const matchId = interaction.options.getString("match-id", true).trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const session = await prisma.matchSession.findUnique({ where: { id: matchId } });
  if (!session) {
    await interaction.editReply(`No match session found with id \`${matchId}\`.`);
    return;
  }
  if (!session.threadId) {
    await interaction.editReply("That match doesn't have a dedicated channel yet (not accepted).");
    return;
  }
  try {
    const channel = await interaction.client.channels.fetch(session.threadId);
    if (!channel) {
      await interaction.editReply("Match channel/thread doesn't exist anymore — it may have been deleted.");
      return;
    }
    if (channel.type === ChannelType.PrivateThread || channel.type === ChannelType.PublicThread) {
      // Threads: add the admin as a member. Private Threads need explicit
      // membership; Public Threads they can already see but the message
      // confirms presence to players.
      await channel.members.add(interaction.user.id, `Admin ${interaction.user.username} mediating`);
      await channel.send(
        `🛠️ <@${interaction.user.id}> joined to mediate. Players: explain the situation here.`,
      );
    } else if (channel.type === ChannelType.GuildText) {
      // Legacy per-match text channels (pre-thread revert).
      const text = channel as TextChannel;
      await text.permissionOverwrites.edit(
        interaction.user.id,
        { ViewChannel: true, SendMessages: true, ReadMessageHistory: true },
        { reason: `Admin ${interaction.user.username} mediating` },
      );
      await text.send(
        `🛠️ <@${interaction.user.id}> joined to mediate. Players: explain the situation here.`,
      );
    } else {
      await interaction.editReply("Match channel type is unsupported (not a thread or text channel).");
      return;
    }
    await interaction.editReply(`Joined <#${session.threadId}>. Head over there to mediate.`);
    recordAudit({
      actor: actorFromInteractionUser(interaction.user),
      action: "match.join",
      targetType: "MatchSession",
      targetId: matchId,
      summary: `Joined match ${matchId.slice(-6)} as mediator`,
      metadata: { threadId: session.threadId },
    });
  } catch (err) {
    console.warn("[admin join-match] failed:", err);
    await interaction.editReply("Couldn't join — check the bot has Manage Threads / Manage Channels.");
  }
}

async function recordPairing(interaction: ChatInputCommandInteraction) {
  const p1User = interaction.options.getUser("p1", true);
  const p2User = interaction.options.getUser("p2", true);
  const resultStr = interaction.options.getString("result", true);
  const reason = interaction.options.getString("reason") ?? undefined;
  const result = parsePairingResult(resultStr);

  if (!result) {
    await interaction.reply({ content: `Invalid result \`${resultStr}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (p1User.id === p2User.id) {
    await interaction.reply({ content: "P1 and P2 must be different players.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const activeSeason = await prisma.season.findFirst({ where: { isActive: true } });
  if (!activeSeason) {
    await interaction.editReply("No active season.");
    return;
  }

  const p1 = await getOrCreatePlayer(p1User);
  const p2 = await getOrCreatePlayer(p2User);

  const shared = await prisma.divisionMember.findFirst({
    where: { playerId: p1.id, division: { seasonId: activeSeason.id } },
    include: { division: { include: { members: { where: { playerId: p2.id } } } } },
  });
  if (!shared || shared.division.members.length === 0) {
    await interaction.editReply(
      `${p1User.username} and ${p2User.username} aren't in the same division this season.`,
    );
    return;
  }
  const division = shared.division;

  const [playerAId, playerBId] = p1.id < p2.id ? [p1.id, p2.id] : [p2.id, p1.id];
  const p1IsA = p1.id === playerAId;
  const games = gamesFromResult(result);
  const gamesWonA = p1IsA ? games.a : games.b;
  const gamesWonB = p1IsA ? games.b : games.a;

  const winnerId = gamesWonA > gamesWonB ? playerAId : gamesWonB > gamesWonA ? playerBId : null;
  const upserted = await prisma.match.upsert({
    where: {
      divisionId_playerAId_playerBId_format: {
        divisionId: division.id,
        playerAId,
        playerBId,
        format: "LEAGUE_BO2",
      },
    },
    create: {
      divisionId: division.id,
      playerAId,
      playerBId,
      format: "LEAGUE_BO2",
      gamesWonA,
      gamesWonB,
      winnerId,
      status: "CONFIRMED",
      reporterId: null,
      reportedAt: new Date(),
      confirmedAt: new Date(),
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: reason ?? "admin record-set",
    },
    update: {
      gamesWonA,
      gamesWonB,
      winnerId,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: reason ?? "admin record-set (overwrite)",
    },
  });
  enqueueAnnounceResult(upserted.id).catch(() => {});
  recomputeDivisionStandings(division.id).catch(() => {});
  recordAudit({
    actor: actorFromInteractionUser(interaction.user),
    action: "pairing.record",
    targetType: "Pairing",
    targetId: upserted.id,
    summary: `Recorded ${p1.displayName} ${games.a}-${games.b} ${p2.displayName} in ${division.name}`,
    metadata: { result, reason: reason ?? null, divisionId: division.id, seasonId: activeSeason.id },
  });

  // If a live match session for this pair is still open — players got
  // stuck mid-game and a helper recorded the result instead of them
  // clicking winner — reconcile it: mark COMPLETE so the winner buttons
  // go inert (no double-record) and close the thread so it doesn't linger.
  const liveSession = await prisma.matchSession.findFirst({
    where: {
      divisionId: division.id,
      state: { notIn: [MatchSessionState.COMPLETE, MatchSessionState.CANCELLED] },
      OR: [
        { playerAId: p1.id, playerBId: p2.id },
        { playerAId: p2.id, playerBId: p1.id },
      ],
    },
  });
  let closedThread = false;
  if (liveSession) {
    await prisma.matchSession.update({
      where: { id: liveSession.id },
      data: { state: MatchSessionState.COMPLETE, completedAt: new Date() },
    });
    recordAudit({
      actor: actorFromInteractionUser(interaction.user),
      action: "match.complete-admin",
      targetType: "MatchSession",
      targetId: liveSession.id,
      summary: `Closed in-progress match ${liveSession.id.slice(-6)} after recording the result (was ${liveSession.state})`,
      metadata: { pairingId: upserted.id, previousState: liveSession.state, threadId: liveSession.threadId },
    });
    if (liveSession.threadId) {
      try {
        const channel = await interaction.client.channels.fetch(liveSession.threadId);
        if (channel?.type === ChannelType.PrivateThread || channel?.type === ChannelType.PublicThread) {
          await channel.send(`✅ Result recorded by <@${interaction.user.id}>. Closing this match thread.`);
          await channel.delete("Result recorded via /admin record-match").catch(() => {});
          closedThread = true;
        }
      } catch (err) {
        console.warn("[admin record-match] failed to close live session thread:", err);
      }
    }
  }

  await interaction.editReply(
    `Recorded: **${p1User.username} ${games.a}-${games.b} ${p2User.username}** in **${division.name}**.` +
      (reason ? `\nReason: ${reason}` : "") +
      (liveSession ? `\nClosed the in-progress match${closedThread ? " and its thread" : ""}.` : ""),
  );
}

// Award a 2-0 win by forfeit / DQ. Same write as a record-set, but forces
// the score to 2-0 for the winner and flags the match as a forfeit. The
// reason is admin-only (stored on forfeitReason / audit) — the public
// announce + standings just show "by DQ", never the reason.
async function recordForfeit(interaction: ChatInputCommandInteraction) {
  const winnerUser = interaction.options.getUser("winner", true);
  const loserUser = interaction.options.getUser("loser", true);
  const reason = interaction.options.getString("reason", true).trim();
  if (winnerUser.id === loserUser.id) {
    await interaction.reply({ content: "Winner and loser must be different players.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const activeSeason = await prisma.season.findFirst({ where: { isActive: true } });
  if (!activeSeason) {
    await interaction.editReply("No active season.");
    return;
  }

  const winner = await getOrCreatePlayer(winnerUser);
  const loser = await getOrCreatePlayer(loserUser);

  const shared = await prisma.divisionMember.findFirst({
    where: { playerId: winner.id, division: { seasonId: activeSeason.id } },
    include: { division: { include: { members: { where: { playerId: loser.id } } } } },
  });
  if (!shared || shared.division.members.length === 0) {
    await interaction.editReply(
      `${winnerUser.username} and ${loserUser.username} aren't in the same division this season.`,
    );
    return;
  }
  const division = shared.division;

  const [playerAId, playerBId] = winner.id < loser.id ? [winner.id, loser.id] : [loser.id, winner.id];
  const winnerIsA = winner.id === playerAId;
  const gamesWonA = winnerIsA ? 2 : 0;
  const gamesWonB = winnerIsA ? 0 : 2;

  const upserted = await prisma.match.upsert({
    where: {
      divisionId_playerAId_playerBId_format: {
        divisionId: division.id,
        playerAId,
        playerBId,
        format: "LEAGUE_BO2",
      },
    },
    create: {
      divisionId: division.id,
      playerAId,
      playerBId,
      format: "LEAGUE_BO2",
      gamesWonA,
      gamesWonB,
      winnerId: winner.id,
      status: "CONFIRMED",
      reporterId: null,
      reportedAt: new Date(),
      confirmedAt: new Date(),
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: "forfeit / DQ",
      forfeit: true,
      forfeitReason: reason,
    },
    update: {
      gamesWonA,
      gamesWonB,
      winnerId: winner.id,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: "forfeit / DQ",
      forfeit: true,
      forfeitReason: reason,
    },
  });
  enqueueAnnounceResult(upserted.id).catch(() => {});
  recomputeDivisionStandings(division.id).catch(() => {});
  recordAudit({
    actor: actorFromInteractionUser(interaction.user),
    action: "match.forfeit",
    targetType: "Match",
    targetId: upserted.id,
    summary: `Forfeit: ${winner.displayName} def. ${loser.displayName} 2-0 by DQ in ${division.name}`,
    metadata: { winnerId: winner.id, loserId: loser.id, reason, divisionId: division.id, seasonId: activeSeason.id },
  });

  await interaction.editReply(
    `✅ Recorded **${winner.displayName}** def. **${loser.displayName}** — **2-0 by DQ** in **${division.name}**.\n` +
      `Reason (admin-only): _${reason}_`,
  );
}

// DQ a player by VOIDING their season instead of forfeiting individual games:
// every league match they're part of is set to CANCELLED and they're dropped
// from their division. Standings count only ACTIVE members' CONFIRMED matches
// (and skip any pairing whose player isn't active), so this hands NO 2-0s to
// opponents and records NO losses for the voided player — they're erased from
// the table as if they never played. Reason is admin-only; unlike /admin
// forfeit, nothing is announced publicly.
async function voidPlayer(interaction: ChatInputCommandInteraction) {
  const playerUser = interaction.options.getUser("player", true);
  const reason = interaction.options.getString("reason", true).trim();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const activeSeason = await prisma.season.findFirst({ where: { isActive: true } });
  if (!activeSeason) {
    await interaction.editReply("No active season.");
    return;
  }

  const player = await getOrCreatePlayer(playerUser);

  // Their division this season (unique per [seasonId, playerId]).
  const member = await prisma.divisionMember.findFirst({
    where: { playerId: player.id, division: { seasonId: activeSeason.id } },
    include: { division: true },
  });
  if (!member) {
    await interaction.editReply(`${playerUser.username} isn't in a division this season.`);
    return;
  }
  const division = member.division;

  // Void every league match they're in (confirmed, pending, or disputed) by
  // flipping it to CANCELLED — excluded from standings, so opponents keep
  // nothing from these games and the voided player records no losses.
  const voided = await prisma.match.updateMany({
    where: {
      divisionId: division.id,
      format: "LEAGUE_BO2",
      status: { in: ["CONFIRMED", "PENDING", "DISPUTED"] },
      OR: [{ playerAId: player.id }, { playerBId: player.id }],
    },
    data: {
      status: "CANCELLED",
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: "DQ void",
    },
  });

  // Drop them from the division so they fall out of the ACTIVE standings.
  await prisma.divisionMember.update({
    where: { id: member.id },
    data: { status: "DROPPED", droppedAt: new Date() },
  });

  await recomputeDivisionStandings(division.id).catch(() => {});

  recordAudit({
    actor: actorFromInteractionUser(interaction.user),
    action: "player.void",
    targetType: "Player",
    targetId: player.id,
    summary: `DQ void: removed ${player.displayName} from ${division.name}, voided ${voided.count} match(es)`,
    metadata: { playerId: player.id, divisionId: division.id, seasonId: activeSeason.id, voidedMatches: voided.count, reason },
  });

  await interaction.editReply(
    `✅ Voided **${player.displayName}** in **${division.name}** — **${voided.count}** match(es) cancelled, removed from standings.\n` +
      `No 2-0s awarded to opponents, no losses recorded against them.\n` +
      `Reason (admin-only): _${reason}_`,
  );
}

// Scan every signup + player against Discord's authoritative bot flag and
// remove any bot accounts. Bots aren't players (the signup button now rejects
// them); this cleans up any that predate that guard and otherwise just confirms
// "no bots". `user.bot` has no false positives, so removal is unconditional +
// full (signups + player + their matches) and each removal is audited.
async function scanBots(interaction: ChatInputCommandInteraction) {
  // REST user-fetches are sequential, so this can run past the 3s window.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await purgeBotAccounts(interaction.client, actorFromInteractionUser(interaction.user));
  const unresolvedNote =
    result.unresolved > 0 ? `\n\n_${result.unresolved} id(s) couldn't be resolved (deleted account?) and were left as-is._` : "";

  if (result.removed.length === 0) {
    await interaction.editReply(`✅ Scanned **${result.scanned}** account(s) — no bots found.${unresolvedNote}`);
    return;
  }

  const lines = result.removed.map(
    (r) =>
      `• **${r.username}** (\`${r.discordId}\`) — ${r.removedSignups} signup(s)` +
      (r.deletedPlayer ? `, player + ${r.deletedMatches} match(es) deleted` : ""),
  );
  await interaction.editReply(
    `✅ Scanned **${result.scanned}** account(s), removed **${result.removed.length}** bot(s):\n${lines.join("\n")}${unresolvedNote}`,
  );
}

// Void ONE specific game between two players: record it as a CONFIRMED 0-0. The
// game counts as PLAYED/finished (so it's not flagged as a remaining match) but
// awards no points and is neither a win, loss, nor draw. Use for a misreport /
// agreed no-contest, vs /admin void-player which erases a whole player. Both
// players stay in the division; only this one result is nil-nil.
async function voidMatch(interaction: ChatInputCommandInteraction) {
  const p1User = interaction.options.getUser("p1", true);
  const p2User = interaction.options.getUser("p2", true);
  const reason = interaction.options.getString("reason", true).trim();
  if (p1User.id === p2User.id) {
    await interaction.reply({ content: "Pick two different players.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const activeSeason = await prisma.season.findFirst({ where: { isActive: true } });
  if (!activeSeason) {
    await interaction.editReply("No active season.");
    return;
  }

  const p1 = await getOrCreatePlayer(p1User);
  const p2 = await getOrCreatePlayer(p2User);

  // They must share a division this season (matches are keyed by division + pair).
  const shared = await prisma.divisionMember.findFirst({
    where: { playerId: p1.id, division: { seasonId: activeSeason.id } },
    include: { division: { include: { members: { where: { playerId: p2.id } } } } },
  });
  if (!shared || shared.division.members.length === 0) {
    await interaction.editReply(`**${p1.displayName}** and **${p2.displayName}** aren't in the same division this season.`);
    return;
  }
  const division = shared.division;
  const [playerAId, playerBId] = p1.id < p2.id ? [p1.id, p2.id] : [p2.id, p1.id];
  const now = new Date();

  const match = await prisma.match.upsert({
    where: {
      divisionId_playerAId_playerBId_format: { divisionId: division.id, playerAId, playerBId, format: "LEAGUE_BO2" },
    },
    create: {
      divisionId: division.id,
      playerAId,
      playerBId,
      format: "LEAGUE_BO2",
      gamesWonA: 0,
      gamesWonB: 0,
      winnerId: null,
      status: "CONFIRMED",
      reportedAt: now,
      confirmedAt: now,
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: `void 0-0: ${reason}`,
    },
    update: {
      gamesWonA: 0,
      gamesWonB: 0,
      winnerId: null,
      status: "CONFIRMED",
      confirmedAt: now,
      forfeit: false,
      forfeitReason: null,
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: `void 0-0: ${reason}`,
    },
  });
  await recomputeDivisionStandings(division.id).catch(() => {});

  recordAudit({
    actor: actorFromInteractionUser(interaction.user),
    action: "match.void",
    targetType: "Match",
    targetId: match.id,
    summary: `Voided ${p1.displayName} vs ${p2.displayName} 0-0 in ${division.name}`,
    metadata: { matchId: match.id, p1: p1.id, p2: p2.id, divisionId: division.id, seasonId: activeSeason.id, reason },
  });

  await interaction.editReply(
    `✅ Voided the game between **${p1.displayName}** and **${p2.displayName}** in **${division.name}** — recorded **0-0** (finished, no points, not a W/L/D).\n` +
      `Reason (admin-only): _${reason}_`,
  );
}

// Log a strike against a player. Free-text reason; admins act on the count.
async function recordStrike(interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser("player", true);
  const reason = interaction.options.getString("reason", true).trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const player = await getOrCreatePlayer(user);
  await prisma.strike.create({
    data: {
      playerId: player.id,
      reason,
      issuedById: interaction.user.id,
      issuedByName: interaction.user.username,
    },
  });
  const count = await prisma.strike.count({ where: { playerId: player.id } });
  recordAudit({
    actor: actorFromInteractionUser(interaction.user),
    action: "strike.add",
    targetType: "Player",
    targetId: player.id,
    summary: `Strike #${count} on ${player.displayName}: ${reason}`,
    metadata: { reason, count },
  });
  await interaction.editReply(`⚠️ Logged strike **#${count}** for **${player.displayName}** — _${reason}_`);
}

// List a player's strikes, newest first, with the running count.
async function listStrikes(interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser("player", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const player = await prisma.player.findUnique({ where: { discordId: user.id } });
  if (!player) {
    await interaction.editReply(`${user.username} isn't in the league yet — no strikes.`);
    return;
  }
  const strikes = await prisma.strike.findMany({
    where: { playerId: player.id },
    orderBy: { createdAt: "desc" },
  });
  if (strikes.length === 0) {
    await interaction.editReply(`✅ **${player.displayName}** has no strikes.`);
    return;
  }
  const lines = strikes.map(
    (s, i) =>
      `**${strikes.length - i}.** <t:${Math.floor(s.createdAt.getTime() / 1000)}:d> — ${s.reason} _(by ${s.issuedByName})_`,
  );
  await interaction.editReply(
    `⚠️ **${player.displayName}** — **${strikes.length}** strike${strikes.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
  );
}

async function forceResult(interaction: ChatInputCommandInteraction) {
  const pairingId = interaction.options.getString("match-id", true);
  const resultStr = interaction.options.getString("result", true);
  const reason = interaction.options.getString("reason", true);
  const result = parsePairingResult(resultStr);

  if (!result) {
    await interaction.reply({ content: `Invalid result \`${resultStr}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pairing = await prisma.match.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true, division: true },
  });
  if (!pairing) {
    await interaction.editReply(`No set with id \`${pairingId}\`.`);
    return;
  }

  const games = gamesFromResult(result);
  const winnerId = games.a > games.b ? pairing.playerAId : games.b > games.a ? pairing.playerBId : null;
  await prisma.match.update({
    where: { id: pairingId },
    data: {
      gamesWonA: games.a,
      gamesWonB: games.b,
      winnerId,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: reason,
    },
  });
  enqueueAnnounceResult(pairingId).catch(() => {});
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
  recordAudit({
    actor: actorFromInteractionUser(interaction.user),
    action: "pairing.override",
    targetType: "Pairing",
    targetId: pairingId,
    summary: `Override ${pairing.playerA.displayName} vs ${pairing.playerB.displayName}: ${pairing.gamesWonA}-${pairing.gamesWonB} → ${games.a}-${games.b}`,
    metadata: {
      previous: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB, status: pairing.status },
      next: { gamesWonA: games.a, gamesWonB: games.b, status: "CONFIRMED" },
      reason,
      divisionId: pairing.divisionId,
      divisionName: pairing.division.name,
    },
  });

  await interaction.editReply(
    `Force-resolved: **${pairing.playerA.displayName} ${games.a}-${games.b} ${pairing.playerB.displayName}** in **${pairing.division.name}**.\nReason: ${reason}`,
  );
}

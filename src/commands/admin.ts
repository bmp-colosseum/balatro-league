// /admin — admin-only tools that genuinely belong in Discord rather than
// the web dashboard, because admin context is the live chat:
// reading a dispute thread + deciding the result + recording it is one
// continuous flow there, vs context-switching to the web dashboard.
//
// All other admin functions (season setup, signups, division assignment,
// rankings, presets, etc.) live on www.balatroleague.com.

import {
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { MatchSessionState } from "@prisma/client";
import { enqueueAnnounceResult } from "../queue.js";
import { actorFromInteractionUser, recordAudit } from "../audit.js";
import { activeSeasonMemberAutocomplete } from "./autocomplete.js";
import { prisma } from "../db.js";
import { buildLeagueExport, exportFilename, serializeExport } from "../league-export.js";
import { requireAdmin, requireHelper } from "../permissions.js";
import { getOrCreatePlayer } from "../players.js";
import { gamesFromResult, parsePairingResult } from "../scoring.js";
import { recomputeDivisionStandings } from "../standings-cache.js";
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
    .addSubcommand((sub) =>
      sub
        .setName("record-set")
        .setDescription("Manually record a CONFIRMED set (e.g. agreed verbally, never reported).")
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
            .setDescription("Why (e.g. 'agreed in DMs', 'shootout', 'dispute resolution')")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("override-result")
        .setDescription("Force-resolve a disputed set with the correct result.")
        .addStringOption((opt) =>
          opt.setName("set-id").setDescription("ID of the disputed set (from the dispute embed)").setRequired(true),
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
        .setName("export-results")
        .setDescription("Dump the league's restorable state as a JSON file attachment."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("undo-report")
        .setDescription("Remove a reported set so it's back to unplayed (for when something got reported wrong).")
        .addUserOption((opt) => opt.setName("p1").setDescription("Either player in the set").setRequired(true))
        .addUserOption((opt) => opt.setName("p2").setDescription("The other player").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("record-shootout")
        .setDescription("Record a shootout winner to break a tied promo/relegation position.")
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
        .setName("cancel-match")
        .setDescription("Force-cancel a wedged match session (any state). Use when players are stuck.")
        .addStringOption((opt) =>
          opt.setName("match-id").setDescription("Match session id (shown in the embed footer)").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("reason").setDescription("Why — recorded for audit").setRequired(true),
        ),
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
    if (sub === "join-match" || sub === "record-set" || sub === "undo-report" || sub === "record-shootout") {
      if (!(await requireHelper(interaction))) return;
      if (sub === "join-match") return joinMatch(interaction);
      if (sub === "record-set") return recordPairing(interaction);
      if (sub === "undo-report") return undoReport(interaction);
      if (sub === "record-shootout") return recordShootout(interaction);
    }
    // Admin+ subcommands: anything that overrides existing results or
    // exports sensitive data. Helpers can't accidentally rewrite a
    // confirmed pairing or dump league state.
    if (!(await requireAdmin(interaction))) return;
    if (sub === "override-result") return forceResult(interaction);
    if (sub === "export-results") return exportResults(interaction);
    if (sub === "reload-emojis") return reloadEmojis(interaction);
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
        await channel.setLocked(true, `Admin cancel: ${reason}`).catch(() => {});
        await channel.setArchived(true, "Admin cancel").catch(() => {});
      }
    } catch (err) {
      console.warn("[admin cancel-match] failed to post/lock thread:", err);
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
  await interaction.deferReply();

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
  const pairing = await prisma.pairing.findFirst({
    where: {
      playerAId: canonA,
      playerBId: canonB,
      division: { seasonId: activeSeason.id },
    },
    include: { division: { select: { id: true, name: true } } },
  });
  if (!pairing) {
    await interaction.editReply(
      `No set between **${p1User.username}** and **${p2User.username}** in ${activeSeason.name} — nothing to undo.`,
    );
    return;
  }
  await prisma.pairing.delete({ where: { id: pairing.id } });
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
    return { ok: false, error: `${p1.displayName} and ${p2.displayName} aren't in the same division — shootout only makes sense for tied opponents.` };
  }

  const [canonA, canonB] = p1.id < p2.id ? [p1.id, p2.id] : [p2.id, p1.id];
  await prisma.shootout.upsert({
    where: { divisionId_playerAId_playerBId: { divisionId: member.divisionId, playerAId: canonA, playerBId: canonB } },
    create: {
      divisionId: member.divisionId,
      playerAId: canonA,
      playerBId: canonB,
      winnerId: winner.id,
      recordedBy: args.recordedBy,
      notes: args.notes ?? null,
    },
    update: { winnerId: winner.id, recordedBy: args.recordedBy, notes: args.notes ?? null },
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
  await interaction.deferReply();
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
    summary: `Shootout: ${result.winnerName} wins in ${result.divisionName}`,
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
    `⚔ Shootout recorded — **${result.winnerName}** beats <@${loserDiscordId}> ` +
      `in **${result.divisionName}**. Standings sort updated.` +
      (notes ? `\n_Notes: ${notes}_` : ""),
  );
}

// Exported so /report-shootout (in src/commands/report.ts) can call the
// same persistence helper without duplicating the validation logic.
export const __shootoutHelper = persistShootout;

// Build a fresh league snapshot and post it as an ephemeral attachment
// reply so only the admin who ran the command sees the file. The weekly
// cron-driven backup posts publicly to bot-commands; this command is
// for ad-hoc dumps without spamming the channel.
async function exportResults(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const data = await buildLeagueExport();
    const buf = serializeExport(data);
    const filename = exportFilename();
    const attachment = new AttachmentBuilder(buf, { name: filename });
    const pairings = data.seasons.reduce((sum, s) => sum + s.divisions.reduce((d, dv) => d + dv.pairings.length, 0), 0);
    await interaction.editReply({
      content:
        `📦 League snapshot: ${data.seasons.length} seasons, ${data.players.length} players, ` +
        `${pairings} pairings. ` +
        `File size ${(buf.length / 1024).toFixed(1)}KB.`,
      files: [attachment],
    });
    recordAudit({
      actor: actorFromInteractionUser(interaction.user),
      action: "league.export",
      summary: `Exported league snapshot (${data.seasons.length} seasons, ${data.players.length} players)`,
      metadata: { seasonCount: data.seasons.length, playerCount: data.players.length, pairingCount: pairings, sizeBytes: buf.length },
    });
  } catch (err) {
    console.warn("[admin export-results] failed:", err);
    await interaction.editReply("Export failed — check bot logs.");
  }
}

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
  void PermissionFlagsBits;
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

  await interaction.deferReply();

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

  const upserted = await prisma.pairing.upsert({
    where: { divisionId_playerAId_playerBId: { divisionId: division.id, playerAId, playerBId } },
    create: {
      divisionId: division.id,
      playerAId,
      playerBId,
      gamesWonA,
      gamesWonB,
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

  await interaction.editReply(
    `Recorded: **${p1User.username} ${games.a}-${games.b} ${p2User.username}** in **${division.name}**.` +
      (reason ? `\nReason: ${reason}` : ""),
  );
}

async function forceResult(interaction: ChatInputCommandInteraction) {
  const pairingId = interaction.options.getString("set-id", true);
  const resultStr = interaction.options.getString("result", true);
  const reason = interaction.options.getString("reason", true);
  const result = parsePairingResult(resultStr);

  if (!result) {
    await interaction.reply({ content: `Invalid result \`${resultStr}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true, division: true },
  });
  if (!pairing) {
    await interaction.editReply(`No set with id \`${pairingId}\`.`);
    return;
  }

  const games = gamesFromResult(result);
  await prisma.pairing.update({
    where: { id: pairingId },
    data: {
      gamesWonA: games.a,
      gamesWonB: games.b,
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

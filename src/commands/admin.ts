import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { announceResult } from "../announce.js";
import { prisma } from "../db.js";
import { clearMockData, makeRng, seedMockPlayers, simulateDivisionPairings } from "../mock.js";
import { requireAdmin } from "../permissions.js";
import { getOrCreatePlayer } from "../players.js";
import { PLAYERS_PER_DIVISION } from "../pyramid.js";
import { gamesFromResult, parsePairingResult } from "../scoring.js";
import { divisionNameAutocomplete } from "./autocomplete.js";
import type { SlashCommand } from "./types.js";

const RESULT_CHOICES = [
  { name: "2-0 (P1 won both)", value: "2-0" },
  { name: "1-1 (draw)", value: "1-1" },
  { name: "0-2 (P2 won both)", value: "0-2" },
] as const;

export const admin: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("League admin tools.")
    .addSubcommand((sub) =>
      sub
        .setName("record-set")
        .setDescription("Write a CONFIRMED set result directly. Useful for testing or admin overrides.")
        .addUserOption((opt) =>
          opt.setName("p1").setDescription("Player 1").setRequired(true),
        )
        .addUserOption((opt) =>
          opt.setName("p2").setDescription("Player 2").setRequired(true),
        )
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
            .setDescription("Optional note (e.g. 'shootout', 'dispute resolution', 'mock test')")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("override-result")
        .setDescription("Resolve a disputed set by writing the correct result.")
        .addStringOption((opt) =>
          opt.setName("set-id").setDescription("ID of the disputed set").setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("result")
            .setDescription("Result from playerA's POV (use /standings to identify playerA)")
            .setRequired(true)
            .addChoices(...RESULT_CHOICES),
        )
        .addStringOption((opt) =>
          opt.setName("reason").setDescription("Reason for the override").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("add-fake-players")
        .setDescription("Fill empty seats in the active season's divisions with mock players.")
        .addIntegerOption((opt) =>
          opt
            .setName("per-division")
            .setDescription("Target headcount per division (default 5)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("auto-play")
        .setDescription("Auto-play every unplayed set in the active season (or one division).")
        .addStringOption((opt) =>
          opt
            .setName("division")
            .setDescription("Division name to simulate. Omit to simulate every division.")
            .setRequired(false)
            .setAutocomplete(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("seed")
            .setDescription("RNG seed for reproducibility (default: timestamp)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete-fake-players")
        .setDescription("Delete every fake player and any sets involving them. Real players untouched."),
    ),

  autocomplete: divisionNameAutocomplete,

  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireAdmin(interaction))) return;
    const sub = interaction.options.getSubcommand();
    if (sub === "record-set") return recordPairing(interaction);
    if (sub === "override-result") return forceResult(interaction);
    if (sub === "add-fake-players") return seedMock(interaction);
    if (sub === "auto-play") return simulatePairings(interaction);
    if (sub === "delete-fake-players") return clearMock(interaction);
  },
};

async function seedMock(interaction: ChatInputCommandInteraction) {
  const perDiv = interaction.options.getInteger("per-division") ?? PLAYERS_PER_DIVISION;
  await interaction.deferReply();
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    await interaction.editReply("No active season. Run `/league create-season` first.");
    return;
  }
  const { created, divisionsTouched } = await seedMockPlayers(season.id, PLAYERS_PER_DIVISION, perDiv);
  await interaction.editReply(
    created === 0
      ? "All divisions already at capacity — nothing to fill."
      : `Filled ${divisionsTouched} division(s) with ${created} mock player(s) (target: ${perDiv}/div).`,
  );
}

async function simulatePairings(interaction: ChatInputCommandInteraction) {
  const divName = interaction.options.getString("division");
  const seed = interaction.options.getInteger("seed") ?? Date.now();
  await interaction.deferReply();
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    await interaction.editReply("No active season.");
    return;
  }
  const rand = makeRng(seed);
  const divisions = divName
    ? await prisma.division.findMany({ where: { seasonId: season.id, name: divName } })
    : await prisma.division.findMany({
        where: { seasonId: season.id },
        orderBy: [{ rarity: "asc" }, { groupNumber: "asc" }],
      });
  if (divisions.length === 0) {
    await interaction.editReply(divName ? `No division named \`${divName}\`.` : "No divisions in season.");
    return;
  }
  let total = 0;
  for (const d of divisions) {
    total += await simulateDivisionPairings(d.id, rand);
  }
  await interaction.editReply(
    `Played ${total} new set(s) across ${divisions.length} division(s) (seed: ${seed}). Check \`/standings\`.`,
  );
}

async function clearMock(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const count = await clearMockData();
  await interaction.editReply(
    count === 0 ? "No mock players to clear." : `Cleared ${count} mock player(s) and their data.`,
  );
}

async function recordPairing(interaction: ChatInputCommandInteraction) {
  const p1User = interaction.options.getUser("p1", true);
  const p2User = interaction.options.getUser("p2", true);
  const resultStr = interaction.options.getString("result", true);
  const reason = interaction.options.getString("reason") ?? undefined;
  const result = parsePairingResult(resultStr);

  if (!result) {
    await interaction.reply({
      content: `Invalid result \`${resultStr}\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (p1User.id === p2User.id) {
    await interaction.reply({
      content: "P1 and P2 must be different players.",
      flags: MessageFlags.Ephemeral,
    });
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
    where: {
      divisionId_playerAId_playerBId: { divisionId: division.id, playerAId, playerBId },
    },
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
  announceResult(upserted.id).catch(() => {});

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
    await interaction.reply({
      content: `Invalid result \`${resultStr}\`.`,
      flags: MessageFlags.Ephemeral,
    });
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
  announceResult(pairingId).catch(() => {});

  await interaction.editReply(
    `Force-resolved: **${pairing.playerA.displayName} ${games.a}-${games.b} ${pairing.playerB.displayName}** in **${pairing.division.name}**.\nReason: ${reason}`,
  );
}

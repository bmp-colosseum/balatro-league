// Button dispatcher for the match-session state machine.
// Custom IDs:
//   match:accept:{sessionId}
//   match:decline:{sessionId}
//   match:choosefirst:{sessionId}:{playerId}
//   match:ban:{sessionId}:{poolIdx}
//   match:pick:{sessionId}:{poolIdx}
//   match:winner:{sessionId}:{playerId}

import {
  ChannelType,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { MatchSessionState, Prisma, type MatchSession } from "@prisma/client";
import { announceResult } from "../announce.js";
import { prisma } from "../db.js";
import { generatePool, presetForDivision } from "../match-config.js";
import { renderMatch } from "../match-render.js";
import {
  emptyGameState,
  phaseFor,
  remainingCombos,
  type GameState,
} from "../match-session.js";
import type { ButtonHandler, SelectMenuHandler } from "./types.js";

function parseGame(json: string | null): GameState | null {
  if (!json) return null;
  try { return JSON.parse(json) as GameState; } catch { return null; }
}
function parsePool(json: string | null) {
  if (!json) return [];
  try { return JSON.parse(json) as Array<{ deck: string; stake: string }>; } catch { return []; }
}

async function loadSession(id: string) {
  return prisma.matchSession.findUnique({ where: { id } });
}

async function loadPlayers(session: { playerAId: string; playerBId: string }) {
  const [a, b] = await Promise.all([
    prisma.player.findUniqueOrThrow({ where: { id: session.playerAId } }),
    prisma.player.findUniqueOrThrow({ where: { id: session.playerBId } }),
  ]);
  return { playerA: a, playerB: b };
}

// Optimistic-locked update: only succeeds if `version` still matches what we read.
// On version-mismatch (concurrent click won the race), returns null so the caller
// can show a "refresh and try again" message.
async function updateSession(
  session: MatchSession,
  data: Prisma.MatchSessionUpdateManyMutationInput,
): Promise<MatchSession | null> {
  const result = await prisma.matchSession.updateMany({
    where: { id: session.id, version: session.version },
    data: { ...data, version: { increment: 1 } },
  });
  if (result.count === 0) return null;
  return prisma.matchSession.findUnique({ where: { id: session.id } });
}

type AnyInteraction = ButtonInteraction | StringSelectMenuInteraction;

async function refreshMessage(interaction: AnyInteraction, session: MatchSession) {
  const { playerA, playerB } = await loadPlayers(session);
  const { embeds, components } = renderMatch(session, playerA, playerB);
  await interaction.update({ embeds, components });
}

async function reply(interaction: AnyInteraction, content: string) {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function raceLost(interaction: AnyInteraction) {
  return reply(interaction, "Someone else just acted on this match — the buttons may have changed. Try again.");
}

async function requireActor(interaction: AnyInteraction, expectedDiscordId: string): Promise<boolean> {
  if (interaction.user.id !== expectedDiscordId) {
    await reply(interaction, "Only the player whose turn it is can use this button.");
    return false;
  }
  return true;
}

export const matchButtons: ButtonHandler = {
  prefix: "match:",
  async execute(interaction: ButtonInteraction) {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const sessionId = parts[2];
    if (!sessionId) {
      await reply(interaction, "Malformed button.");
      return;
    }

    const session = await loadSession(sessionId);
    if (!session) {
      await reply(interaction, "Match session not found.");
      return;
    }

    if (action === "accept") return handleAccept(interaction, session);
    if (action === "decline") return handleDecline(interaction, session);
    if (action === "choosefirst") return handleChooseFirst(interaction, session, parts[3]);
    if (action === "pick") return handlePick(interaction, session, parts[3]);
    if (action === "winner") return handleWinner(interaction, session, parts[3]);

    await reply(interaction, "Unknown match action.");
  },
};

// Select-menu side of the match interactions — currently only used for
// batch ban submission. Custom id format: `match:bans:<sessionId>`.
export const matchSelectMenus: SelectMenuHandler = {
  prefix: "match:bans:",
  async execute(interaction) {
    const sessionId = interaction.customId.slice("match:bans:".length);
    if (!sessionId) return reply(interaction, "Malformed select menu.");
    const session = await loadSession(sessionId);
    if (!session) return reply(interaction, "Match session not found.");
    return handleBanBatch(interaction, session);
  },
};

async function closeMatchThread(interaction: AnyInteraction, threadId: string | null): Promise<void> {
  if (!threadId) return;
  try {
    const channel = await interaction.client.channels.fetch(threadId);
    if (channel && (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread)) {
      const thread = channel as ThreadChannel;
      // Lock first (no new messages), then archive (collapsed in sidebar).
      // setArchived alone would let users post in it again; setLocked freezes it.
      await thread.setLocked(true, "Match complete").catch(() => {});
      await thread.setArchived(true, "Match complete").catch(() => {});
    }
  } catch {
    // Thread may have been deleted manually; ignore.
  }
}

// === Handlers ===

async function handleAccept(interaction: ButtonInteraction, session: MatchSession) {
  if (session.state !== "WAITING_ACCEPT") {
    return reply(interaction, "This match is no longer waiting for acceptance.");
  }
  // Expiry check — survives bot restarts unlike the original setTimeout.
  if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
    const cancelled = await updateSession(session, { state: MatchSessionState.CANCELLED });
    if (cancelled) await refreshMessage(interaction, cancelled);
    return reply(interaction, "This match invite expired.");
  }
  const { playerB } = await loadPlayers(session);
  if (!(await requireActor(interaction, playerB.discordId))) return;

  const preset = await presetForDivision(session.divisionId);
  if (!preset || preset.decks.length === 0 || preset.stakes.length === 0) {
    return reply(interaction, "This season's match config preset is missing or empty — ask an admin to set one before accepting.");
  }
  const pool = generatePool(preset.decks, preset.stakes);

  const { playerA } = await loadPlayers(session);
  const firstId = Math.random() < 0.5 ? playerA.id : playerB.id;

  // Create thread for match chat (failures fall back to the parent channel).
  // Name includes a short session-id suffix so repeat matchups don't collide.
  let threadId = session.threadId;
  if (!threadId && interaction.channel && interaction.channel.type === ChannelType.GuildText) {
    try {
      const suffix = session.id.slice(-6);
      const thread = await (interaction.channel as TextChannel).threads.create({
        name: `Match: ${playerA.displayName} vs ${playerB.displayName} · ${suffix}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
      threadId = thread.id;
    } catch {
      // perms issue; keep going in the parent channel
    }
  }

  const updated = await updateSession(session, {
    state: MatchSessionState.GAME_1_BAN,
    acceptedAt: new Date(),
    pool: JSON.stringify(pool),
    game1: JSON.stringify(emptyGameState(firstId)),
    threadId,
  });
  if (!updated) return raceLost(interaction);

  await refreshMessage(interaction, updated);

  if (threadId && threadId !== session.threadId) {
    try {
      const thread = await interaction.client.channels.fetch(threadId);
      if (thread && thread.type === ChannelType.PublicThread) {
        await thread.members.add(playerA.discordId).catch(() => {});
        await thread.members.add(playerB.discordId).catch(() => {});
        const { embeds, components } = renderMatch(updated, playerA, playerB);
        await thread.send({ embeds, components });
      }
    } catch {
      // ignore
    }
  }
}

async function handleDecline(interaction: ButtonInteraction, session: MatchSession) {
  if (session.state !== "WAITING_ACCEPT") {
    return reply(interaction, "This match is no longer waiting.");
  }
  const { playerB } = await loadPlayers(session);
  if (!(await requireActor(interaction, playerB.discordId))) return;

  const updated = await updateSession(session, { state: MatchSessionState.CANCELLED });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

async function handleChooseFirst(interaction: ButtonInteraction, session: MatchSession, firstIdRaw: string | undefined) {
  if (session.state !== "GAME_2_CHOOSE_FIRST") {
    return reply(interaction, "Not waiting for game-2 first-ban choice.");
  }
  if (!firstIdRaw) return reply(interaction, "Malformed button.");
  const game1 = parseGame(session.game1);
  if (!game1?.winnerId) return reply(interaction, "Game 1 winner not recorded.");

  const loserId = game1.winnerId === session.playerAId ? session.playerBId : session.playerAId;
  const loser = await prisma.player.findUniqueOrThrow({ where: { id: loserId } });
  if (!(await requireActor(interaction, loser.discordId))) return;

  if (firstIdRaw !== session.playerAId && firstIdRaw !== session.playerBId) {
    return reply(interaction, "Invalid first-ban player.");
  }

  const updated = await updateSession(session, {
    state: MatchSessionState.GAME_2_BAN,
    game2: JSON.stringify(emptyGameState(firstIdRaw)),
  });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

// Batch ban handler — fired by a StringSelectMenu submission with all of
// the player's bans for this step. Cuts Discord API traffic for a match
// from 8 message edits to 4 (one per ban step + pick + winner per game).
async function handleBanBatch(interaction: StringSelectMenuInteraction, session: MatchSession) {
  const indices = interaction.values.map((v) => parseInt(v, 10));
  if (indices.some((n) => Number.isNaN(n))) return reply(interaction, "Invalid selection.");

  const isGame1 = session.state === "GAME_1_BAN";
  const isGame2 = session.state === "GAME_2_BAN";
  if (!isGame1 && !isGame2) return reply(interaction, "Not in a ban phase.");

  const gameJson = isGame1 ? session.game1 : session.game2;
  const game = parseGame(gameJson);
  const pool = parsePool(session.pool);
  if (!game) return reply(interaction, "Game state missing.");

  const phase = phaseFor(game, session.playerAId, session.playerBId, pool.length);
  if (phase.kind !== "BAN") return reply(interaction, "Not a ban phase.");

  const actor = await prisma.player.findUniqueOrThrow({ where: { id: phase.whoseBanId } });
  if (!(await requireActor(interaction, actor.discordId))) return;

  if (indices.length !== phase.remainingForThem) {
    return reply(interaction, `You need to pick exactly ${phase.remainingForThem} combo(s) to ban.`);
  }
  if (new Set(indices).size !== indices.length) {
    return reply(interaction, "Can't ban the same combo twice.");
  }
  if (indices.some((i) => game.bans.includes(i))) {
    return reply(interaction, "One of those combos was already banned.");
  }

  const newGame: GameState = { ...game, bans: [...game.bans, ...indices] };
  const newPhase = phaseFor(newGame, session.playerAId, session.playerBId, pool.length);
  let newState: MatchSessionState = session.state;
  if (newPhase.kind === "PICK") {
    newState = isGame1 ? MatchSessionState.GAME_1_PICK : MatchSessionState.GAME_2_PICK;
  }

  const data: Prisma.MatchSessionUpdateManyMutationInput = isGame1
    ? { game1: JSON.stringify(newGame), state: newState }
    : { game2: JSON.stringify(newGame), state: newState };
  const updated = await updateSession(session, data);
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

async function handlePick(interaction: ButtonInteraction, session: MatchSession, idxRaw: string | undefined) {
  if (!idxRaw) return reply(interaction, "Malformed button.");
  const idx = parseInt(idxRaw, 10);
  if (Number.isNaN(idx)) return reply(interaction, "Invalid index.");

  const isGame1 = session.state === "GAME_1_PICK";
  const isGame2 = session.state === "GAME_2_PICK";
  if (!isGame1 && !isGame2) return reply(interaction, "Not in a pick phase.");

  const gameJson = isGame1 ? session.game1 : session.game2;
  const game = parseGame(gameJson);
  const pool = parsePool(session.pool);
  if (!game) return reply(interaction, "Game state missing.");

  const remaining = remainingCombos(pool, game.bans);
  if (!remaining.find((r) => r.idx === idx)) {
    return reply(interaction, "That combo isn't in the remaining 2.");
  }

  // SECOND player picks (the one who banned 3 in the middle, not the one
  // who banned 1 + 3 = 4). phaseFor encodes this — pickerId is the other.
  const phase = phaseFor(game, session.playerAId, session.playerBId, pool.length);
  if (phase.kind !== "PICK") return reply(interaction, "Not a pick phase.");
  const picker = await prisma.player.findUniqueOrThrow({ where: { id: phase.pickerId } });
  if (!(await requireActor(interaction, picker.discordId))) return;

  const newGame: GameState = { ...game, pickedDeckIdx: idx };
  const newState: MatchSessionState = isGame1 ? MatchSessionState.GAME_1_PLAYING : MatchSessionState.GAME_2_PLAYING;
  const data: Prisma.MatchSessionUpdateManyMutationInput = isGame1
    ? { game1: JSON.stringify(newGame), state: newState }
    : { game2: JSON.stringify(newGame), state: newState };
  const updated = await updateSession(session, data);
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

async function handleWinner(interaction: ButtonInteraction, session: MatchSession, winnerIdRaw: string | undefined) {
  if (!winnerIdRaw) return reply(interaction, "Malformed button.");
  if (winnerIdRaw !== session.playerAId && winnerIdRaw !== session.playerBId) {
    return reply(interaction, "Invalid winner.");
  }
  const { playerA, playerB } = await loadPlayers(session);
  if (interaction.user.id !== playerA.discordId && interaction.user.id !== playerB.discordId) {
    return reply(interaction, "Only the two players in this match can report the winner.");
  }

  const isGame1 = session.state === "GAME_1_PLAYING";
  const isGame2 = session.state === "GAME_2_PLAYING";
  if (!isGame1 && !isGame2) return reply(interaction, "Not waiting for a winner.");

  const gameJson = isGame1 ? session.game1 : session.game2;
  const game = parseGame(gameJson);
  if (!game) return reply(interaction, "Game state missing.");

  const newGame: GameState = { ...game, winnerId: winnerIdRaw };

  if (isGame1) {
    const updated = await updateSession(session, {
      game1: JSON.stringify(newGame),
      state: MatchSessionState.GAME_2_CHOOSE_FIRST,
    });
    if (!updated) return raceLost(interaction);
    return refreshMessage(interaction, updated);
  }

  // Game 2 winner: finalize.
  const game1 = parseGame(session.game1);
  if (!game1?.winnerId) return reply(interaction, "Game 1 winner missing — can't finalize.");

  const aWins = (game1.winnerId === session.playerAId ? 1 : 0) + (winnerIdRaw === session.playerAId ? 1 : 0);
  const bWins = (game1.winnerId === session.playerBId ? 1 : 0) + (winnerIdRaw === session.playerBId ? 1 : 0);

  const [canonA, canonB] = session.playerAId < session.playerBId
    ? [session.playerAId, session.playerBId]
    : [session.playerBId, session.playerAId];
  const gamesWonA = canonA === session.playerAId ? aWins : bWins;
  const gamesWonB = canonA === session.playerAId ? bWins : aWins;

  // Bump version first; if we lose the race, don't write the Pairing.
  const updated = await updateSession(session, {
    game2: JSON.stringify(newGame),
    state: MatchSessionState.COMPLETE,
    completedAt: new Date(),
  });
  if (!updated) return raceLost(interaction);

  // Normal /start-match results — NOT admin overrides. reporterId is the user
  // who clicked the final winner button (both players have equal authority here).
  const reporter = interaction.user.id === playerA.discordId ? playerA : playerB;
  const pairing = await prisma.pairing.upsert({
    where: {
      divisionId_playerAId_playerBId: {
        divisionId: session.divisionId,
        playerAId: canonA,
        playerBId: canonB,
      },
    },
    create: {
      divisionId: session.divisionId,
      playerAId: canonA,
      playerBId: canonB,
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      reporterId: reporter.id,
      reportedAt: new Date(),
      confirmedAt: new Date(),
    },
    update: {
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      reporterId: reporter.id,
      reportedAt: new Date(),
      confirmedAt: new Date(),
    },
  });

  await prisma.matchSession.update({
    where: { id: updated.id },
    data: { pairingId: pairing.id },
  });

  await refreshMessage(interaction, updated);
  // Close the match thread + fire the auto-announce. Both are best-effort
  // and don't block the user-facing message update.
  closeMatchThread(interaction, updated.threadId).catch(() => {});
  announceResult(pairing.id).catch(() => {});
}

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
  PermissionFlagsBits,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from "discord.js";
import { MatchSessionState, Prisma, type MatchSession } from "@prisma/client";
import { announceResult } from "../announce.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import {
  createGuildTextChannel,
  ensureGuildCategory,
} from "../discord-helpers.js";
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
    if (action === "banconfirm") return handleBanConfirm(interaction, session);
    if (action === "pick") return handlePick(interaction, session, parts[3]);
    if (action === "winner") return handleWinner(interaction, session, parts[3]);

    await reply(interaction, "Unknown match action.");
  },
};

// Multi-select for the ban phase. Player picks N decks from the dropdown
// (Discord enforces the count via min/max), interaction lands here, we
// stash the picks on game.pendingBans. They click the Confirm button
// (matchButtons handler above) to actually apply them.
export const matchSelectMenus: SelectMenuHandler = {
  prefix: "match:banselect:",
  async execute(interaction) {
    const sessionId = interaction.customId.split(":")[2];
    if (!sessionId) {
      await reply(interaction, "Malformed select menu.");
      return;
    }
    const session = await loadSession(sessionId);
    if (!session) {
      await reply(interaction, "Match session not found.");
      return;
    }
    await handleBanSelect(interaction, session);
  },
};

// Shared helper for the two ban interactions — pulls the current game's
// state, validates the actor is the player whose turn it is, and returns
// what's needed. Returns null after replying with an error.
async function loadBanContext(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  session: MatchSession,
): Promise<{
  gameNum: 1 | 2 | 3;
  gameField: "game1" | "game2" | "game3";
  game: GameState;
  expected: number;
} | null> {
  const gameNum =
    session.state === "GAME_1_BAN" ? 1 :
    session.state === "GAME_2_BAN" ? 2 :
    session.state === "GAME_3_BAN" ? 3 : 0;
  if (gameNum === 0) {
    await reply(interaction, "Not in a ban phase.");
    return null;
  }
  const gameField: "game1" | "game2" | "game3" = `game${gameNum}` as const;
  const game = parseGame(session[gameField]);
  if (!game) {
    await reply(interaction, "Game state missing.");
    return null;
  }
  const phase = phaseFor(game, session.playerAId, session.playerBId, game.pool.length);
  if (phase.kind !== "BAN") {
    await reply(interaction, "Not a ban phase.");
    return null;
  }
  const actor = await prisma.player.findUniqueOrThrow({ where: { id: phase.whoseBanId } });
  if (!(await requireActor(interaction, actor.discordId))) return null;
  return { gameNum: gameNum as 1 | 2 | 3, gameField, game, expected: phase.remainingForThem };
}

// Selection-only handler: writes the chosen indices to game.pendingBans
// without actually banning them. Player can re-select before clicking
// Confirm. The render reflects the pending state by default-selecting
// those options in the menu + enabling the Confirm button.
async function handleBanSelect(interaction: StringSelectMenuInteraction, session: MatchSession) {
  const ctx = await loadBanContext(interaction, session);
  if (!ctx) return;
  const selected = interaction.values.map((v) => parseInt(v, 10)).filter((n) => !Number.isNaN(n));
  if (selected.length !== ctx.expected) {
    return reply(interaction, `Pick exactly ${ctx.expected} combo(s) to ban.`);
  }
  if (selected.some((idx) => ctx.game.bans.includes(idx))) {
    return reply(interaction, "Some of those are already banned.");
  }
  const newGame: GameState = { ...ctx.game, pendingBans: selected };
  const updated = await updateSession(session, {
    [ctx.gameField]: JSON.stringify(newGame),
  } as Prisma.MatchSessionUpdateManyMutationInput);
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

// Commit-the-pending-bans handler: takes the pendingBans on the game,
// folds them into the actual bans array, advances phase. Disabled in
// the UI until pendingBans count matches the expected ban count.
async function handleBanConfirm(interaction: ButtonInteraction, session: MatchSession) {
  const ctx = await loadBanContext(interaction, session);
  if (!ctx) return;
  const pending = ctx.game.pendingBans ?? [];
  if (pending.length !== ctx.expected) {
    return reply(interaction, `Pick ${ctx.expected} combo(s) in the menu first.`);
  }
  if (pending.some((idx) => ctx.game.bans.includes(idx))) {
    return reply(interaction, "Some of those bans were already applied — pick again.");
  }
  const newGame: GameState = {
    ...ctx.game,
    bans: [...ctx.game.bans, ...pending],
    pendingBans: undefined,
  };
  const newPhase = phaseFor(newGame, session.playerAId, session.playerBId, newGame.pool.length);
  let newState: MatchSessionState = session.state;
  if (newPhase.kind === "PICK") {
    newState = ctx.gameNum === 1 ? MatchSessionState.GAME_1_PICK
      : ctx.gameNum === 2 ? MatchSessionState.GAME_2_PICK
      : MatchSessionState.GAME_3_PICK;
  }
  const updated = await updateSession(session, {
    [ctx.gameField]: JSON.stringify(newGame),
    state: newState,
  } as Prisma.MatchSessionUpdateManyMutationInput);
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

// Lock the per-match channel for further posts when the match completes.
// View permission is kept so players can scroll back through bans/picks
// and the final result; send is revoked on @everyone and on the two
// player-specific overwrites we added at channel creation. Admin can
// later delete the channel manually or via a cleanup pass.
async function closeMatchChannel(interaction: AnyInteraction, channelId: string | null): Promise<void> {
  if (!channelId) return;
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const text = channel as TextChannel;
    const guildId = text.guild.id;
    await text.permissionOverwrites
      .edit(guildId, { SendMessages: false }, { reason: "Match complete" })
      .catch(() => {});
    // Flip SendMessages off on each per-user overwrite (kept ViewChannel
    // so history stays visible). discord.js OverwriteType.Member === 1.
    for (const ow of text.permissionOverwrites.cache.values()) {
      if (ow.type === 1) {
        await text.permissionOverwrites
          .edit(ow.id, { ViewChannel: true, SendMessages: false }, { reason: "Match complete" })
          .catch(() => {});
      }
    }
    // PermissionFlagsBits import is referenced only to keep the lint pass
    // calm in case we extend the lock semantics later. Touch it explicitly.
    void PermissionFlagsBits;
  } catch {
    // Channel may have been deleted manually; ignore.
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

  // Casual /challenge matches have no divisionId — fall back to the
  // global Default preset.
  const preset = session.divisionId
    ? await presetForDivision(session.divisionId)
    : await prisma.matchConfigPreset.findUnique({ where: { name: "Default" } });
  if (!preset || preset.decks.length === 0 || preset.stakes.length === 0) {
    return reply(interaction, "Deck preset is missing or empty — ask an admin to set one before accepting.");
  }
  const game1Pool = generatePool(preset.decks, preset.stakes);

  const { playerA } = await loadPlayers(session);
  const firstId = Math.random() < 0.5 ? playerA.id : playerB.id;

  // Create a private text channel for this match in the '🎴 Matches'
  // category. Only the two players + staff roles can see it. Used to be
  // a thread in the parent channel, but a real channel lets us hide it
  // from everyone else AND keeps the bot-commands channel clean (where
  // /start-match might have been run from). Failure falls back to no
  // channel — the match still proceeds in the original channel via the
  // interaction message.
  let matchChannelId = session.threadId; // legacy field name; now stores a channel id
  if (!matchChannelId && interaction.guildId) {
    const category = await ensureGuildCategory(interaction.guildId, "🎴 Matches");
    const suffix = session.id.slice(-6);
    // Discord channel names: lowercase, no spaces, max ~100 chars.
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20);
    const channelName = `match-${slug(playerA.displayName)}-vs-${slug(playerB.displayName)}-${suffix}`;
    // Look up admin role IDs so staff can drop in to mediate disputes
    // without needing the players to invite them manually.
    const staffBindings = await prisma.roleBinding.findMany({
      where: { tier: { in: ["ADMIN", "MOD"] } },
    });
    const staffRoleIds = staffBindings.map((b) => b.discordRoleId);
    const created = await createGuildTextChannel(interaction.guildId, channelName, {
      parentId: category?.id,
      topic: `${playerA.displayName} vs ${playerB.displayName}${session.isCasual ? " · casual" : ""}`,
      visibleToRoleIds: staffRoleIds,
      visibleToUserIds: [playerA.discordId, playerB.discordId],
    });
    if (created) matchChannelId = created.id;
  }

  const updated = await updateSession(session, {
    state: MatchSessionState.GAME_1_BAN,
    acceptedAt: new Date(),
    // session.pool is kept in sync with game1's pool for legacy callers;
    // game2/game3 each get their own fresh pool generated at ChooseFirst.
    pool: JSON.stringify(game1Pool),
    game1: JSON.stringify(emptyGameState(firstId, game1Pool)),
    threadId: matchChannelId,
  });
  if (!updated) return raceLost(interaction);

  await refreshMessage(interaction, updated);

  if (matchChannelId && matchChannelId !== session.threadId) {
    try {
      const channel = await interaction.client.channels.fetch(matchChannelId);
      if (channel && channel.type === ChannelType.GuildText) {
        const { embeds, components } = renderMatch(updated, playerA, playerB);
        await channel.send({
          content: `<@${playerA.discordId}> <@${playerB.discordId}> — your match channel. Play here, the bot will guide you through bans/picks.`,
          embeds,
          components,
        });
      }
    } catch (err) {
      console.warn(`[match] failed to post into match channel ${matchChannelId}:`, err);
    }
  }
  // Hush the unused-env warning when we don't reference it elsewhere yet.
  void env;
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
  const isGame2 = session.state === "GAME_2_CHOOSE_FIRST";
  const isGame3 = session.state === "GAME_3_CHOOSE_FIRST";
  if (!isGame2 && !isGame3) {
    return reply(interaction, "Not waiting for a first-ban choice.");
  }
  if (!firstIdRaw) return reply(interaction, "Malformed button.");

  // Loser of the PREVIOUS game chooses who bans first in the next.
  const prevGame = parseGame(isGame2 ? session.game1 : session.game2);
  if (!prevGame?.winnerId) return reply(interaction, "Previous game winner not recorded.");
  const loserId = prevGame.winnerId === session.playerAId ? session.playerBId : session.playerAId;
  const loser = await prisma.player.findUniqueOrThrow({ where: { id: loserId } });
  if (!(await requireActor(interaction, loser.discordId))) return;

  if (firstIdRaw !== session.playerAId && firstIdRaw !== session.playerBId) {
    return reply(interaction, "Invalid first-ban player.");
  }

  // Each game gets a fresh deck/stake pool — bans don't carry over and
  // game N doesn't reuse game N-1's shuffle. Re-fetch the preset to draw
  // from the same configured decks/stakes the match was set up with.
  const preset = session.divisionId
    ? await presetForDivision(session.divisionId)
    : await prisma.matchConfigPreset.findUnique({ where: { name: "Default" } });
  if (!preset || preset.decks.length === 0 || preset.stakes.length === 0) {
    return reply(interaction, "Deck preset is missing or empty — ask an admin.");
  }
  // Collect every deck NAME that appeared in any prior game's pool so the
  // new pool can avoid them (variety across games). generatePool falls
  // back to the full deck list if the exclusion would starve the pool.
  const priorDecks = new Set<string>();
  const game1 = parseGame(session.game1);
  if (game1?.pool) game1.pool.forEach((e) => priorDecks.add(e.deck));
  if (isGame3) {
    const game2 = parseGame(session.game2);
    if (game2?.pool) game2.pool.forEach((e) => priorDecks.add(e.deck));
  }
  const freshPool = generatePool(
    preset.decks,
    preset.stakes,
    undefined,
    undefined,
    [...priorDecks],
  );

  const data: Prisma.MatchSessionUpdateManyMutationInput = isGame2
    ? { state: MatchSessionState.GAME_2_BAN, game2: JSON.stringify(emptyGameState(firstIdRaw, freshPool)) }
    : { state: MatchSessionState.GAME_3_BAN, game3: JSON.stringify(emptyGameState(firstIdRaw, freshPool)) };
  const updated = await updateSession(session, data);
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

async function handlePick(interaction: ButtonInteraction, session: MatchSession, idxRaw: string | undefined) {
  if (!idxRaw) return reply(interaction, "Malformed button.");
  const idx = parseInt(idxRaw, 10);
  if (Number.isNaN(idx)) return reply(interaction, "Invalid index.");

  const gameNum =
    session.state === "GAME_1_PICK" ? 1 :
    session.state === "GAME_2_PICK" ? 2 :
    session.state === "GAME_3_PICK" ? 3 : 0;
  if (gameNum === 0) return reply(interaction, "Not in a pick phase.");

  const gameField: "game1" | "game2" | "game3" = `game${gameNum}` as const;
  const gameJson = session[gameField];
  const game = parseGame(gameJson);
  if (!game) return reply(interaction, "Game state missing.");
  const pool = game.pool;

  const remaining = remainingCombos(pool, game.bans);
  if (!remaining.find((r) => r.idx === idx)) {
    return reply(interaction, "That combo isn't in the remaining 2.");
  }

  const phase = phaseFor(game, session.playerAId, session.playerBId, pool.length);
  if (phase.kind !== "PICK") return reply(interaction, "Not a pick phase.");
  const picker = await prisma.player.findUniqueOrThrow({ where: { id: phase.pickerId } });
  if (!(await requireActor(interaction, picker.discordId))) return;

  const newGame: GameState = { ...game, pickedDeckIdx: idx };
  const newState: MatchSessionState =
    gameNum === 1 ? MatchSessionState.GAME_1_PLAYING
    : gameNum === 2 ? MatchSessionState.GAME_2_PLAYING
    : MatchSessionState.GAME_3_PLAYING;
  const data: Prisma.MatchSessionUpdateManyMutationInput = {
    [gameField]: JSON.stringify(newGame),
    state: newState,
  } as Prisma.MatchSessionUpdateManyMutationInput;
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
  const isGame3 = session.state === "GAME_3_PLAYING";
  if (!isGame1 && !isGame2 && !isGame3) return reply(interaction, "Not waiting for a winner.");

  const gameJson = isGame1 ? session.game1 : isGame2 ? session.game2 : session.game3;
  const game = parseGame(gameJson);
  if (!game) return reply(interaction, "Game state missing.");

  const newGame: GameState = { ...game, winnerId: winnerIdRaw };

  // Helper: count wins per player across played games (treating in-progress
  // game as just-recorded if applicable).
  const winsFor = (id: string, includeCurrent: boolean) => {
    const g1 = parseGame(session.game1)?.winnerId;
    const g2 = parseGame(session.game2)?.winnerId;
    const g3 = parseGame(session.game3)?.winnerId;
    let count = 0;
    if (g1 === id) count++;
    if (g2 === id && !(isGame2 && includeCurrent)) count++;
    if (g3 === id && !(isGame3 && includeCurrent)) count++;
    if (includeCurrent && winnerIdRaw === id) count++;
    return count;
  };

  if (isGame1) {
    // BO1: end immediately. BO2 / BO3: go to game 2.
    if (session.bestOf === 1) {
      return finalizeMatch(interaction, session, newGame, "game1");
    }
    const updated = await updateSession(session, {
      game1: JSON.stringify(newGame),
      state: MatchSessionState.GAME_2_CHOOSE_FIRST,
    });
    if (!updated) return raceLost(interaction);
    return refreshMessage(interaction, updated);
  }

  if (isGame2) {
    // BO3: if game 1+2 split (1-1), play game 3. Otherwise we're done.
    if (session.bestOf === 3) {
      const aTotal = winsFor(session.playerAId, true);
      const bTotal = winsFor(session.playerBId, true);
      if (aTotal === 1 && bTotal === 1) {
        const updated = await updateSession(session, {
          game2: JSON.stringify(newGame),
          state: MatchSessionState.GAME_3_CHOOSE_FIRST,
        });
        if (!updated) return raceLost(interaction);
        return refreshMessage(interaction, updated);
      }
    }
    return finalizeMatch(interaction, session, newGame, "game2");
  }

  // Game 3 (BO3 only): always finalize.
  return finalizeMatch(interaction, session, newGame, "game3");
}

async function finalizeMatch(
  interaction: ButtonInteraction,
  session: MatchSession,
  finalGame: GameState,
  finalGameField: "game1" | "game2" | "game3",
) {
  const { playerA, playerB } = await loadPlayers(session);
  const g1 = parseGame(session.game1);
  const g2 = parseGame(session.game2);
  const g3 = parseGame(session.game3);
  // Use finalGame for the field we just updated; existing for others.
  const w1 = finalGameField === "game1" ? finalGame.winnerId : g1?.winnerId;
  const w2 = finalGameField === "game2" ? finalGame.winnerId : g2?.winnerId;
  const w3 = finalGameField === "game3" ? finalGame.winnerId : g3?.winnerId;

  const aWins =
    (w1 === session.playerAId ? 1 : 0) +
    (w2 === session.playerAId ? 1 : 0) +
    (w3 === session.playerAId ? 1 : 0);
  const bWins =
    (w1 === session.playerBId ? 1 : 0) +
    (w2 === session.playerBId ? 1 : 0) +
    (w3 === session.playerBId ? 1 : 0);

  // Bump version first; if we lose the race, don't write the Pairing.
  const updated = await updateSession(session, {
    [finalGameField]: JSON.stringify(finalGame),
    state: MatchSessionState.COMPLETE,
    completedAt: new Date(),
  } as Prisma.MatchSessionUpdateManyMutationInput);
  if (!updated) return raceLost(interaction);

  // Casual /challenge — no Pairing write, no announce. Show result + close.
  if (session.isCasual || !session.divisionId) {
    await refreshMessage(interaction, updated);
    closeMatchChannel(interaction, updated.threadId).catch(() => {});
    return;
  }

  // League match — write the Pairing for the season standings.
  // For BO2 (league default) we use the standard 2-game tally. For BO1 a
  // single win is recorded as 2-0 (winner's perspective) so the standings
  // points math (3 pts) works; BO3 not currently supported for league but
  // would record sum of wins.
  let gamesA = aWins;
  let gamesB = bWins;
  if (session.bestOf === 1) {
    gamesA = aWins === 1 ? 2 : 0;
    gamesB = bWins === 1 ? 2 : 0;
  }

  const [canonA, canonB] = session.playerAId < session.playerBId
    ? [session.playerAId, session.playerBId]
    : [session.playerBId, session.playerAId];
  const gamesWonA = canonA === session.playerAId ? gamesA : gamesB;
  const gamesWonB = canonA === session.playerAId ? gamesB : gamesA;

  const reporter = interaction.user.id === playerA.discordId ? playerA : playerB;
  const pairing = await prisma.pairing.upsert({
    where: {
      divisionId_playerAId_playerBId: {
        divisionId: session.divisionId!,
        playerAId: canonA,
        playerBId: canonB,
      },
    },
    create: {
      divisionId: session.divisionId!,
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
  // Lock the match channel + fire the auto-announce. Both are best-effort
  // and don't block the user-facing message update.
  closeMatchChannel(interaction, updated.threadId).catch(() => {});
  announceResult(pairing.id).catch(() => {});
}

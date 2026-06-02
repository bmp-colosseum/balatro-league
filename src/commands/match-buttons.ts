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
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { MatchSessionState, Prisma, type MatchSession } from "@prisma/client";
import { enqueueAnnounceResult } from "../queue.js";
import { SYSTEM_ACTOR, recordAudit } from "../audit.js";
import { isCanonicalDeck } from "../balatro-info.js";
import { resolveChallengesChannelId } from "../challenges-channel.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { getLeagueSettings, getLeagueSettingsForSeason } from "../league-settings.js";
import { logDiscordError } from "../log-discord-error.js";
import { CASUAL_PRESET_NAME, DEFAULT_PRESET_NAME, generatePool, presetForDivision, seedCasualPresetIfEmpty, seedDefaultPresetIfEmpty } from "../match-config.js";
import { renderMatch } from "../match-render.js";
import { recomputeDivisionStandings } from "../standings-cache.js";
import {
  emptyGameState,
  parsePolicy,
  phaseFor,
  remainingCombos,
  type GameState,
} from "../match-session.js";
import type { ButtonHandler, SelectMenuHandler } from "./types.js";

function parseGame(json: string | null): GameState | null {
  if (!json) return null;
  try { return JSON.parse(json) as GameState; } catch { return null; }
}

// Decode the session.customCombo JSON. Returns null on parse failure or
// missing fields so callers can treat it like "no custom combo set."
function parseCustomCombo(json: string | null): { deck: string; stake: string } | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (v && typeof v.deck === "string" && typeof v.stake === "string") {
      return { deck: v.deck, stake: v.stake };
    }
    return null;
  } catch {
    return null;
  }
}

async function loadSession(id: string) {
  return prisma.matchSession.findUnique({ where: { id } });
}

// In-flight customCombo negotiation: one player proposes a deck+stake,
// the other can accept / counter / cancel. Stored as JSON on
// session.customComboProposal. Cleared once accepted (moves into
// session.customCombo) or cancelled.
type ProposalStatus = "building" | "pending";
interface ComboProposal {
  by: string;          // player id of the proposer
  deck?: string;       // canonical deck name
  stake?: string;      // must be in preset.stakes for this match
  status: ProposalStatus;
}

function parseProposal(json: string | null): ComboProposal | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (
      v &&
      typeof v.by === "string" &&
      (v.status === "building" || v.status === "pending")
    ) {
      const out: ComboProposal = { by: v.by, status: v.status };
      if (typeof v.deck === "string") out.deck = v.deck;
      if (typeof v.stake === "string") out.stake = v.stake;
      return out;
    }
    return null;
  } catch {
    return null;
  }
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

// Resolve the stake list this match can use for a custom-combo proposal.
// The preset for the season (or Default for casual) defines the allowed
// stakes — proposer can only pick from those, even though decks are open
// to the full canonical library.
async function loadAllowedStakes(session: MatchSession): Promise<string[]> {
  const preset = session.divisionId
    ? await presetForDivision(session.divisionId)
    : await prisma.matchConfigPreset.findUnique({ where: { name: CASUAL_PRESET_NAME } });
  return preset?.stakes ?? [];
}

async function refreshMessage(interaction: AnyInteraction, session: MatchSession) {
  const { playerA, playerB } = await loadPlayers(session);
  // Allowed stakes feed the combo-proposal UI in ANY BAN phase (proposals
  // can happen per-game now). Cheap to always fetch.
  const isBanPhase = session.state === "GAME_1_BAN" || session.state === "GAME_2_BAN" || session.state === "GAME_3_BAN";
  const allowedStakes = isBanPhase ? await loadAllowedStakes(session) : [];
  const { embeds, components } = renderMatch(session, playerA, playerB, { allowedStakes });
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
      await reply(interaction, "This button looks broken — refresh Discord, or ask an admin if it keeps happening.");
      return;
    }

    const session = await loadSession(sessionId);
    if (!session) {
      await reply(interaction, "This match isn't active anymore — it may have timed out or been cancelled.");
      return;
    }

    if (action === "accept") return handleAccept(interaction, session);
    if (action === "decline") return handleDecline(interaction, session);
    if (action === "choosefirst") return handleChooseFirst(interaction, session, parts[3]);
    if (action === "banconfirm") return handleBanConfirm(interaction, session);
    if (action === "reroll") return handleReroll(interaction, session);
    if (action === "pick") return handlePick(interaction, session, parts[3]);
    if (action === "winner") return handleWinner(interaction, session, parts[3]);
    // Combo negotiation buttons. propose-start enters the proposal flow;
    // propose-submit/accept/counter/cancel manage state inside it.
    if (action === "proposestart") return handleProposeStart(interaction, session);
    if (action === "proposesubmit") return handleProposeSubmit(interaction, session);
    if (action === "proposeaccept") return handleProposeAccept(interaction, session);
    if (action === "proposecounter") return handleProposeCounter(interaction, session);
    if (action === "proposecancel") return handleProposeCancel(interaction, session);
    // Mutual-consent match cancel during the ban phase. Same shape as
    // reroll: first click votes, second click confirms.
    if (action === "cancelmatch") return handleCancelMatch(interaction, session);

    await reply(interaction, "That button didn't match anything we recognize — refresh Discord and try again.");
  },
};

// All match-related select menus share the 'match:' prefix; the second
// segment of the custom id identifies the sub-action:
//   match:banselect:<id>     — pending bans for the ban phase
//   match:proposedeck:<id>   — proposer picks a deck for the custom combo
//   match:proposestake:<id>  — proposer picks a stake for the custom combo
export const matchSelectMenus: SelectMenuHandler = {
  prefix: "match:",
  async execute(interaction) {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const sessionId = parts[2];
    if (!sessionId) {
      await reply(interaction, "Something went wrong with that selection — try again, or ask an admin.");
      return;
    }
    const session = await loadSession(sessionId);
    if (!session) {
      await reply(interaction, "This match isn't active anymore — it may have timed out or been cancelled.");
      return;
    }
    if (action === "banselect") return handleBanSelect(interaction, session);
    if (action === "proposedeck") return handleProposeDeck(interaction, session);
    if (action === "proposestake") return handleProposeStake(interaction, session);
    await reply(interaction, "Unknown selection — refresh Discord and try again.");
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
  const phase = phaseFor(game, session.playerAId, session.playerBId, parsePolicy(session.policy));
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

// Both players consent → regenerate this game's pool. Excludes deck
// NAMES seen in prior games for variety (same rule generatePool uses
// at game start). Clears bans, pendingBans, and reroll votes so the
// ban phase starts over with a fresh shuffle.
async function handleReroll(interaction: ButtonInteraction, session: MatchSession) {
  const gameNum =
    session.state === "GAME_1_BAN" ? 1 :
    session.state === "GAME_2_BAN" ? 2 :
    session.state === "GAME_3_BAN" ? 3 : 0;
  if (gameNum === 0) {
    return reply(interaction, "Reroll only available during the ban phase.");
  }
  const { playerA, playerB } = await loadPlayers(session);
  if (interaction.user.id !== playerA.discordId && interaction.user.id !== playerB.discordId) {
    return reply(interaction, "Only the two players in this match can vote to reroll.");
  }
  const gameField: "game1" | "game2" | "game3" = `game${gameNum}` as const;
  const game = parseGame(session[gameField]);
  if (!game) return reply(interaction, "Game state missing.");

  const voterIsA = interaction.user.id === playerA.discordId;
  const newVotes: GameState = {
    ...game,
    rerollVoteByA: voterIsA ? true : game.rerollVoteByA,
    rerollVoteByB: !voterIsA ? true : game.rerollVoteByB,
  };

  // Only one vote so far → save and wait.
  if (!newVotes.rerollVoteByA || !newVotes.rerollVoteByB) {
    const updated = await updateSession(session, {
      [gameField]: JSON.stringify(newVotes),
    } as Prisma.MatchSessionUpdateManyMutationInput);
    if (!updated) return raceLost(interaction);
    return refreshMessage(interaction, updated);
  }

  // Both agreed → regenerate the pool.
  const preset = session.divisionId
    ? await presetForDivision(session.divisionId)
    : await prisma.matchConfigPreset.findUnique({ where: { name: CASUAL_PRESET_NAME } });
  if (!preset || preset.decks.length === 0 || preset.stakes.length === 0) {
    return reply(interaction, "The deck pool isn't set up for this match — ask an admin to configure decks/stakes.");
  }
  const priorDecks = new Set<string>();
  const g1 = parseGame(session.game1);
  if (g1?.pool && gameNum !== 1) g1.pool.forEach((e) => priorDecks.add(e.deck));
  if (gameNum === 3) {
    const g2 = parseGame(session.game2);
    if (g2?.pool) g2.pool.forEach((e) => priorDecks.add(e.deck));
  }
  // Use the session's stamped pool size so a reroll honors whatever
  // policy was locked in at accept time, not the current admin config.
  const policy = parsePolicy(session.policy);
  const newPool = generatePool(preset.decks, preset.stakes, policy.poolSize, undefined, [...priorDecks]);
  const rerolledGame: GameState = {
    firstId: game.firstId,
    bans: [],
    pool: newPool,
  };
  const updated = await updateSession(session, {
    [gameField]: JSON.stringify(rerolledGame),
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
  const newPhase = phaseFor(newGame, session.playerAId, session.playerBId, parsePolicy(session.policy));
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

// Close the match thread when the match completes: setLocked (no new
// messages from members), then setArchived (collapsed in sidebar).
// Discord then garbage-collects archived+inactive threads automatically.
// Stamps MatchSession.threadArchivedAt on success so the
// archive.stale-threads cron skips this row. Best-effort — failures
// leave threadArchivedAt null so the cron picks it up later.
async function closeMatchChannel(
  interaction: AnyInteraction,
  sessionId: string,
  channelId: string | null,
): Promise<void> {
  if (!channelId) return;
  let ok = false;
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel) {
      console.warn(`[closeMatchChannel] channel ${channelId} not found for session ${sessionId}`);
      return;
    }
    if (channel.type === ChannelType.PrivateThread || channel.type === ChannelType.PublicThread) {
      const thread = channel as ThreadChannel;
      await thread.setLocked(true, "Match complete").catch((err) =>
        logDiscordError("closeMatchChannel.setLocked", err, { threadId: channelId, sessionId }),
      );
      await thread.setArchived(true, "Match complete").catch((err) =>
        logDiscordError("closeMatchChannel.setArchived", err, { threadId: channelId, sessionId }),
      );
      ok = true;
    } else if (channel.type === ChannelType.GuildText) {
      // Legacy: pre-revert per-match text channels. Lock @everyone + each
      // user overwrite so the channel becomes read-only. Admin can delete
      // these by hand whenever.
      const text = channel as TextChannel;
      const guildId = text.guild.id;
      await text.permissionOverwrites.edit(guildId, { SendMessages: false }).catch((err) =>
        logDiscordError("closeMatchChannel.lockEveryone", err, { channelId, guildId, sessionId }),
      );
      for (const ow of text.permissionOverwrites.cache.values()) {
        if (ow.type === 1) {
          await text.permissionOverwrites
            .edit(ow.id, { ViewChannel: true, SendMessages: false })
            .catch((err) => logDiscordError("closeMatchChannel.lockMember", err, { channelId, userId: ow.id, sessionId }));
        }
      }
      ok = true;
    }
    void PermissionFlagsBits;
  } catch (err) {
    logDiscordError("closeMatchChannel.fetch", err, { channelId, sessionId });
  }
  if (ok) {
    await prisma.matchSession
      .update({ where: { id: sessionId }, data: { threadArchivedAt: new Date() } })
      .catch(() => {});
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

  // Custom-combo path: skip the ban/pick flow entirely. game1 starts
  // with the pre-agreed combo as a 1-item pool with pickedDeckIdx=0,
  // so phaseFor immediately reads PLAYING.
  const customCombo = session.customCombo ? parseCustomCombo(session.customCombo) : null;

  // League /start-match → division's preset (falls back to Default).
  // Casual /challenge → dedicated 'Casual' preset, independent of any
  // season config. Both auto-seed from stock Balatro decks/stakes if
  // they don't exist yet, so admin doesn't have to set them up before
  // the first match.
  if (session.divisionId) {
    await seedDefaultPresetIfEmpty().catch((err) =>
      console.warn("[handleAccept] seedDefaultPresetIfEmpty failed:", err),
    );
  } else {
    await seedCasualPresetIfEmpty().catch((err) =>
      console.warn("[handleAccept] seedCasualPresetIfEmpty failed:", err),
    );
  }
  const preset = session.divisionId
    ? await presetForDivision(session.divisionId)
    : await prisma.matchConfigPreset.findUnique({ where: { name: CASUAL_PRESET_NAME } });
  if (!preset || preset.decks.length === 0 || preset.stakes.length === 0) {
    const which = session.divisionId ? "this season's preset" : `the '${CASUAL_PRESET_NAME}' preset for casual challenges`;
    return reply(interaction, `The deck pool isn't set up — ask an admin to configure decks/stakes for ${which} before accepting.`);
  }
  // Read the current league settings once and stamp the resulting
  // policy onto the session — that snapshot stays valid for this
  // match's full lifetime even if an admin changes the config later.
  // League matches use the season's template; casual /challenge has
  // no season context so it reads the global default.
  const settings = session.divisionId
    ? await getLeagueSettingsForSeason((await prisma.division.findUnique({ where: { id: session.divisionId }, select: { seasonId: true } }))!.seasonId)
    : await getLeagueSettings();
  // For custom-combo, pool is the single agreed combo; bans don't apply
  // but we keep the policy stamp consistent so legacy callers don't break.
  const game1Pool = customCombo
    ? [customCombo]
    : generatePool(preset.decks, preset.stakes, settings.matchPolicy.poolSize);
  const policySnapshot = {
    firstPlayerBans: settings.matchPolicy.firstPlayerBans,
    secondPlayerBans: settings.matchPolicy.secondPlayerBans,
    poolSize: game1Pool.length,
  };

  const { playerA } = await loadPlayers(session);
  const firstId = Math.random() < 0.5 ? playerA.id : playerB.id;

  // Create a Private Thread inside the channel where /start-match was
  // run. Private Threads are members-only (only people we explicitly
  // add can see), no channel-creation rate limit applies, and Discord
  // auto-archives them after inactivity. Cheaper + simpler than a full
  // text channel under a '🎴 Matches' category.
  //
  // Staff is NOT auto-added — players + bot only. Admins opt in via
  // /admin join-match when mediation is needed.
  let matchChannelId = session.threadId;
  if (!matchChannelId) {
    // Casual /challenge threads live under the dedicated #challenges
    // channel (in the '🎴 Matches' category) when one is configured,
    // so all casual matches sit together regardless of where the
    // invite was posted. League /start-match threads stay under the
    // division channel so division members can browse the thread list.
    let parentChannel = interaction.channel?.type === ChannelType.GuildText
      ? (interaction.channel as TextChannel)
      : null;
    if (session.isCasual) {
      const challengesId = await resolveChallengesChannelId();
      if (challengesId) {
        try {
          const fetched = await interaction.client.channels.fetch(challengesId);
          if (fetched && fetched.type === ChannelType.GuildText) {
            parentChannel = fetched as TextChannel;
          }
        } catch {
          // fall through to interaction.channel
        }
      }
    }
    if (parentChannel) {
      try {
        const suffix = session.id.slice(-6);
        const thread = await parentChannel.threads.create({
          name: `Match · ${playerA.displayName} vs ${playerB.displayName} · ${suffix}`,
          type: ChannelType.PrivateThread,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          invitable: false,
        });
        await thread.members.add(playerA.discordId).catch(() => {});
        await thread.members.add(playerB.discordId).catch(() => {});
        matchChannelId = thread.id;
      } catch (err) {
        console.warn("[match] failed to create private thread:", err);
      }
    }
  }

  // Custom-combo skips ban/pick: game1 is initialized with pickedDeckIdx=0
  // and state goes straight to GAME_1_PLAYING. Normal path goes through
  // the usual GAME_1_BAN entry point.
  const game1State: GameState = customCombo
    ? { firstId, bans: [], pool: game1Pool, pickedDeckIdx: 0 }
    : emptyGameState(firstId, game1Pool);
  const initialState = customCombo
    ? MatchSessionState.GAME_1_PLAYING
    : MatchSessionState.GAME_1_BAN;
  const updated = await updateSession(session, {
    state: initialState,
    acceptedAt: new Date(),
    pool: JSON.stringify(game1Pool),
    policy: JSON.stringify(policySnapshot),
    game1: JSON.stringify(game1State),
    threadId: matchChannelId,
  });
  if (!updated) return raceLost(interaction);
  recordAudit({
    actor: SYSTEM_ACTOR,
    action: "match.start",
    targetType: "MatchSession",
    targetId: updated.id,
    summary: `Match started: ${playerA.displayName} vs ${playerB.displayName}${session.isCasual ? " (casual)" : session.isShootout ? " (shootout)" : ""}`,
    metadata: {
      isCasual: session.isCasual,
      isShootout: session.isShootout,
      bestOf: session.bestOf,
      customCombo: customCombo,
      divisionId: session.divisionId,
      playerAId: session.playerAId,
      playerBId: session.playerBId,
    },
  });

  await refreshMessage(interaction, updated);

  if (matchChannelId && matchChannelId !== session.threadId) {
    try {
      const thread = await interaction.client.channels.fetch(matchChannelId);
      if (thread && thread.type === ChannelType.PrivateThread) {
        const { embeds, components } = renderMatch(updated, playerA, playerB);
        await thread.send({
          content: `<@${playerA.discordId}> <@${playerB.discordId}> — your match thread. Bans/picks below.`,
          embeds,
          components,
        });
      }
    } catch (err) {
      console.warn(`[match] failed to post into match thread ${matchChannelId}:`, err);
    }
  }
  // Hush unused-env warning until something in here actually reads env.
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
  if (!firstIdRaw) return reply(interaction, "This button looks broken — refresh Discord and try again.");

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
    : await prisma.matchConfigPreset.findUnique({ where: { name: CASUAL_PRESET_NAME } });
  if (!preset || preset.decks.length === 0 || preset.stakes.length === 0) {
    return reply(interaction, "The deck pool isn't set up for this match — ask an admin to configure decks/stakes.");
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
  // Game 2/3 reuse the session's stamped pool size — same policy across
  // every game of the match, even if admin tweaks config mid-series.
  const freshPool = generatePool(
    preset.decks,
    preset.stakes,
    parsePolicy(session.policy).poolSize,
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
  if (!idxRaw) return reply(interaction, "This button looks broken — refresh Discord and try again.");
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

  const phase = phaseFor(game, session.playerAId, session.playerBId, parsePolicy(session.policy));
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
  if (!winnerIdRaw) return reply(interaction, "This button looks broken — refresh Discord and try again.");
  if (winnerIdRaw !== session.playerAId && winnerIdRaw !== session.playerBId) {
    return reply(interaction, "Invalid winner.");
  }
  const { playerA, playerB } = await loadPlayers(session);
  if (interaction.user.id !== playerA.discordId && interaction.user.id !== playerB.discordId) {
    return reply(interaction, "Only the two players in this match can vote on the winner.");
  }

  const isGame1 = session.state === "GAME_1_PLAYING";
  const isGame2 = session.state === "GAME_2_PLAYING";
  const isGame3 = session.state === "GAME_3_PLAYING";
  if (!isGame1 && !isGame2 && !isGame3) return reply(interaction, "Not waiting for a winner.");

  const gameField: "game1" | "game2" | "game3" = isGame1 ? "game1" : isGame2 ? "game2" : "game3";
  const gameJson = session[gameField];
  const game = parseGame(gameJson);
  if (!game) return reply(interaction, "Game state missing.");

  // Record the voter's pick. Either player can change their mind by
  // clicking the other button before both votes are in. Disputed games
  // also accept re-votes so players can talk it out and re-cast — voting
  // again clears the disputed flag and re-checks agreement.
  const voterIsA = interaction.user.id === playerA.discordId;
  const newGame: GameState = {
    ...game,
    voteByA: voterIsA ? winnerIdRaw : game.voteByA,
    voteByB: !voterIsA ? winnerIdRaw : game.voteByB,
    disputed: false, // re-check below
  };

  // Both votes in?
  if (!newGame.voteByA || !newGame.voteByB) {
    const updated = await updateSession(session, {
      [gameField]: JSON.stringify(newGame),
    } as Prisma.MatchSessionUpdateManyMutationInput);
    if (!updated) return raceLost(interaction);
    return refreshMessage(interaction, updated);
  }

  // Disagreement → dispute. Match stays in PLAYING state; admin uses
  // /admin override-result, OR players talk and re-vote (revoting clears
  // the disputed flag at the top of this handler).
  if (newGame.voteByA !== newGame.voteByB) {
    newGame.disputed = true;
    const updated = await updateSession(session, {
      [gameField]: JSON.stringify(newGame),
    } as Prisma.MatchSessionUpdateManyMutationInput);
    if (!updated) return raceLost(interaction);
    return refreshMessage(interaction, updated);
  }

  // Both voted the same way → that's the winner. Continue with existing
  // game-advance / finalize logic.
  newGame.winnerId = newGame.voteByA;

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

  // Custom-combo mode skips the inter-game "choose who bans first" step
  // entirely — each subsequent game uses the same agreed combo and goes
  // straight to PLAYING. The ChooseFirst handler isn't reachable.
  const customCombo = session.customCombo ? parseCustomCombo(session.customCombo) : null;

  if (isGame1) {
    // BO1: end immediately. BO2 / BO3: go to game 2.
    if (session.bestOf === 1) {
      return finalizeMatch(interaction, session, newGame, "game1");
    }
    if (customCombo) {
      // Skip CHOOSE_FIRST — start game 2 immediately with the same combo.
      // FirstId alternates from game 1 for fairness (the player who didn't
      // ban first in g1 plays first in g2; meaningless in custom mode but
      // keeps the same code path for renderer assumptions).
      const nextFirst = newGame.firstId === session.playerAId ? session.playerBId : session.playerAId;
      const game2State: GameState = { firstId: nextFirst, bans: [], pool: [customCombo], pickedDeckIdx: 0 };
      const updated = await updateSession(session, {
        game1: JSON.stringify(newGame),
        game2: JSON.stringify(game2State),
        state: MatchSessionState.GAME_2_PLAYING,
      });
      if (!updated) return raceLost(interaction);
      return refreshMessage(interaction, updated);
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
        if (customCombo) {
          // Skip CHOOSE_FIRST for game 3 in custom-combo mode.
          const nextFirst = newGame.firstId === session.playerAId ? session.playerBId : session.playerAId;
          const game3State: GameState = { firstId: nextFirst, bans: [], pool: [customCombo], pickedDeckIdx: 0 };
          const updated = await updateSession(session, {
            game2: JSON.stringify(newGame),
            game3: JSON.stringify(game3State),
            state: MatchSessionState.GAME_3_PLAYING,
          });
          if (!updated) return raceLost(interaction);
          return refreshMessage(interaction, updated);
        }
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
  // Record completion in the audit log so we have an event per match —
  // useful for "what happened today" admin views even when the result
  // didn't go through a Pairing (casual / shootout).
  recordAudit({
    actor: SYSTEM_ACTOR,
    action: "match.complete",
    targetType: "MatchSession",
    targetId: updated.id,
    summary: `${playerA.displayName} ${aWins}-${bWins} ${playerB.displayName}${session.isCasual ? " (casual)" : session.isShootout ? " (shootout)" : ""}`,
    metadata: {
      isCasual: session.isCasual,
      isShootout: session.isShootout,
      bestOf: session.bestOf,
      gamesWonA: aWins,
      gamesWonB: bWins,
      divisionId: session.divisionId,
      playerAId: session.playerAId,
      playerBId: session.playerBId,
    },
  });

  // Casual /challenge — no Pairing write, no announce. Show result + close.
  if (session.isCasual || !session.divisionId) {
    await refreshMessage(interaction, updated);
    closeMatchChannel(interaction, updated.id, updated.threadId).catch(() => {});
    return;
  }

  // Shootout — write a Shootout row instead of a Pairing. Game 1's
  // winner IS the shootout winner (it's BO1). Standings sort picks up
  // the new shootout via the cache recompute below.
  if (session.isShootout) {
    const winnerId = aWins > bWins ? session.playerAId : session.playerBId;
    const [canonA, canonB] = session.playerAId < session.playerBId
      ? [session.playerAId, session.playerBId]
      : [session.playerBId, session.playerAId];
    await prisma.shootout.upsert({
      where: {
        divisionId_playerAId_playerBId: { divisionId: session.divisionId, playerAId: canonA, playerBId: canonB },
      },
      create: {
        divisionId: session.divisionId,
        playerAId: canonA,
        playerBId: canonB,
        winnerId,
        recordedBy: interaction.user.id,
      },
      update: { winnerId, recordedBy: interaction.user.id },
    });
    await refreshMessage(interaction, updated);
    closeMatchChannel(interaction, updated.id, updated.threadId).catch(() => {});
    recomputeDivisionStandings(session.divisionId).catch(() => {});
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
  closeMatchChannel(interaction, updated.id, updated.threadId).catch(() => {});
  enqueueAnnounceResult(pairing.id).catch(() => {});
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
}

// === Custom-combo negotiation handlers ===
// The proposal flow lives inside GAME_1_BAN — once game 1 starts the
// custom combo is locked in for the whole match (every game uses it),
// so re-negotiating mid-match doesn't make sense. handleProposeAccept
// is what moves the agreed proposal into session.customCombo and jumps
// past the ban/pick flow entirely.

// Map state → 1/2/3 game number, or 0 if not in a ban phase.
// Centralized so propose-* handlers can target the CURRENT game's
// fields (game1/game2/game3) instead of always game1.
function banPhaseGameNum(state: MatchSessionState): 1 | 2 | 3 | 0 {
  if (state === MatchSessionState.GAME_1_BAN) return 1;
  if (state === MatchSessionState.GAME_2_BAN) return 2;
  if (state === MatchSessionState.GAME_3_BAN) return 3;
  return 0;
}

// Resolve which of the two players the actor is, replying with an
// ephemeral error if they aren't one of them. Returns null on miss.
async function actorPlayer(interaction: AnyInteraction, session: MatchSession) {
  const { playerA, playerB } = await loadPlayers(session);
  if (interaction.user.id === playerA.discordId) return { actor: playerA, other: playerB };
  if (interaction.user.id === playerB.discordId) return { actor: playerB, other: playerA };
  await reply(interaction, "Only the two players in this match can use these buttons.");
  return null;
}

async function handleProposeStart(interaction: ButtonInteraction, session: MatchSession) {
  if (banPhaseGameNum(session.state) === 0) {
    return reply(interaction, "You can only propose a custom combo during a ban phase.");
  }
  const ctx = await actorPlayer(interaction, session);
  if (!ctx) return;
  if (session.customComboProposal) {
    return reply(interaction, "There's already a proposal in flight — finish or cancel it first.");
  }
  const proposal: ComboProposal = { by: ctx.actor.id, status: "building" };
  const updated = await updateSession(session, { customComboProposal: JSON.stringify(proposal) });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

async function handleProposeDeck(interaction: StringSelectMenuInteraction, session: MatchSession) {
  if (banPhaseGameNum(session.state) === 0) return reply(interaction, "Not in a ban phase.");
  const proposal = parseProposal(session.customComboProposal);
  if (!proposal || proposal.status !== "building") {
    return reply(interaction, "No proposal is being built right now.");
  }
  const ctx = await actorPlayer(interaction, session);
  if (!ctx) return;
  if (proposal.by !== ctx.actor.id) {
    return reply(interaction, "Only the proposer can pick the deck. Counter the proposal to take over.");
  }
  const deck = interaction.values[0];
  if (!deck || !isCanonicalDeck(deck)) {
    return reply(interaction, "That deck isn't in our registry — pick a known deck.");
  }
  const updated = await updateSession(session, {
    customComboProposal: JSON.stringify({ ...proposal, deck }),
  });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

async function handleProposeStake(interaction: StringSelectMenuInteraction, session: MatchSession) {
  if (banPhaseGameNum(session.state) === 0) return reply(interaction, "Not in a ban phase.");
  const proposal = parseProposal(session.customComboProposal);
  if (!proposal || proposal.status !== "building") {
    return reply(interaction, "No proposal is being built right now.");
  }
  const ctx = await actorPlayer(interaction, session);
  if (!ctx) return;
  if (proposal.by !== ctx.actor.id) {
    return reply(interaction, "Only the proposer can pick the stake. Counter the proposal to take over.");
  }
  const stake = interaction.values[0];
  const allowedStakes = await loadAllowedStakes(session);
  if (!stake || !allowedStakes.includes(stake)) {
    return reply(interaction, "That stake isn't in this season's preset — pick one from the menu.");
  }
  const updated = await updateSession(session, {
    customComboProposal: JSON.stringify({ ...proposal, stake }),
  });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

async function handleProposeSubmit(interaction: ButtonInteraction, session: MatchSession) {
  if (banPhaseGameNum(session.state) === 0) return reply(interaction, "Not in a ban phase.");
  const proposal = parseProposal(session.customComboProposal);
  if (!proposal || proposal.status !== "building") {
    return reply(interaction, "No proposal to submit.");
  }
  const ctx = await actorPlayer(interaction, session);
  if (!ctx) return;
  if (proposal.by !== ctx.actor.id) {
    return reply(interaction, "Only the proposer can submit this proposal.");
  }
  if (!proposal.deck || !proposal.stake) {
    return reply(interaction, "Pick a deck and a stake first.");
  }
  const updated = await updateSession(session, {
    customComboProposal: JSON.stringify({ ...proposal, status: "pending" }),
  });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

async function handleProposeCounter(interaction: ButtonInteraction, session: MatchSession) {
  if (banPhaseGameNum(session.state) === 0) return reply(interaction, "Not in a ban phase.");
  const proposal = parseProposal(session.customComboProposal);
  if (!proposal || proposal.status !== "pending") {
    return reply(interaction, "No pending proposal to counter.");
  }
  const ctx = await actorPlayer(interaction, session);
  if (!ctx) return;
  if (proposal.by === ctx.actor.id) {
    return reply(interaction, "You're the proposer — wait for your opponent's response.");
  }
  // Flip ownership to the actor, drop their picks, drop back to building.
  const next: ComboProposal = { by: ctx.actor.id, status: "building" };
  const updated = await updateSession(session, { customComboProposal: JSON.stringify(next) });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

async function handleProposeCancel(interaction: ButtonInteraction, session: MatchSession) {
  if (banPhaseGameNum(session.state) === 0) return reply(interaction, "Not in a ban phase.");
  if (!session.customComboProposal) {
    return reply(interaction, "No proposal to cancel.");
  }
  const ctx = await actorPlayer(interaction, session);
  if (!ctx) return;
  const updated = await updateSession(session, { customComboProposal: null });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

// Mutual-consent cancel during the BAN phases. First click stores the
// voter's vote in the current game's GameState; second click (from the
// OTHER player) flips state to CANCELLED. Either player can withdraw
// their vote by clicking again with the proposal still single-sided.
async function handleCancelMatch(interaction: ButtonInteraction, session: MatchSession) {
  const gameNum =
    session.state === "GAME_1_BAN" ? 1 :
    session.state === "GAME_2_BAN" ? 2 :
    session.state === "GAME_3_BAN" ? 3 : 0;
  if (gameNum === 0) {
    return reply(interaction, "Cancel is only available during the ban phase.");
  }
  const ctx = await actorPlayer(interaction, session);
  if (!ctx) return;
  const gameField: "game1" | "game2" | "game3" = `game${gameNum}` as const;
  const game = parseGame(session[gameField]);
  if (!game) return reply(interaction, "Game state missing.");

  const voterIsA = ctx.actor.id === session.playerAId;
  const newGame: GameState = {
    ...game,
    cancelVoteByA: voterIsA ? true : game.cancelVoteByA,
    cancelVoteByB: !voterIsA ? true : game.cancelVoteByB,
  };

  // Only one vote so far → save and wait for the other player.
  if (!newGame.cancelVoteByA || !newGame.cancelVoteByB) {
    const updated = await updateSession(session, {
      [gameField]: JSON.stringify(newGame),
    } as Prisma.MatchSessionUpdateManyMutationInput);
    if (!updated) return raceLost(interaction);
    return refreshMessage(interaction, updated);
  }

  // Both agreed → cancel the match. Lock the thread so it doesn't keep
  // pinging people, then refresh the embed so the cancelled-state
  // render replaces the buttons.
  const updated = await updateSession(session, {
    [gameField]: JSON.stringify(newGame),
    state: MatchSessionState.CANCELLED,
  } as Prisma.MatchSessionUpdateManyMutationInput);
  if (!updated) return raceLost(interaction);
  recordAudit({
    actor: SYSTEM_ACTOR,
    action: "match.cancel-player",
    targetType: "MatchSession",
    targetId: updated.id,
    summary: `Both players agreed to cancel match ${updated.id.slice(-6)}`,
    metadata: {
      previousState: session.state,
      playerAId: session.playerAId,
      playerBId: session.playerBId,
    },
  });
  await refreshMessage(interaction, updated);
  closeMatchChannel(interaction, updated.id, updated.threadId).catch(() => {});
}

// Accept = the OTHER player agrees to the proposed combo. Replaces the
// CURRENT game's pool with the single agreed combo (pickedDeckIdx=0)
// and jumps the session to that game's PLAYING state. The combo
// applies to THIS game only — next game starts fresh in BAN, so
// players can mix ban/pick with custom combos across the match.
async function handleProposeAccept(interaction: ButtonInteraction, session: MatchSession) {
  const gameNum = banPhaseGameNum(session.state);
  if (gameNum === 0) return reply(interaction, "Not in a ban phase.");
  const proposal = parseProposal(session.customComboProposal);
  if (!proposal || proposal.status !== "pending") {
    return reply(interaction, "No pending proposal to accept.");
  }
  const ctx = await actorPlayer(interaction, session);
  if (!ctx) return;
  if (proposal.by === ctx.actor.id) {
    return reply(interaction, "You proposed this — the other player has to accept.");
  }
  if (!proposal.deck || !proposal.stake) {
    return reply(interaction, "Proposal is incomplete — ask them to re-submit.");
  }
  // Re-validate at accept time so a stale proposal (e.g. preset changed
  // since the proposal was built) still bounces.
  const allowedStakes = await loadAllowedStakes(session);
  if (!isCanonicalDeck(proposal.deck) || !allowedStakes.includes(proposal.stake)) {
    return reply(interaction, "That combo is no longer valid — start a new proposal.");
  }
  const gameField: "game1" | "game2" | "game3" = `game${gameNum}` as const;
  const currentGame = parseGame(session[gameField]);
  if (!currentGame) return reply(interaction, `Game ${gameNum} state missing — refresh Discord and try again.`);
  const combo = { deck: proposal.deck, stake: proposal.stake };
  const newGame: GameState = { firstId: currentGame.firstId, bans: [], pool: [combo], pickedDeckIdx: 0 };
  const playingState =
    gameNum === 1 ? MatchSessionState.GAME_1_PLAYING :
    gameNum === 2 ? MatchSessionState.GAME_2_PLAYING :
    MatchSessionState.GAME_3_PLAYING;
  const updated = await updateSession(session, {
    customComboProposal: null,
    [gameField]: JSON.stringify(newGame),
    state: playingState,
  } as Prisma.MatchSessionUpdateManyMutationInput);
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

// Button dispatcher for the match-session state machine.
// Custom IDs:
//   match:accept:{sessionId}
//   match:decline:{sessionId}
//   match:choosefirst:{sessionId}:{playerId}
//   match:ban:{sessionId}:{poolIdx}
//   match:pick:{sessionId}:{poolIdx}
//   match:winner:{sessionId}:{playerId}

import {
  ActionRowBuilder,
  ButtonBuilder,
  ChannelType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Client,
  type GuildTextBasedChannel,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { MatchSessionState, Prisma, type MatchSession } from "@prisma/client";
import { enqueueAnnounceResult } from "../queue.js";
import { announceChallengeResult } from "../announce.js";
import { SYSTEM_ACTOR, recordAudit, actorFromInteractionUser } from "../audit.js";
import { isCanonicalDeck } from "../balatro-info.js";
import { resolveChallengesChannelId } from "../challenges-channel.js";
import { ensureLeagueMatchesChannel } from "../league-matches-channel.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { getLeagueSettings, getLeagueSettingsForSeason } from "../league-settings.js";
import { logDiscordError } from "../log-discord-error.js";
import { bootstrapPresetsAndPointers, generatePool, presetForCasualMatch, presetForCustomCombo, presetForDivision, type DeckEntry } from "../match-config.js";
import { renderComboBuilder, renderMatch } from "../match-render.js";
import { summonHelpers } from "./helper.js";
import { recomputeDivisionStandings } from "../standings-cache.js";
import { writeMatchGames } from "../match-write.js";
import { bannedPlayerIds, BANNED_MESSAGE } from "../bans.js";
import { hasTier } from "../permissions.js";
import { backfillMatchId, postModerationNotice } from "../mod-log.js";
import { postTranscriptSummary } from "../transcript-channel.js";
import { sanitizeName } from "../sanitize.js";
import {
  emptyGameState,
  parseGame,
  parseProposal,
  parsePolicy,
  phaseFor,
  remainingCombos,
  MAX_GAME_LIVES,
  type GameState,
  type ComboProposal,
} from "../match-session.js";
import type { ButtonHandler, SelectMenuHandler } from "./types.js";

async function loadSession(id: string) {
  return prisma.matchSession.findUnique({ where: { id } });
}

// How long after a helper call before the Call helper button works again.
// Stops accidental double-pings without permanently locking the button.
const HELPER_CALL_COOLDOWN_MS = 5 * 60 * 1000;

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

// Resolve the stake list a custom-combo PROPOSAL can offer. Both league
// (start-match) AND casual (/challenge) use the dedicated custom-combo preset —
// a custom combo only happens when BOTH players agree, so there's no
// competitive-integrity reason to lock league proposals to the white-stake
// competitive preset (and doing so left the stake menu empty, so the proposal
// couldn't be submitted at all). The custom-combo preset falls back to the
// casual preset until one is configured. Decks are open to the full canonical
// library either way; only stakes are preset-constrained.
async function loadAllowedStakes(_session: MatchSession): Promise<string[]> {
  const preset = await presetForCustomCombo();
  return preset?.stakes ?? [];
}

async function refreshMessage(interaction: AnyInteraction, session: MatchSession) {
  const { playerA, playerB } = await loadPlayers(session);
  const { embeds, components, content, turnKey } = renderMatch(session, playerA, playerB);
  const channelId = session.threadId ?? session.channelId;
  // A real turn handoff = the awaited actor (turnKey) changed since we last
  // pinged. NOTE: Discord does NOT push-notify on message EDITS, even ones
  // that add a mention — so an in-place edit silently updates the embed and
  // the next player never finds out it's their turn. We only edit in place
  // when nobody new is on the clock (same actor still up, vote tally, terminal
  // render); a genuine handoff re-POSTS the controls below so the new player
  // is actually pinged.
  const turnSwitched = !!turnKey && turnKey !== session.lastPingedDiscordId;
  if (!turnSwitched || !session.matchMessageId || !channelId) {
    await editOrUpdate(interaction, { content, embeds, components });
    return;
  }
  try {
    // The button click already carries its channel (the match thread) — use it
    // directly to skip a channels.fetch. Fall back to a fetch only if it's
    // missing or somehow not this session's channel.
    const cached =
      interaction.channelId === channelId && interaction.channel && "send" in interaction.channel
        ? interaction.channel
        : null;
    const channel = cached ?? (await interaction.client.channels.fetch(channelId).catch(() => null));
    if (!channel || !("send" in channel) || !("messages" in channel)) {
      await editOrUpdate(interaction, { content, embeds, components });
      return;
    }
    // Ack the interaction WITHOUT editing the message we're about to delete.
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    await repostControls(channel as GuildTextBasedChannel, session, { content, embeds, components }, turnKey);
  } catch (err) {
    console.warn(`[refreshMessage] re-post failed for ${session.id}, editing in place:`, err);
    try {
      await editOrUpdate(interaction, { content, embeds, components });
    } catch {
      // Interaction already acked via deferUpdate — nothing more we can do.
    }
  }
}

// Edit the source message, transparently handling whether the
// interaction was already deferred/replied (handleAccept calls
// deferUpdate up front to dodge the 3s ack window — after that you must
// editReply, not update). Non-deferring handlers hit the update() path
// unchanged.
type ComponentRow = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;
async function editOrUpdate(
  interaction: AnyInteraction,
  payload: { content?: string; embeds: EmbedBuilder[]; components: ComponentRow[] },
) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else {
    await interaction.update(payload);
  }
}

async function reply(interaction: AnyInteraction, content: string) {
  // Post-defer, a fresh ack isn't allowed — followUp adds the ephemeral
  // instead. Pre-defer (the common case) this is a plain reply.
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

// Ack a component interaction immediately (no visible message change) so
// Discord's 3-second window is met even when the handler's work runs long —
// otherwise a slow handler blows the deadline and the click fails with 10062
// "Unknown interaction". Idempotent (skips if already acked); the terminal
// editOrUpdate/reply helpers detect the deferred state and use editReply/
// followUp, so callers need no other change. Only for handlers that end via
// those helpers — NOT ones that showModal or need a fresh interaction.reply.
async function ackFast(interaction: AnyInteraction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
}

async function raceLost(interaction: AnyInteraction) {
  return reply(interaction, "Someone else just clicked first — the buttons may have changed. Try again.");
}

// Is the clicker a league ADMIN (or owner)? Used to let staff drive a match on a
// player's behalf when the normal flow is stuck. Match buttons live on the public
// thread message, so an admin can already click them — this just lets the
// server-side gates recognize them.
async function isMatchAdmin(interaction: AnyInteraction): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild) return false;
  const member =
    guild.members.cache.get(interaction.user.id) ??
    (await guild.members.fetch(interaction.user.id).catch(() => null));
  return member ? hasTier(member, interaction.user.id, "ADMIN") : false;
}

async function requireActor(interaction: AnyInteraction, expectedDiscordId: string): Promise<boolean> {
  if (interaction.user.id === expectedDiscordId) return true;
  // Admin override: a staff member can act on the current player's behalf (ban /
  // pick / choose-first) to un-stick a match. Their click applies as this turn.
  if (await isMatchAdmin(interaction)) return true;
  await reply(interaction, "It's not your turn.");
  return false;
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
      await reply(interaction, "This match is over — it may have timed out or been cancelled.");
      return;
    }

    if (action === "accept") return handleAccept(interaction, session);
    if (action === "decline") return handleDecline(interaction, session);
    if (action === "choosefirst") return handleChooseFirst(interaction, session, parts[3]);
    if (action === "banrandom") return handleBanRandom(interaction, session);
    if (action === "reroll") return handleReroll(interaction, session);
    if (action === "pick") return handlePick(interaction, session, parts[3]);
    if (action === "pickrandom") return handlePickRandom(interaction, session);
    if (action === "winner") return handleWinner(interaction, session, parts[3]);
    if (action === "lives") return handleLives(interaction, session, parts[3]);
    if (action === "dc") return handleDc(interaction, session);
    if (action === "dcconfirm") return handleDcConfirm(interaction, session);
    if (action === "dcdispute") return handleDcDispute(interaction, session);
    if (action === "callhelper") return handleCallHelper(interaction, session);
    if (action === "pause") return handlePauseVote(interaction, session);
    if (action === "resume") return handleResumeVote(interaction, session);
    // Combo negotiation buttons. propose-start enters the proposal flow;
    // propose-submit/accept/counter/cancel manage state inside it.
    if (action === "proposestart") return handleProposeStart(interaction, session);
    if (action === "proposesubmit") return handleProposeSubmit(interaction, session);
    if (action === "proposeaccept") return handleProposeAccept(interaction, session);
    if (action === "proposecounter") return handleProposeCounter(interaction, session);
    if (action === "proposecancel") return handleProposeCancel(interaction, session);
    // Mutual-consent match cancel — one button, no ephemeral menu.
    // First click votes (and pings the opponent), clicking again
    // withdraws, and the opponent's click drops the match. The two
    // clicks ARE the confirmation, so there's no separate confirm step.
    if (action === "cancelmatch") return handleCancelVote(interaction, session);

    await reply(interaction, "That button didn't do anything we recognize — refresh Discord and try again.");
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
      await reply(interaction, "Something went wrong with that pick — try again, or ask an admin.");
      return;
    }
    const session = await loadSession(sessionId);
    if (!session) {
      await reply(interaction, "This match is over — it may have timed out or been cancelled.");
      return;
    }
    if (action === "banselect") return handleBanSelect(interaction, session);
    if (action === "pickselect") return handlePick(interaction, session, interaction.values[0]);
    if (action === "proposedeck") return handleProposeDeck(interaction, session);
    if (action === "proposestake") return handleProposeStake(interaction, session);
    await reply(interaction, "We didn't recognize that pick — refresh Discord and try again.");
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
    // Most likely cause: stale button — the match has advanced past
    // the ban phase since this message was rendered. Refresh the
    // embed in place so the user sees the current state instead of
    // an ephemeral "wrong phase" error with no recovery path.
    await refreshMessage(interaction, session);
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
    // Same stale-button case as above — session state still says
    // BAN but bans have already been confirmed past the policy
    // threshold (race between two players' clicks). Re-render.
    await refreshMessage(interaction, session);
    return null;
  }
  const actor = await prisma.player.findUniqueOrThrow({ where: { id: phase.whoseBanId } });
  if (!(await requireActor(interaction, actor.discordId))) return null;
  return { gameNum: gameNum as 1 | 2 | 3, gameField, game, expected: phase.remainingForThem };
}

// Post fresh controls at the BOTTOM of the thread (pinging the awaited player)
// and delete the previous controls message. This is the shared mechanic behind
// every turn-switch notification: a NEW message is the only thing Discord
// push-notifies on, so re-posting is how the next player actually gets alerted.
// Always pings (allowedMentions.users) and stamps the new turnKey — callers
// that only want a conditional ping (the bump sweep) do their own send.
async function repostControls(
  channel: GuildTextBasedChannel,
  session: MatchSession,
  rendered: { content: string; embeds: EmbedBuilder[]; components: ComponentRow[] },
  turnKey: string,
): Promise<void> {
  const sent = await channel.send({
    content: rendered.content || undefined,
    embeds: rendered.embeds,
    components: rendered.components,
    allowedMentions: { parse: ["users"] },
  });
  const oldId = session.matchMessageId;
  await prisma.matchSession
    .update({ where: { id: session.id }, data: { matchMessageId: sent.id, lastPingedDiscordId: turnKey } })
    .catch(() => {});
  if (oldId && oldId !== sent.id) {
    // Single DELETE by id — no need to fetch the message object first.
    await channel.messages.delete(oldId).catch(() => {});
  }
}

// Re-post the match controls at the BOTTOM of the thread. Called after the
// bot itself posts another message (e.g. a helper summon) or the periodic
// sweep finds the controls buried by chatter. Posts fresh controls, repoints
// matchMessageId, then deletes the old message. Pings the awaited player ONLY
// when the turn actually switched (otherwise a plain move-to-bottom is silent).
// No-op on terminal states or when there's no channel.
async function bumpMatchControls(client: Client, session: MatchSession): Promise<void> {
  if (session.state === "COMPLETE" || session.state === "CANCELLED") return;
  const channelId = session.threadId ?? session.channelId;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !("send" in channel) || !("messages" in channel)) return;
    const { playerA, playerB } = await loadPlayers(session);
    const { embeds, components, content, turnKey } = renderMatch(session, playerA, playerB);
    // Ping ONLY when the awaited actor (turnKey) changed since we last pinged —
    // so a turn SWITCH notifies the new player, but a plain move-to-bottom
    // (same person still up) is silent.
    const shouldPing = !!turnKey && turnKey !== session.lastPingedDiscordId;
    const sent = await channel.send({
      content: content || undefined,
      embeds,
      components,
      allowedMentions: { parse: shouldPing ? ["users"] : [] },
    });
    const oldId = session.matchMessageId;
    await prisma.matchSession
      .update({
        where: { id: session.id },
        data: { matchMessageId: sent.id, ...(shouldPing ? { lastPingedDiscordId: turnKey } : {}) },
      })
      .catch(() => {});
    if (oldId) {
      // Single DELETE by id — no need to fetch the message object first.
      await channel.messages.delete(oldId).catch(() => {});
    }
  } catch (err) {
    console.warn(`[bumpMatchControls] failed for ${session.id}:`, err);
  }
}

// Cross-interaction edit of the canonical public match message. Used
// by ephemeral handlers (e.g. ban confirm) to push the updated state
// to the public embed everyone sees. No-op if matchMessageId or the
// thread channel is missing (shouldn't normally happen — start-match
// + challenge + match-thread-init all persist it).
async function refreshPublicMatchMessage(interaction: AnyInteraction, session: MatchSession) {
  if (!session.matchMessageId) return;
  const channelId = session.threadId ?? session.channelId;
  if (!channelId) return;
  try {
    // Reuse the interaction's channel when it's this session's thread, else fetch.
    const cached =
      interaction.channelId === channelId && interaction.channel && "send" in interaction.channel
        ? interaction.channel
        : null;
    const resolved = cached ?? (await interaction.client.channels.fetch(channelId).catch(() => null));
    if (!resolved || !("messages" in resolved) || !("send" in resolved)) return;
    const channel = resolved as GuildTextBasedChannel;
    const { playerA, playerB } = await loadPlayers(session);
    const { embeds, components, content, turnKey } = renderMatch(session, playerA, playerB);
    // Same turn-aware rule as refreshMessage: a real handoff re-posts (so the
    // new player is pinged), everything else edits the public message in place.
    const turnSwitched = !!turnKey && turnKey !== session.lastPingedDiscordId;
    if (turnSwitched) {
      await repostControls(channel, session, { content, embeds, components }, turnKey);
    } else {
      // Single PATCH by id — no need to fetch the message object first.
      await channel.messages.edit(session.matchMessageId, { content, embeds, components });
    }
  } catch (err) {
    console.warn(`[refreshPublicMatchMessage] failed for ${session.id}:`, err);
  }
}

// Periodic "keep the controls reachable" sweep. Turn SWITCHES already notify
// event-driven (refreshMessage re-posts on a handoff), but the PLAYING phase
// has NO switches — both players go off to play their run for 10-20 min while
// chatter ("gg", "almost done") piles up in the thread. This sweep is the ONLY
// thing that keeps the winner-vote controls drifting toward the bottom during
// that window, so they're right there when a player returns to vote.
//
// It only acts when controls are actually BURIED (thread's last message isn't
// ours), which naturally means: while turns are switching, event-driven keeps
// the controls at the bottom so this stays out of the way; once interactions
// settle (the play phase) and chatter buries them, it drifts them back down,
// once per interval. Cost is near-zero — each tick reads the cached
// lastMessageId to decide and only spends REST on a genuinely buried thread.
// bumpMatchControls re-pings only on a real turn change, so a plain un-bury is
// silent.
const CONTROL_BUMP_INTERVAL_MS = 2 * 60 * 1000;
export async function bumpStaleMatchControls(client: Client): Promise<void> {
  const sessions = await prisma.matchSession.findMany({
    where: {
      threadId: { not: null },
      matchMessageId: { not: null },
      state: { notIn: [MatchSessionState.COMPLETE, MatchSessionState.CANCELLED] },
    },
    take: 50,
  });
  for (const session of sessions) {
    if (!session.threadId) continue;
    try {
      const channel = await client.channels.fetch(session.threadId);
      if (!channel || !channel.isTextBased() || !("messages" in channel)) continue;
      // Controls are buried if the thread's last message isn't ours. The bot now
      // has the GuildMessages intent (added for transcript capture), so the gateway
      // keeps channel.lastMessageId fresh from players' chat — we read it from cache
      // instead of a per-tick REST messages.fetch (which was needed only because the
      // bot used to run intent-less). Saves one REST call per active session per tick.
      const lastId = channel.lastMessageId;
      if (lastId && lastId !== session.matchMessageId) {
        await bumpMatchControls(client, session);
      }
    } catch (err) {
      console.warn(`[bump-stale-controls] ${session.id} failed:`, err);
    }
  }
}

export function startMatchControlBumper(client: Client): void {
  setInterval(() => {
    bumpStaleMatchControls(client).catch((err) => console.warn("[bump-stale-controls] tick failed:", err));
  }, CONTROL_BUMP_INTERVAL_MS);
}

// Active banner selected from the PUBLIC ban dropdown. The selection
// itself is client-local — the opponent never saw it — so closing the
// dropdown commits directly (BMP-style, what players are used to). No
// confirm step. loadBanContext (public variant) guards the actor and
// refreshes the public message in place if the phase is stale.
async function handleBanSelect(interaction: StringSelectMenuInteraction, session: MatchSession) {
  await ackFast(interaction);
  const ctx = await loadBanContext(interaction, session);
  if (!ctx) return;
  const selected = interaction.values.map((v) => parseInt(v, 10)).filter((n) => !Number.isNaN(n));
  if (selected.length !== ctx.expected) {
    return reply(interaction, `Pick exactly ${ctx.expected} combo(s) to ban.`);
  }
  if (selected.some((idx) => ctx.game.bans.includes(idx))) {
    return reply(interaction, "Some of those are already banned — pick again.");
  }
  const updated = await applyBans(session, ctx, selected);
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
}

// 🎲 Random ban — roll the active banner's full allotment from what's
// left and apply it immediately. No confirm: random means random. Runs
// from the public button, so we update the message in place and drop a
// small ephemeral ack.
async function handleBanRandom(interaction: ButtonInteraction, session: MatchSession) {
  await ackFast(interaction);
  const ctx = await loadBanContext(interaction, session);
  if (!ctx) return;
  const remaining = remainingCombos(ctx.game.pool, ctx.game.bans).map((r) => r.idx);
  if (remaining.length < ctx.expected) {
    return reply(interaction, "Not enough combos left to ban.");
  }
  // Draw `expected` distinct indices without replacement.
  const pool = [...remaining];
  const selected: number[] = [];
  for (let i = 0; i < ctx.expected; i++) {
    const j = Math.floor(Math.random() * pool.length);
    const [picked] = pool.splice(j, 1);
    if (picked !== undefined) selected.push(picked);
  }
  // Flag which side used random (for the Rando Brando trait). The active
  // banner is whoever phaseFor says — which equals the interaction user.
  const phase = phaseFor(ctx.game, session.playerAId, session.playerBId, parsePolicy(session.policy));
  const actorIsFirst = phase.kind === "BAN" && phase.whoseBanId === ctx.game.firstId;
  const updated = await applyBans(session, ctx, selected, actorIsFirst ? { firstBannedRandomly: true } : { otherBannedRandomly: true });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
  return reply(interaction, `🎲 Randomly banned: ${banSummary(ctx.game.pool, selected)}`);
}

// Both players consent → regenerate this game's pool. Excludes deck
// NAMES seen in prior games for variety (same rule generatePool uses
// at game start). Clears bans and reroll votes so the ban phase
// starts over with a fresh shuffle.
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
    : await presetForCasualMatch();
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

type BanContext = {
  gameNum: 1 | 2 | 3;
  gameField: "game1" | "game2" | "game3";
  game: GameState;
  expected: number;
};

// Fold the chosen indices into the game's bans and advance to PICK if
// the ban phase is complete. Version-gated via updateSession — returns
// the updated session, or null if a concurrent click won the race.
async function applyBans(
  session: MatchSession,
  ctx: BanContext,
  indices: number[],
  extra?: Partial<GameState>,
): Promise<MatchSession | null> {
  // Banning IS "I'm fine with this pool", so clear any pending reroll
  // vote. Otherwise a stale vote cast earlier could later combine with
  // the opponent's confirm and wipe bans made in between.
  const newGame: GameState = {
    ...ctx.game,
    bans: [...ctx.game.bans, ...indices],
    rerollVoteByA: undefined,
    rerollVoteByB: undefined,
    ...extra,
  };
  const newPhase = phaseFor(newGame, session.playerAId, session.playerBId, parsePolicy(session.policy));
  let newState: MatchSessionState = session.state;
  if (newPhase.kind === "PICK") {
    newState = ctx.gameNum === 1 ? MatchSessionState.GAME_1_PICK
      : ctx.gameNum === 2 ? MatchSessionState.GAME_2_PICK
      : MatchSessionState.GAME_3_PICK;
  }
  return updateSession(session, {
    [ctx.gameField]: JSON.stringify(newGame),
    state: newState,
  } as Prisma.MatchSessionUpdateManyMutationInput);
}

function banSummary(pool: DeckEntry[], indices: number[]): string {
  return indices
    .map((idx) => {
      const combo = pool[idx];
      return combo ? `${combo.deck} / ${combo.stake}` : null;
    })
    .filter((s): s is string => !!s)
    .join(", ");
}

// Close the match thread when the match completes. For private/public
// threads we just DELETE — the result lives on the Pairing row + the
// #results announce + the audit log, and disputes spawn their own
// dedicated thread (Pairing.disputeThreadId), so nothing of value
// is in the match thread once the buttons have been clicked.
//
// Stamps MatchSession.threadArchivedAt on success so the
// match-sweep leaked-thread pass skips this row. Best-effort —
// failures leave threadArchivedAt null so the next sweep tick
// picks it up.
//
// Legacy GuildText channels (pre-revert per-match text channels) are
// NOT deleted — they're locked instead so admin can clean them up by
// hand if any are still around.
async function closeMatchChannel(
  interaction: AnyInteraction,
  sessionId: string,
  channelId: string | null,
): Promise<void> {
  if (!channelId) return;
  // Index this thread's transcript in the staff #league-transcripts channel
  // before the thread is deleted (best-effort; skips threads where nothing was
  // said). The link points at the durable web transcript, not the thread.
  postTranscriptSummary(interaction.client, channelId).catch(() => {});
  let ok = false;
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel) {
      console.warn(`[closeMatchChannel] channel ${channelId} not found for session ${sessionId}`);
      return;
    }
    if (channel.type === ChannelType.PrivateThread || channel.type === ChannelType.PublicThread) {
      const thread = channel as ThreadChannel;
      await thread.delete("Match complete").then(
        () => { ok = true; },
        (err: unknown) => logDiscordError("closeMatchChannel.delete", err, { threadId: channelId, sessionId }),
      );
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
  // Accept is the heaviest handler — it creates a private thread and adds
  // members (rate-limited REST) on top of several DB reads, which can blow
  // Discord's 3-second ack window under load. deferUpdate acks immediately
  // (buying 15 minutes) so the interaction can never expire mid-setup and
  // strand the match with no visible UI. Every downstream reply/refresh is
  // defer-aware (followUp / editReply) so this is the only change needed.
  await interaction.deferUpdate();

  // Expiry check — survives bot restarts unlike the original setTimeout.
  if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
    const cancelled = await updateSession(session, { state: MatchSessionState.CANCELLED });
    await reply(interaction, "This match invite expired.");
    if (cancelled) closeMatchChannel(interaction, cancelled.id, cancelled.threadId).catch(() => {});
    return;
  }
  // Load both players ONCE up front and thread them through — this handler
  // previously called loadPlayers three times (here, again below, and once
  // more inside refreshMessage), i.e. 6 player queries for 2 players.
  const { playerA, playerB } = await loadPlayers(session);
  // Only the challenged player accepts. If the challenger clicks their own
  // Accept (it's visible to them — public message, one render), point them
  // at Decline to withdraw instead of a confusing "not your turn".
  if (interaction.user.id === playerA.discordId) {
    return reply(interaction, "You sent this challenge — waiting on your opponent to accept. Click Decline to take it back.");
  }
  if (interaction.user.id !== playerB.discordId) {
    return reply(interaction, "Only the challenged player can accept this match.");
  }

  // A player banned SINCE the invite was created can't accept it (nor be pulled
  // in as the opponent). createLeagueMatchInvite blocks banned players at
  // creation, but a ban can land while an invite is still WAITING_ACCEPT — so
  // re-check here and cancel the stale invite.
  const bannedNow = await bannedPlayerIds([playerA.id, playerB.id]);
  if (bannedNow.size > 0) {
    const cancelled = await updateSession(session, { state: MatchSessionState.CANCELLED });
    await reply(
      interaction,
      bannedNow.has(playerB.id) ? BANNED_MESSAGE : `${sanitizeName(playerA.displayName)} is banned from the league, so this match can't start.`,
    );
    if (cancelled) closeMatchChannel(interaction, cancelled.id, cancelled.threadId).catch(() => {});
    return;
  }

  // League /start-match → division's preset (uses the season-default
  // pointer as fallback). Casual /challenge → the preset pointed at by
  // the casual config key. Bootstrap is a no-op once a preset+pointers
  // exist, so safe to call on every accept.
  await bootstrapPresetsAndPointers().catch((err) =>
    console.warn("[handleAccept] bootstrapPresetsAndPointers failed:", err),
  );
  const preset = session.divisionId
    ? await presetForDivision(session.divisionId)
    : await presetForCasualMatch();
  if (!preset || preset.decks.length === 0 || preset.stakes.length === 0) {
    const which = session.divisionId ? "this season's preset" : "the casual-match preset";
    return reply(interaction, `The deck pool isn't set up — ask an admin to configure decks/stakes for ${which} on \`/admin/deck-bans\` before accepting.`);
  }
  // Read the current league settings once and stamp the resulting
  // policy onto the session — that snapshot stays valid for this
  // match's full lifetime even if an admin changes the config later.
  // League matches use the season's template; casual /challenge has
  // no season context so it reads the global default.
  const settings = session.divisionId
    ? await getLeagueSettingsForSeason((await prisma.division.findUnique({ where: { id: session.divisionId }, select: { seasonId: true } }))!.seasonId)
    : await getLeagueSettings();
  const game1Pool = generatePool(preset.decks, preset.stakes, settings.matchPolicy.poolSize);
  const policySnapshot = {
    firstPlayerBans: settings.matchPolicy.firstPlayerBans,
    secondPlayerBans: settings.matchPolicy.secondPlayerBans,
    poolSize: game1Pool.length,
  };

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
    // Casual /challenge threads live under #challenges; league /start-match
    // threads under #league-matches (both in the '🎴 Matches' category) — kept
    // off the division channels so staff don't auto-see matches via their
    // ManageThreads (group-thread) access. Falls back to the current channel.
    let parentChannel = interaction.channel?.type === ChannelType.GuildText
      ? (interaction.channel as TextChannel)
      : null;
    const parentChannelId = session.isCasual
      ? await resolveChallengesChannelId()
      : await ensureLeagueMatchesChannel();
    if (parentChannelId) {
      try {
        const fetched = await interaction.client.channels.fetch(parentChannelId);
        if (fetched && fetched.type === ChannelType.GuildText) {
          parentChannel = fetched as TextChannel;
        }
      } catch {
        // fall through to interaction.channel
      }
    }
    if (parentChannel) {
      try {
        const suffix = session.id.slice(-6);
        const thread = await parentChannel.threads.create({
          name: `Match: ${playerA.displayName} vs ${playerB.displayName} (${suffix})`,
          type: ChannelType.PrivateThread,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          invitable: false,
        });
        await thread.members.add(playerA.discordId).catch(() => {});
        await thread.members.add(playerB.discordId).catch(() => {});
        // First thing in the thread: the moderation-recording notice (pinned).
        await postModerationNotice(thread);
        matchChannelId = thread.id;
      } catch (err) {
        console.warn("[match] failed to create private thread:", err);
      }
    }
  }

  const game1State: GameState = emptyGameState(firstId, game1Pool);
  const initialState = MatchSessionState.GAME_1_BAN;
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
    summary: `Match started: ${playerA.displayName} vs ${playerB.displayName}${session.isCasual ? " (casual)" : session.isShootout ? " (showdown)" : ""}`,
    metadata: {
      isCasual: session.isCasual,
      isShootout: session.isShootout,
      bestOf: session.bestOf,
      divisionId: session.divisionId,
      playerAId: session.playerAId,
      playerBId: session.playerBId,
    },
  });

  const allowedStakes = preset.stakes;
  // Did the match just relocate into a NEW private thread? (start-match
  // posts the invite in the division channel, then makes a thread on
  // accept. /challenge's invite is already in the thread, so no move.)
  if (matchChannelId && matchChannelId !== session.threadId) {
    // Leave only a pointer on the original (public) invite — the full
    // match controls belong in the private thread, not duplicated in the
    // league channel. Best-effort: a failed edit must not abort before the
    // thread message (the canonical UI) is posted below.
    const pointer = new EmbedBuilder()
      .setTitle("🎴 Match started")
      .setColor(0x2ecc71)
      .setDescription(`${sanitizeName(playerA.displayName)} vs ${sanitizeName(playerB.displayName)} — play it out in <#${matchChannelId}>.`)
      .setFooter({ text: `Match ${updated.id}` });
    await editOrUpdate(interaction, { content: "", embeds: [pointer], components: [] })
      .catch((err) => console.warn(`[handleAccept] invite pointer edit failed for ${updated.id}:`, err));
    try {
      const thread = await interaction.client.channels.fetch(matchChannelId);
      if (thread && thread.type === ChannelType.PrivateThread) {
        const { embeds, components, content } = renderMatch(updated, playerA, playerB, { allowedStakes });
        const sent = await thread.send({
          content: content || `<@${playerA.discordId}> <@${playerB.discordId}> — your match thread.`,
          embeds,
          components,
        });
        // The canonical match message is now the in-thread send.
        await prisma.matchSession.update({
          where: { id: updated.id },
          data: { matchMessageId: sent.id, threadId: matchChannelId },
        }).catch((err) => console.warn(`[match] persist thread messageId failed:`, err));
      }
    } catch (err) {
      console.warn(`[match] failed to post into match thread ${matchChannelId}:`, err);
    }
  } else {
    // No relocation — the invite message IS the match message.
    const started = renderMatch(updated, playerA, playerB, { allowedStakes });
    await editOrUpdate(interaction, {
      content: started.content,
      embeds: started.embeds,
      components: started.components,
    }).catch((err) => console.warn(`[handleAccept] invite edit failed for ${updated.id}:`, err));
  }
  // Hush unused-env warning until something in here actually reads env.
  void env;
}

async function handleDecline(interaction: ButtonInteraction, session: MatchSession) {
  if (session.state !== "WAITING_ACCEPT") {
    return reply(interaction, "This match is no longer waiting.");
  }
  // Either player can call it off: the challenged player declines, the
  // challenger withdraws — both just cancel the pending invite.
  const { playerA, playerB } = await loadPlayers(session);
  if (interaction.user.id !== playerA.discordId && interaction.user.id !== playerB.discordId) {
    return reply(interaction, "Only the two players in this match can decline it.");
  }
  const updated = await updateSession(session, { state: MatchSessionState.CANCELLED });
  if (!updated) return raceLost(interaction);
  // The invite was never accepted — delete its thread rather than leaving
  // a "cancelled" embed sitting in an orphaned thread.
  await reply(interaction, "Invite declined — closing the thread.");
  closeMatchChannel(interaction, updated.id, updated.threadId).catch(() => {});
}

async function handleChooseFirst(interaction: ButtonInteraction, session: MatchSession, firstIdRaw: string | undefined) {
  await ackFast(interaction);
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
    : await presetForCasualMatch();
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

// 🎲 Random pick — choose one of the remaining combos at random and apply
// it. handlePick re-validates the picker + state, so a non-picker clicking
// this just gets rejected there.
async function handlePickRandom(interaction: ButtonInteraction, session: MatchSession) {
  const gameNum =
    session.state === "GAME_1_PICK" ? 1 :
    session.state === "GAME_2_PICK" ? 2 :
    session.state === "GAME_3_PICK" ? 3 : 0;
  if (gameNum === 0) return reply(interaction, "Not in a pick phase.");
  const game = parseGame(session[`game${gameNum}` as const]);
  if (!game) return reply(interaction, "Game state missing.");
  const remaining = remainingCombos(game.pool, game.bans).map((r) => r.idx);
  if (remaining.length === 0) return reply(interaction, "No combos left to pick.");
  const choice = remaining[Math.floor(Math.random() * remaining.length)]!;
  return handlePick(interaction, session, String(choice), true);
}

async function handlePick(interaction: AnyInteraction, session: MatchSession, idxRaw: string | undefined, random = false) {
  await ackFast(interaction);
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

  const newGame: GameState = { ...game, pickedDeckIdx: idx, pickedRandomly: random };
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
  const isPlayerA = interaction.user.id === playerA.discordId;
  const isPlayerB = interaction.user.id === playerB.discordId;
  // Admin override: a staff click on a winner button LOCKS that winner right away
  // (skips the both-players-must-agree vote + any dispute), for manual reporting
  // when the normal flow is stuck.
  const asAdmin = !isPlayerA && !isPlayerB ? await isMatchAdmin(interaction) : false;
  if (!isPlayerA && !isPlayerB && !asAdmin) {
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
  const voterIsA = isPlayerA;
  const newGame: GameState = {
    ...game,
    // Admin override forces BOTH votes to the chosen winner so it locks below.
    voteByA: asAdmin ? winnerIdRaw : voterIsA ? winnerIdRaw : game.voteByA,
    voteByB: asAdmin ? winnerIdRaw : !voterIsA ? winnerIdRaw : game.voteByB,
    disputed: false, // re-check below
  };
  if (asAdmin) {
    recordAudit({
      actor: { discordId: interaction.user.id, displayName: interaction.user.username },
      action: "match.admin-winner",
      targetType: "MatchSession",
      targetId: session.id,
      summary: `Admin set game winner to ${winnerIdRaw === session.playerAId ? playerA.displayName : playerB.displayName}`,
      metadata: { winnerId: winnerIdRaw, gameState: session.state },
    });
  }

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

  // Both voted the same way → that's the winner.
  newGame.winnerId = newGame.voteByA;

  // REQUIRED lives capture: a non-DC league game isn't done until the winner
  // records their remaining lives. Persist the winner and re-render (phaseFor
  // now returns AWAIT_LIVES → the lives prompt); handleLives() resumes the
  // advance once the winner picks. DC forfeits (no attrition result) and
  // casual /challenge games (don't count for standings) skip straight to the
  // advance.
  // Still capture the winner's lives — even on an admin override (an admin can
  // enter them too via handleLives). "Auto-accept" only skips the opponent's
  // agreement, not the lives step.
  if (!session.isCasual && !newGame.dcByPlayerId && newGame.winnerLives == null) {
    const updated = await updateSession(session, {
      [gameField]: JSON.stringify(newGame),
    } as Prisma.MatchSessionUpdateManyMutationInput);
    if (!updated) return raceLost(interaction);
    return refreshMessage(interaction, updated);
  }

  return advanceAfterGameWin(interaction, session, newGame, gameField);
}

// Advance the match after a game's winner — and, for non-DC games, the
// winner's lives — are recorded: start the next game or finalize. Called by
// handleWinner (DC forfeits, which skip lives) and handleLives (after the
// winner records their lives). `gameField` is the game that just completed.
async function advanceAfterGameWin(
  interaction: ButtonInteraction,
  session: MatchSession,
  newGame: GameState,
  gameField: "game1" | "game2" | "game3",
) {
  const isGame1 = gameField === "game1";
  const isGame2 = gameField === "game2";

  // Count wins per player. The just-completed game uses newGame's winner
  // (session[gameField] may or may not be persisted yet, depending on the
  // caller); the other games come from stored state.
  const winsFor = (id: string, includeCurrent: boolean) => {
    const stored = {
      game1: parseGame(session.game1)?.winnerId,
      game2: parseGame(session.game2)?.winnerId,
      game3: parseGame(session.game3)?.winnerId,
    };
    let count = 0;
    for (const f of ["game1", "game2", "game3"] as const) {
      if (includeCurrent && f === gameField) continue; // counted via newGame below
      if (stored[f] === id) count++;
    }
    if (includeCurrent && newGame.winnerId === id) count++;
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

// Winner records how many lives they had left (1..MAX_GAME_LIVES). Required
// before the match advances; only the winning player can set it. Once set we
// hand off to advanceAfterGameWin to start the next game / finalize.
async function handleLives(interaction: ButtonInteraction, session: MatchSession, livesRaw: string | undefined) {
  const lives = Number(livesRaw);
  if (!Number.isInteger(lives) || lives < 1 || lives > MAX_GAME_LIVES) {
    return reply(interaction, "That lives button looks broken — refresh Discord and try again.");
  }
  const isGame1 = session.state === "GAME_1_PLAYING";
  const isGame2 = session.state === "GAME_2_PLAYING";
  const isGame3 = session.state === "GAME_3_PLAYING";
  if (!isGame1 && !isGame2 && !isGame3) return reply(interaction, "This match isn't waiting for a lives count.");
  const gameField: "game1" | "game2" | "game3" = isGame1 ? "game1" : isGame2 ? "game2" : "game3";
  const game = parseGame(session[gameField]);
  if (!game || !game.winnerId) return reply(interaction, "No game winner recorded yet — vote on the winner first.");
  if (game.winnerLives != null) return reply(interaction, "Lives are already recorded for this game.");

  const { playerA, playerB } = await loadPlayers(session);
  const winnerDiscordId = game.winnerId === playerA.id ? playerA.discordId : playerB.discordId;
  // Admin can record the winner's lives on their behalf (stuck-match override).
  if (interaction.user.id !== winnerDiscordId && !(await isMatchAdmin(interaction))) {
    return reply(interaction, "Only the winner of this game can record their remaining lives.");
  }

  const newGame: GameState = { ...game, winnerLives: lives };
  return advanceAfterGameWin(interaction, session, newGame, gameField);
}

// "Call helper" button → opens a modal asking for a reason. Modal
// submit pings the bound HELPER role(s) and (in private threads)
// adds those role members so they can see the conversation. Same
// surface as the /helper slash command, just one click away from
// inside the match flow.
async function handleCallHelper(interaction: ButtonInteraction, session: MatchSession) {
  // Cooldown, not a permanent lock: stops accidental double-pings of the
  // helper role without wedging the button forever (a one-shot lock left
  // people stuck if the first summon didn't actually reach anyone). After
  // the window you can call again. A simultaneous double-click is still
  // caught atomically at submit time.
  if (session.helperCalledAt && Date.now() - session.helperCalledAt.getTime() < HELPER_CALL_COOLDOWN_MS) {
    const when = `<t:${Math.floor(session.helperCalledAt.getTime() / 1000)}:R>`;
    return reply(interaction, `A helper was already called ${when} — give them a few minutes before calling again.`);
  }
  const modal = new ModalBuilder()
    .setCustomId(`match-helper-modal:${session.id}`)
    .setTitle("Call a helper");
  const reasonInput = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("What's going on? (helpers will see this)")
    .setPlaceholder("e.g. opponent unresponsive for 10 min, rules question on a deck, ...")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput));
  await interaction.showModal(modal);
}

// Modal submit: actually call summonHelpers with the reason the user
// typed. Lives in match-buttons.ts because the modal customId is
// scoped to the match flow (and the registered ModalHandler list).
export const callHelperModal = {
  prefix: "match-helper-modal:",
  async execute(interaction: ModalSubmitInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "Run this in a server channel, not DMs.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Atomically claim the call slot: the conditional update only succeeds
    // if no helper was called within the cooldown window, so two
    // simultaneous submits can't both ping the helper role. We roll the
    // claim back if the summon itself fails so they can retry.
    const sessionId = interaction.customId.split(":")[1];
    if (sessionId) {
      const cutoff = new Date(Date.now() - HELPER_CALL_COOLDOWN_MS);
      const claim = await prisma.matchSession.updateMany({
        where: {
          id: sessionId,
          OR: [{ helperCalledAt: null }, { helperCalledAt: { lt: cutoff } }],
        },
        data: { helperCalledAt: new Date() },
      });
      if (claim.count === 0) {
        await interaction.reply({
          content: "A helper was just called for this match — give them a few minutes before calling again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    const reason = interaction.fields.getTextInputValue("reason").trim();
    const channel = interaction.channel as GuildTextBasedChannel | null;
    const result = await summonHelpers({
      guild: interaction.guild,
      channel,
      caller: interaction.user,
      reason,
    });
    if ("error" in result) {
      // Summon failed — release the claim so the call can be retried.
      if (sessionId) {
        await prisma.matchSession
          .update({ where: { id: sessionId }, data: { helperCalledAt: null } })
          .catch(() => {});
      }
      await interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: result.content });
    // The helper ping just posted below the controls — bump them back to
    // the bottom so players don't have to scroll up to keep playing.
    if (sessionId) {
      const s = await loadSession(sessionId);
      if (s) await bumpMatchControls(interaction.client, s);
    }
  },
} as const;

// Opponent-DC report. League match: forfeits the CURRENT game only;
// the series continues normally (game 2 plays out after a game 1 DC).
// Shootout: refuses to auto-forfeit and tells the clicker to use
// /helper since the rules around shootout DCs need admin judgment.
// Mutual-consent PAUSE: pauses the session until both players consent
// to resume. Only valid AFTER game 1's winner has been recorded —
// during game 1 the right path is mutual-cancel + restart later.
// First click votes; opposite player's click flips state to PAUSED.
// Re-clicking by the same player is a no-op (still ONE vote).
async function handlePauseVote(interaction: ButtonInteraction, session: MatchSession) {
  // Disallowed states: before game 1 winner is in (anything Game 1 or
  // before — admin can just cancel), already PAUSED, or terminal.
  const pausable =
    session.state === "GAME_2_CHOOSE_FIRST" ||
    session.state === "GAME_2_BAN" ||
    session.state === "GAME_2_PICK" ||
    session.state === "GAME_2_PLAYING" ||
    session.state === "GAME_3_CHOOSE_FIRST" ||
    session.state === "GAME_3_BAN" ||
    session.state === "GAME_3_PICK" ||
    session.state === "GAME_3_PLAYING";
  if (!pausable) {
    return reply(
      interaction,
      "Pause is available after game 1's winner is recorded. Before then, use the Cancel match button or admin cancel.",
    );
  }
  const { playerA, playerB } = await loadPlayers(session);
  if (interaction.user.id !== playerA.discordId && interaction.user.id !== playerB.discordId) {
    return reply(interaction, "Only the two players in this match can vote to pause.");
  }
  const voterId = interaction.user.id === playerA.discordId ? session.playerAId : session.playerBId;

  // Mutual-consent: opposite player's vote flips state.
  if (session.pauseInitiatorPlayerId && session.pauseInitiatorPlayerId !== voterId) {
    const updated = await updateSession(session, {
      state: MatchSessionState.PAUSED,
      pausedFromState: session.state,
      pauseInitiatorPlayerId: null,
      pausedAt: new Date(),
    });
    if (!updated) return raceLost(interaction);
    await refreshMessage(interaction, updated);
    return reply(interaction, "Match paused. Click Resume when you're both ready.");
  }
  if (session.pauseInitiatorPlayerId === voterId) {
    return reply(interaction, "You already voted to pause — waiting on your opponent.");
  }
  // First vote.
  const updated = await updateSession(session, {
    pauseInitiatorPlayerId: voterId,
  });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
  return reply(interaction, "You voted to pause — your opponent has to click Pause too.");
}

// Mutual-consent RESUME — flips PAUSED back to whatever state we
// paused from. Same vote pattern as pause.
async function handleResumeVote(interaction: ButtonInteraction, session: MatchSession) {
  if (session.state !== "PAUSED") {
    return reply(interaction, "This match isn't paused.");
  }
  if (!session.pausedFromState) {
    // Defensive — shouldn't happen since pause always writes the field.
    return reply(interaction, "Paused state is missing the original phase. Ask an admin to cancel + restart.");
  }
  const { playerA, playerB } = await loadPlayers(session);
  if (interaction.user.id !== playerA.discordId && interaction.user.id !== playerB.discordId) {
    return reply(interaction, "Only the two players in this match can vote to resume.");
  }
  const voterId = interaction.user.id === playerA.discordId ? session.playerAId : session.playerBId;

  if (session.resumeInitiatorPlayerId && session.resumeInitiatorPlayerId !== voterId) {
    const updated = await updateSession(session, {
      state: session.pausedFromState,
      pausedFromState: null,
      resumeInitiatorPlayerId: null,
      pausedAt: null,
    });
    if (!updated) return raceLost(interaction);
    await refreshMessage(interaction, updated);
    return reply(interaction, "Match resumed — pick up where you left off.");
  }
  if (session.resumeInitiatorPlayerId === voterId) {
    return reply(interaction, "You already voted to resume — waiting on your opponent.");
  }
  const updated = await updateSession(session, {
    resumeInitiatorPlayerId: voterId,
  });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
  return reply(interaction, "You voted to resume — your opponent has to click Resume too.");
}

// Mutual-consent opponent-DC. The claimant clicks "Opponent DC'd" → it
// records a claim and pings the opponent, who Confirms (forfeits this
// game) or Disputes. Clicking again withdraws. Only operable in a PLAYING
// phase — during BAN/PICK the right path is /helper. If the opponent is
// truly gone and can't confirm, the claimant uses /helper.
async function handleDc(interaction: ButtonInteraction, session: MatchSession) {
  const isGame1 = session.state === "GAME_1_PLAYING";
  const isGame2 = session.state === "GAME_2_PLAYING";
  const isGame3 = session.state === "GAME_3_PLAYING";
  if (!isGame1 && !isGame2 && !isGame3) {
    return reply(
      interaction,
      "You can only report a DC once a game is being played. If your opponent went quiet during bans/picks, use `/helper` instead.",
    );
  }
  const { playerA, playerB } = await loadPlayers(session);
  if (interaction.user.id !== playerA.discordId && interaction.user.id !== playerB.discordId) {
    return reply(interaction, "Only the two players in this match can report a DC.");
  }
  if (session.isShootout) {
    return reply(
      interaction,
      "Shootout DCs need admin review — use `/helper` so a moderator can decide the outcome. Shootouts don't auto-forfeit.",
    );
  }

  const gameField: "game1" | "game2" | "game3" = isGame1 ? "game1" : isGame2 ? "game2" : "game3";
  const gameJson = session[gameField];
  const game = parseGame(gameJson);
  if (!game) return reply(interaction, "Game state missing.");

  const reporterId = interaction.user.id === playerA.discordId ? session.playerAId : session.playerBId;

  // Already a claim in flight?
  if (session.dcInitiatorPlayerId) {
    if (session.dcInitiatorPlayerId === reporterId) {
      // Same player clicks again → withdraw their claim.
      const updated = await updateSession(session, { dcInitiatorPlayerId: null });
      if (!updated) return raceLost(interaction);
      await refreshMessage(interaction, updated);
      return reply(interaction, "Withdrew your DC report — game continues.");
    }
    // The OTHER player already claimed (they say YOU disconnected). Treat
    // this click as a competing claim — clearer to just point them at the
    // Confirm/Dispute buttons that are already showing.
    return reply(interaction, "Your opponent already reported a DC. Use Confirm or Dispute on the match.");
  }

  // First claim: record it and ping the opponent to confirm or dispute.
  const updated = await updateSession(session, { dcInitiatorPlayerId: reporterId });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
  return reply(
    interaction,
    "Reported that your opponent disconnected. They need to **Confirm** (you take this game) or **Dispute** it. If they're gone for good, use `/helper`.",
  );
}

// Opponent confirms the DC claim → claimant wins the current game, the
// confirmer is recorded as the disconnect. Only the player the claim is
// AGAINST (the opponent of the claimant) can confirm.
async function handleDcConfirm(interaction: ButtonInteraction, session: MatchSession) {
  const isGame1 = session.state === "GAME_1_PLAYING";
  const isGame2 = session.state === "GAME_2_PLAYING";
  const isGame3 = session.state === "GAME_3_PLAYING";
  if (!isGame1 && !isGame2 && !isGame3) return reply(interaction, "No game is being played.");
  if (!session.dcInitiatorPlayerId) return reply(interaction, "There's no DC report to confirm.");
  const { playerA, playerB } = await loadPlayers(session);
  if (interaction.user.id !== playerA.discordId && interaction.user.id !== playerB.discordId) {
    return reply(interaction, "Only the two players in this match can confirm a DC.");
  }
  const actorId = interaction.user.id === playerA.discordId ? session.playerAId : session.playerBId;
  const claimantId = session.dcInitiatorPlayerId;
  if (actorId === claimantId) {
    return reply(interaction, "You reported the DC — your opponent has to confirm it.");
  }
  // actor is the opponent of the claimant = the one who supposedly DC'd.
  return applyDcForfeit(interaction, session, claimantId, actorId);
}

// Either player disputes the claim → clear it, game continues.
async function handleDcDispute(interaction: ButtonInteraction, session: MatchSession) {
  if (!session.dcInitiatorPlayerId) return reply(interaction, "There's no DC report to dispute.");
  const { playerA, playerB } = await loadPlayers(session);
  if (interaction.user.id !== playerA.discordId && interaction.user.id !== playerB.discordId) {
    return reply(interaction, "Only the two players in this match can dispute a DC.");
  }
  const updated = await updateSession(session, { dcInitiatorPlayerId: null });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
  return reply(interaction, "Cleared the DC report — keep playing. If you can't agree, use `/helper`.");
}

// Shared forfeit application: claimant wins the current game, dcer is
// recorded as the disconnect, and we advance (same wiring as handleWinner,
// narrower — no custom-combo skip). Clears the DC claim in the same write.
async function applyDcForfeit(
  interaction: ButtonInteraction,
  session: MatchSession,
  claimantId: string,
  dcerId: string,
) {
  const isGame1 = session.state === "GAME_1_PLAYING";
  const isGame2 = session.state === "GAME_2_PLAYING";
  const gameField: "game1" | "game2" | "game3" = isGame1 ? "game1" : isGame2 ? "game2" : "game3";
  const game = parseGame(session[gameField]);
  if (!game) return reply(interaction, "Game state missing.");
  const newGame: GameState = {
    ...game,
    voteByA: claimantId,
    voteByB: claimantId,
    winnerId: claimantId,
    dcByPlayerId: dcerId,
    disputed: false,
  };

  if (isGame1) {
    const updated = await updateSession(session, {
      game1: JSON.stringify(newGame),
      state: MatchSessionState.GAME_2_CHOOSE_FIRST,
      dcInitiatorPlayerId: null,
    });
    if (!updated) return raceLost(interaction);
    await refreshMessage(interaction, updated);
    return reply(interaction, "Confirmed — DC win recorded for game 1. Game 2 plays normally.");
  }

  if (isGame2) {
    if (session.bestOf === 3) {
      const winsFor = (id: string) => {
        const g1 = parseGame(session.game1)?.winnerId;
        const g3 = parseGame(session.game3)?.winnerId;
        let count = 0;
        if (g1 === id) count++;
        if (newGame.winnerId === id) count++;
        if (g3 === id) count++;
        return count;
      };
      if (winsFor(session.playerAId) === 1 && winsFor(session.playerBId) === 1) {
        const updated = await updateSession(session, {
          game2: JSON.stringify(newGame),
          state: MatchSessionState.GAME_3_CHOOSE_FIRST,
          dcInitiatorPlayerId: null,
        });
        if (!updated) return raceLost(interaction);
        await refreshMessage(interaction, updated);
        return reply(interaction, "Confirmed — DC win recorded for game 2. Series goes to game 3.");
      }
    }
    return finalizeMatch(interaction, session, newGame, "game2");
  }

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
    dcInitiatorPlayerId: null,
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
    summary: `${playerA.displayName} ${aWins}-${bWins} ${playerB.displayName}${session.isCasual ? " (casual)" : session.isShootout ? " (showdown)" : ""}`,
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

  // Casual /challenge — no Pairing write. Refresh + close, then post a
  // scoreline to the challenge-results feed so there's a browsable log of
  // casual play (best-effort; falls back to #challenges if no feed configured).
  if (session.isCasual || !session.divisionId) {
    await refreshMessage(interaction, updated);
    closeMatchChannel(interaction, updated.id, updated.threadId).catch(() => {});
    const g1s = finalGameField === "game1" ? finalGame : g1;
    const g2s = finalGameField === "game2" ? finalGame : g2;
    const g3s = finalGameField === "game3" ? finalGame : g3;
    const comboOf = (g: GameState): { deck: string | null; stake: string | null } => {
      const c = g.pickedDeckIdx !== undefined ? g.pool[g.pickedDeckIdx] : undefined;
      return c ? { deck: c.deck, stake: c.stake } : { deck: null, stake: null };
    };
    announceChallengeResult({
      sessionId: updated.id,
      playerA: { discordId: playerA.discordId, displayName: playerA.displayName },
      playerB: { discordId: playerB.discordId, displayName: playerB.displayName },
      winsA: aWins,
      winsB: bWins,
      combos: [g1s, g2s, g3s].filter((g): g is GameState => !!g).map(comboOf),
    }).catch(() => {});
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
    const winA = winnerId === canonA ? 1 : 0;
    const winB = winnerId === canonB ? 1 : 0;
    const now = new Date();
    const shootout = await prisma.match.upsert({
      where: {
        divisionId_playerAId_playerBId_format: {
          divisionId: session.divisionId,
          playerAId: canonA,
          playerBId: canonB,
          format: "SHOOTOUT_BO1",
        },
      },
      create: {
        divisionId: session.divisionId,
        playerAId: canonA,
        playerBId: canonB,
        format: "SHOOTOUT_BO1",
        gamesWonA: winA,
        gamesWonB: winB,
        winnerId,
        status: "CONFIRMED",
        reportedAt: now,
        confirmedAt: now,
        recordedBy: interaction.user.id,
      },
      update: { gamesWonA: winA, gamesWonB: winB, winnerId, status: "CONFIRMED", confirmedAt: now, recordedBy: interaction.user.id },
    });
    // The shootout's single game went through ban/pick — persist it.
    const g1state = finalGameField === "game1" ? finalGame : g1;
    await writeMatchGames(shootout.id, canonA, canonB, [g1state]);
    await prisma.matchSession.update({ where: { id: updated.id }, data: { pairingId: shootout.id } });
    if (updated.threadId) backfillMatchId(updated.threadId, shootout.id).catch(() => {});
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
  // Any game in this series get won via the DC button? Persist as a
  // top-level flag on the Pairing so audit / history surfaces can
  // filter without parsing every GameState JSON.
  const hadDc =
    !!parseGame(session.game1)?.dcByPlayerId ||
    !!parseGame(session.game2)?.dcByPlayerId ||
    !!parseGame(session.game3)?.dcByPlayerId ||
    !!finalGame.dcByPlayerId;
  const winnerId = gamesWonA > gamesWonB ? canonA : gamesWonB > gamesWonA ? canonB : null;
  const pairing = await prisma.match.upsert({
    where: {
      divisionId_playerAId_playerBId_format: {
        divisionId: session.divisionId!,
        playerAId: canonA,
        playerBId: canonB,
        format: "LEAGUE_BO2",
      },
    },
    create: {
      divisionId: session.divisionId!,
      playerAId: canonA,
      playerBId: canonB,
      format: "LEAGUE_BO2",
      gamesWonA,
      gamesWonB,
      winnerId,
      status: "CONFIRMED",
      reporterId: reporter.id,
      reportedAt: new Date(),
      confirmedAt: new Date(),
      hadDc,
    },
    update: {
      gamesWonA,
      gamesWonB,
      winnerId,
      status: "CONFIRMED",
      reporterId: reporter.id,
      reportedAt: new Date(),
      hadDc,
      confirmedAt: new Date(),
    },
  });

  // Persist per-game Game/GameDeck rows from the guided flow's GameStates
  // (the final field uses finalGame; others from the stored session).
  const game1State = finalGameField === "game1" ? finalGame : g1;
  const game2State = finalGameField === "game2" ? finalGame : g2;
  const game3State = finalGameField === "game3" ? finalGame : g3;
  await writeMatchGames(pairing.id, canonA, canonB, [game1State, game2State, game3State]);

  await prisma.matchSession.update({
    where: { id: updated.id },
    data: { pairingId: pairing.id },
  });
  if (updated.threadId) backfillMatchId(updated.threadId, pairing.id).catch(() => {});

  await refreshMessage(interaction, updated);
  // Lock the match channel + fire the auto-announce. Both are best-effort
  // and don't block the user-facing message update.
  closeMatchChannel(interaction, updated.id, updated.threadId).catch(() => {});
  enqueueAnnounceResult(pairing.id).catch(() => {});
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
}

// === Custom-combo negotiation handlers ===
// During ANY game's ban phase, either player can propose a deck+stake; the other
// accepts/counters/cancels. handleProposeAccept replaces THAT game's pool with
// the agreed combo (pickedDeckIdx=0 → straight to PLAYING). It applies to that
// one game only — the next game bans/picks as normal. To reuse a combo, just
// propose the same one again. There is no whole-match custom combo.

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
  if (interaction.user.id === playerA.discordId) return { actor: playerA, other: playerB, asAdmin: false };
  if (interaction.user.id === playerB.discordId) return { actor: playerB, other: playerA, asAdmin: false };
  // Admin override: staff can drive the custom-combo flow (propose + auto-apply,
  // or accept a stuck proposal). They act "as player A" for attribution.
  if (await isMatchAdmin(interaction)) return { actor: playerA, other: playerB, asAdmin: true };
  await reply(interaction, "Only the two players in this match can use these buttons.");
  return null;
}

// Render the proposer's private builder for an ephemeral reply/update.
async function buildComboBuilder(session: MatchSession, proposal: ComboProposal) {
  const { playerA, playerB } = await loadPlayers(session);
  const proposer = proposal.by === playerA.id ? playerA : playerB;
  const responder = proposal.by === playerA.id ? playerB : playerA;
  const allowedStakes = await loadAllowedStakes(session);
  return renderComboBuilder({
    sessionId: session.id,
    proposer,
    responder,
    deck: proposal.deck,
    stake: proposal.stake,
    allowedStakes,
  });
}

// "Propose custom combo" → opens the builder as an EPHEMERAL, private to
// the proposer. The public ban message is left untouched (the builder no
// longer takes over the shared message), so the ban phase isn't
// interrupted while they draft. Only Submit surfaces it publicly.
async function handleProposeStart(interaction: ButtonInteraction, session: MatchSession) {
  if (banPhaseGameNum(session.state) === 0) {
    return reply(interaction, "You can only propose a custom combo during a ban phase.");
  }
  const ctx = await actorPlayer(interaction, session);
  if (!ctx) return;
  const existing = parseProposal(session.customComboProposal);
  // Only a SUBMITTED proposal blocks a new one (it's a real offer awaiting
  // a response). A "building" proposal is private and uncommitted — it may
  // be the clicker's own, or one someone opened and abandoned (which would
  // otherwise wedge the button forever) — so just (re)start fresh.
  if (existing && existing.status === "pending") {
    return reply(interaction, "There's already a proposal awaiting a response — accept, counter, or cancel it first.");
  }
  const proposal: ComboProposal = { by: ctx.actor.id, status: "building" };
  const updated = await updateSession(session, { customComboProposal: JSON.stringify(proposal) });
  if (!updated) return raceLost(interaction);
  const built = await buildComboBuilder(updated, proposal);
  await interaction.reply({ ...built, flags: MessageFlags.Ephemeral });
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
  const next: ComboProposal = { ...proposal, deck };
  const updated = await updateSession(session, { customComboProposal: JSON.stringify(next) });
  if (!updated) return raceLost(interaction);
  const built = await buildComboBuilder(updated, next);
  await interaction.update(built);
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
  const next: ComboProposal = { ...proposal, stake };
  const updated = await updateSession(session, { customComboProposal: JSON.stringify(next) });
  if (!updated) return raceLost(interaction);
  const built = await buildComboBuilder(updated, next);
  await interaction.update(built);
}

// Submit → flip to "pending". Closes the proposer's ephemeral builder and
// surfaces the proposal on the PUBLIC message for the opponent.
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
  // Admin override: an admin's proposal auto-applies to the current game (no
  // opponent accept step) — a fast manual set-up for a stuck match.
  if (ctx.asAdmin) {
    const gameNum = banPhaseGameNum(session.state);
    if (gameNum === 0) return reply(interaction, "Not in a ban phase.");
    const gameField = `game${gameNum}` as "game1" | "game2" | "game3";
    const currentGame = parseGame(session[gameField]);
    if (!currentGame) return reply(interaction, `Game ${gameNum} state missing — refresh Discord and try again.`);
    const combo = { deck: proposal.deck, stake: proposal.stake };
    const newGame: GameState = { firstId: currentGame.firstId, bans: [], pool: [combo], pickedDeckIdx: 0 };
    const playingState =
      gameNum === 1 ? MatchSessionState.GAME_1_PLAYING :
      gameNum === 2 ? MatchSessionState.GAME_2_PLAYING :
      MatchSessionState.GAME_3_PLAYING;
    const applied = await updateSession(session, {
      customComboProposal: null,
      [gameField]: JSON.stringify(newGame),
      state: playingState,
    } as Prisma.MatchSessionUpdateManyMutationInput);
    if (!applied) return raceLost(interaction);
    recordAudit({
      actor: { discordId: interaction.user.id, displayName: interaction.user.username },
      action: "match.admin-combo",
      targetType: "MatchSession",
      targetId: session.id,
      summary: `Admin set custom combo ${combo.deck} / ${combo.stake} for game ${gameNum}`,
      metadata: combo,
    });
    await interaction.update({
      embeds: [new EmbedBuilder().setTitle("✅ Combo applied").setColor(0x2ecc71).setDescription(`Set **${combo.deck} / ${combo.stake}** for game ${gameNum}.`)],
      components: [],
    });
    await refreshPublicMatchMessage(interaction, applied);
    return;
  }
  const updated = await updateSession(session, {
    customComboProposal: JSON.stringify({ ...proposal, status: "pending" }),
  });
  if (!updated) return raceLost(interaction);
  const sentEmbed = new EmbedBuilder()
    .setTitle("✅ Proposal sent")
    .setColor(0x2ecc71)
    .setDescription(`Proposed **${proposal.deck} / ${proposal.stake}** — waiting on ${sanitizeName(ctx.other.displayName)} to respond.`);
  await interaction.update({ embeds: [sentEmbed], components: [] });
  await refreshPublicMatchMessage(interaction, updated);
}

// Counter → the responder takes over the proposal. Re-opens the builder
// as THEIR private ephemeral and clears the public pending proposal (back
// to the ban UI) so it isn't sitting there mid-counter.
async function handleProposeCounter(interaction: ButtonInteraction, session: MatchSession) {
  if (banPhaseGameNum(session.state) === 0) return reply(interaction, "Not in a ban phase.");
  const proposal = parseProposal(session.customComboProposal);
  if (!proposal || proposal.status !== "pending") {
    return reply(interaction, "No pending proposal to counter.");
  }
  const ctx = await actorPlayer(interaction, session);
  if (!ctx) return;
  if (!ctx.asAdmin && proposal.by === ctx.actor.id) {
    return reply(interaction, "You're the proposer — wait for your opponent's response.");
  }
  // Flip ownership to the actor, drop the picks, back to building.
  const next: ComboProposal = { by: ctx.actor.id, status: "building" };
  const updated = await updateSession(session, { customComboProposal: JSON.stringify(next) });
  if (!updated) return raceLost(interaction);
  const built = await buildComboBuilder(updated, next);
  await interaction.reply({ ...built, flags: MessageFlags.Ephemeral });
  await refreshPublicMatchMessage(interaction, updated);
}

async function handleProposeCancel(interaction: ButtonInteraction, session: MatchSession) {
  if (banPhaseGameNum(session.state) === 0) return reply(interaction, "Not in a ban phase.");
  const proposal = parseProposal(session.customComboProposal);
  if (!proposal) {
    return reply(interaction, "No proposal to cancel.");
  }
  const ctx = await actorPlayer(interaction, session);
  if (!ctx) return;
  const updated = await updateSession(session, { customComboProposal: null });
  if (!updated) return raceLost(interaction);
  // Building cancel comes from the proposer's ephemeral builder — dismiss
  // it (the public message was never changed). Pending cancel comes from
  // the public proposal — re-render the public message back to the ban UI.
  if (proposal.status === "building") {
    const embed = new EmbedBuilder()
      .setTitle("Proposal cancelled")
      .setColor(0x95a5a6)
      .setDescription("No combo proposed — back to the ban phase.");
    await interaction.update({ embeds: [embed], components: [] });
  } else {
    await refreshMessage(interaction, updated);
  }
}

// Mutual-consent cancel — one button on the helper row, no ephemeral
// menu. The two clicks (yours + your opponent's) ARE the confirmation,
// so there's no separate confirm step:
//   - first click records your vote and pings the opponent
//   - clicking again withdraws your vote
//   - the opponent's click drops the match
async function handleCancelVote(interaction: ButtonInteraction, session: MatchSession) {
  await ackFast(interaction);
  if (session.state === "CANCELLED" || session.state === "COMPLETE" || session.state === "PAUSED") {
    return reply(interaction, "This match isn't active.");
  }
  const { playerA, playerB } = await loadPlayers(session);
  if (interaction.user.id !== playerA.discordId && interaction.user.id !== playerB.discordId) {
    // Admins can cancel in-progress matches unilaterally — a single click ends
    // it, no second vote. Same effect as the /admin cancel-match slash command
    // but straight from the thread's Cancel button.
    if (await isMatchAdmin(interaction)) {
      return finalizeCancel(interaction, session, true);
    }
    return reply(interaction, "Only the two players in this match (or an admin) can cancel it.");
  }
  const voterId = interaction.user.id === playerA.discordId ? session.playerAId : session.playerBId;

  // Opponent already voted → this click is the second vote → drop it.
  if (session.cancelInitiatorPlayerId && session.cancelInitiatorPlayerId !== voterId) {
    return finalizeCancel(interaction, session);
  }
  // You already voted → clicking again withdraws.
  if (session.cancelInitiatorPlayerId === voterId) {
    const updated = await updateSession(session, {
      cancelInitiatorPlayerId: null,
      cancelInitiatedAt: null,
    });
    if (!updated) return raceLost(interaction);
    await refreshMessage(interaction, updated);
    return reply(interaction, "Cancel vote withdrawn — match continues.");
  }
  // First vote.
  const updated = await updateSession(session, {
    cancelInitiatorPlayerId: voterId,
    cancelInitiatedAt: new Date(),
  });
  if (!updated) return raceLost(interaction);
  await refreshMessage(interaction, updated);
  return reply(interaction, "You voted to cancel — your opponent has to click Cancel match too.");
}

// Flip to CANCELLED, record audit, re-render, close the thread. Called from
// the opponent's second cancel click (mutual consent), OR from an admin's
// single click (asAdmin=true — unilateral, audited to the acting admin).
async function finalizeCancel(interaction: ButtonInteraction, session: MatchSession, asAdmin = false) {
  const updated = await updateSession(session, {
    state: MatchSessionState.CANCELLED,
    cancelInitiatorPlayerId: null,
    cancelInitiatedAt: null,
  });
  if (!updated) return raceLost(interaction);
  recordAudit({
    actor: asAdmin ? actorFromInteractionUser(interaction.user) : SYSTEM_ACTOR,
    action: asAdmin ? "match.cancel-admin" : "match.cancel-player",
    targetType: "MatchSession",
    targetId: updated.id,
    summary: asAdmin
      ? `Admin cancelled match ${updated.id.slice(-6)} (was ${session.state})`
      : `Both players agreed to cancel match ${updated.id.slice(-6)}`,
    metadata: {
      previousState: session.state,
      playerAId: session.playerAId,
      playerBId: session.playerBId,
    },
  });
  await refreshMessage(interaction, updated);
  if (asAdmin) await reply(interaction, "Match cancelled (admin).");
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
  // Admin can accept on either player's behalf; players can only accept the
  // OTHER player's proposal.
  if (!ctx.asAdmin && proposal.by === ctx.actor.id) {
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

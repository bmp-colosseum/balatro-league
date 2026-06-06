// Renders the embed + button rows for the current state of a match session.
// Called any time the session transitions state.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { MatchSession, Player } from "@prisma/client";
import {
  CANONICAL_DECKS,
  canonicalDeckIndex,
  canonicalStakeIndex,
  deckDescription,
  stakeDescription,
} from "./balatro-info.js";
import { deckEmoji, deckEmojiPartial, stakeEmoji, stakeEmojiPartial } from "./balatro-emojis.js";
import { parsePolicy, phaseFor, remainingCombos, type GameState } from "./match-session.js";
import type { DeckEntry } from "./match-config.js";

function parseGame(json: string | null): GameState | null {
  if (!json) return null;
  try { return JSON.parse(json) as GameState; } catch { return null; }
}

// Components row can hold buttons OR a string-select menu — ban phase
// renders both (a select menu row + a confirm button row), other phases
// render only buttons. The Discord.js MessageComponentBuilder covers it.
type ComponentRow = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;

export interface RenderOptions {
  // Allowed stakes for the custom-combo proposal stake select menu.
  // Only consulted in GAME_1_BAN when a proposal is being built; ignored
  // otherwise. Defaults to empty (no proposal UI possible without it).
  allowedStakes?: string[];
}

export function renderMatch(
  session: MatchSession,
  playerA: Player,
  playerB: Player,
  opts: RenderOptions = {},
): { embeds: EmbedBuilder[]; components: ComponentRow[]; content: string } {
  const game1 = parseGame(session.game1);
  const game2 = parseGame(session.game2);
  const game3 = parseGame(session.game3);

  const bare = (() => {
    if (session.state === "WAITING_ACCEPT") {
      return withHelperRow(session, renderWaitingAccept(session, playerA, playerB));
    }
    if (session.state === "GAME_2_CHOOSE_FIRST") {
      return withHelperRow(session, renderChooseFirst(session, playerA, playerB, game1));
    }
    if (session.state === "COMPLETE") {
      return renderComplete(session, playerA, playerB, game1, game2);
    }
    if (session.state === "CANCELLED") {
      return renderCancelled(session, playerA, playerB);
    }
    if (session.state === "PAUSED") {
      return renderPaused(session, playerA, playerB);
    }

    // Game 1 / 2 / 3 phases
    const gameNum: 1 | 2 | 3 = session.state.startsWith("GAME_1") ? 1
      : session.state.startsWith("GAME_2") ? 2 : 3;
    const game = gameNum === 1 ? game1 : gameNum === 2 ? game2 : game3;
    // GAME_N_CHOOSE_FIRST is rendered by a separate path
    if (session.state === "GAME_3_CHOOSE_FIRST") {
      return withHelperRow(session, renderChooseFirst(session, playerA, playerB, game2));
    }
    if (!game) return renderError(session, playerA, playerB, "Game state missing");
    return withHelperRow(session, renderGame(session, playerA, playerB, game.pool, game, gameNum, opts));
  })();

  const content = computeActiveContent(session, playerA, playerB, game1, game2, game3);
  return { embeds: bare.embeds, components: bare.components, content };
}

// Build the message-level content line that pings whoever's expected
// to act next. Discord re-fires push notifications whenever an edit
// introduces a new mention, so re-rendering with a different active
// player on each transition gives the next player a fresh ping (and
// the same content across no-op refreshes doesn't ping anyone). The
// embed itself remains the canonical source for "what to do" — this
// is just the loud nudge.
function computeActiveContent(
  s: MatchSession,
  a: Player,
  b: Player,
  g1: GameState | null,
  g2: GameState | null,
  g3: GameState | null,
): string {
  // Cancel vote pending overrides the normal turn-based ping — the
  // OTHER player needs to either confirm and drop the match, or
  // ignore it and keep playing. That decision is more urgent than
  // whoever's mid-turn, so it takes precedence.
  if (s.cancelInitiatorPlayerId && s.state !== "CANCELLED" && s.state !== "COMPLETE") {
    const initiator = s.cancelInitiatorPlayerId === a.id ? a : b;
    const opposingDc = s.cancelInitiatorPlayerId === a.id ? b.discordId : a.discordId;
    return `<@${opposingDc}> ⛔ **${initiator.displayName}** wants to cancel — click **Cancel match** to agree, or just keep playing.`;
  }
  // Pause vote pending — ping the other player so it's not just a silent
  // button swap. Same precedence idea as cancel.
  if (s.pauseInitiatorPlayerId && s.state !== "PAUSED" && s.state !== "CANCELLED" && s.state !== "COMPLETE") {
    const initiator = s.pauseInitiatorPlayerId === a.id ? a : b;
    const opposingDc = s.pauseInitiatorPlayerId === a.id ? b.discordId : a.discordId;
    return `<@${opposingDc}> ⏸️ **${initiator.displayName}** wants to pause — click **Pause** to agree, or keep playing.`;
  }
  switch (s.state) {
    case "WAITING_ACCEPT":
      return `<@${b.discordId}> 🎴 match invite from <@${a.discordId}> — accept or decline.`;
    case "GAME_2_CHOOSE_FIRST": {
      if (!g1?.winnerId) return "";
      const loserDc = g1.winnerId === a.id ? b.discordId : a.discordId;
      return `<@${loserDc}> 🎯 you lost game 1 — pick who bans first in game 2.`;
    }
    case "GAME_3_CHOOSE_FIRST": {
      if (!g2?.winnerId) return "";
      const loserDc = g2.winnerId === a.id ? b.discordId : a.discordId;
      return `<@${loserDc}> 🎯 game 3 tiebreaker — pick who bans first.`;
    }
    case "GAME_1_BAN":
    case "GAME_2_BAN":
    case "GAME_3_BAN": {
      const game = s.state.startsWith("GAME_1") ? g1 : s.state.startsWith("GAME_2") ? g2 : g3;
      if (!game) return "";
      // A custom-combo proposal in flight changes who's expected to
      // act — the OTHER player has to accept/counter. Bare-ban phase
      // pings the active banner.
      const proposal = parseProposalForRender(s.customComboProposal);
      if (proposal?.status === "pending") {
        const targetDc = proposal.by === a.id ? b.discordId : a.discordId;
        return `<@${targetDc}> 🎯 custom combo proposed — accept, counter, or cancel.`;
      }
      // Reroll vote pending (exactly one player voted) — ping the OTHER
      // player to confirm or keep banning, instead of leaving it as a
      // silent button-label change they might not notice.
      if (Boolean(game.rerollVoteByA) !== Boolean(game.rerollVoteByB)) {
        const voterIsA = Boolean(game.rerollVoteByA);
        const voter = voterIsA ? a : b;
        const opposingDc = voterIsA ? b.discordId : a.discordId;
        return `<@${opposingDc}> 🔄 **${voter.displayName}** wants to reroll the pool — click **Confirm reroll** to agree, or keep banning.`;
      }
      const phase = phaseFor(game, a.id, b.id, parsePolicy(s.policy));
      if (phase.kind !== "BAN") return "";
      const dc = phase.whoseBanId === a.id ? a.discordId : b.discordId;
      return `<@${dc}> 🎯 your turn — ban ${phase.remainingForThem} combo(s).`;
    }
    case "GAME_1_PICK":
    case "GAME_2_PICK":
    case "GAME_3_PICK": {
      const game = s.state.startsWith("GAME_1") ? g1 : s.state.startsWith("GAME_2") ? g2 : g3;
      if (!game) return "";
      const phase = phaseFor(game, a.id, b.id, parsePolicy(s.policy));
      if (phase.kind !== "PICK") return "";
      const dc = phase.pickerId === a.id ? a.discordId : b.discordId;
      return `<@${dc}> 🎯 your turn — pick the deck/stake.`;
    }
    case "GAME_1_PLAYING":
    case "GAME_2_PLAYING":
    case "GAME_3_PLAYING":
      // Both players are expected to play the run and vote a winner.
      // Mention once — Discord won't re-ping if the same content
      // shows up across no-op refreshes.
      return `<@${a.discordId}> <@${b.discordId}> 🎮 play the run, then vote for the winner.`;
    case "PAUSED": {
      // Resume vote pending — ping the other player to agree.
      if (s.resumeInitiatorPlayerId) {
        const initiator = s.resumeInitiatorPlayerId === a.id ? a : b;
        const opposingDc = s.resumeInitiatorPlayerId === a.id ? b.discordId : a.discordId;
        return `<@${opposingDc}> ▶️ **${initiator.displayName}** wants to resume — click **Resume** to continue.`;
      }
      return "";
    }
    case "COMPLETE":
    case "CANCELLED":
      return "";
    default:
      return "";
  }
}

// Append the universal "🆘 Call helper" button as the LAST row on any
// non-terminal match render. Discord caps message components at 5
// action rows; the busiest phase (ban) currently uses 3, so we have
// headroom. If a future phase ever pushes past 5, this drops the
// helper row off — that's an acceptable degradation since /helper is
// also a slash command.
function withHelperRow(
  session: MatchSession,
  rendered: { embeds: EmbedBuilder[]; components: ComponentRow[] },
): { embeds: EmbedBuilder[]; components: ComponentRow[] } {
  if (rendered.components.length >= 5) return rendered;
  const extras: ButtonBuilder[] = [];
  // Cancel is universal — any non-terminal, non-paused state. Confirms
  // via an ephemeral menu to avoid accidental clicks. Label flips when
  // a vote is already in flight so the action is obvious.
  if (
    session.state !== "WAITING_ACCEPT" &&
    session.state !== "COMPLETE" &&
    session.state !== "CANCELLED" &&
    session.state !== "PAUSED"
  ) {
    extras.push(
      new ButtonBuilder()
        .setCustomId(`match:cancelmatch:${session.id}`)
        .setLabel(session.cancelInitiatorPlayerId ? "⛔ Cancel match (1/2)" : "⛔ Cancel match")
        .setStyle(session.cancelInitiatorPlayerId ? ButtonStyle.Danger : ButtonStyle.Secondary),
    );
  }
  // Pause is offered any time after game 1's winner is recorded — i.e.
  // game-2 / game-3 phases. Before that, the right path is cancel.
  // After PAUSED, the resume button lives on the paused embed.
  if (
    session.state === "GAME_2_CHOOSE_FIRST" ||
    session.state === "GAME_2_BAN" ||
    session.state === "GAME_2_PICK" ||
    session.state === "GAME_2_PLAYING" ||
    session.state === "GAME_3_CHOOSE_FIRST" ||
    session.state === "GAME_3_BAN" ||
    session.state === "GAME_3_PICK" ||
    session.state === "GAME_3_PLAYING"
  ) {
    extras.push(
      new ButtonBuilder()
        .setCustomId(`match:pause:${session.id}`)
        .setLabel(session.pauseInitiatorPlayerId ? "⏸️ Pause (1/2)" : "⏸️ Pause")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  extras.push(
    new ButtonBuilder()
      .setCustomId(`match:callhelper:${session.id}`)
      .setLabel("🆘 Call helper")
      .setStyle(ButtonStyle.Secondary),
  );
  const helperRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...extras);
  return { embeds: rendered.embeds, components: [...rendered.components, helperRow] };
}

// Decode session.customComboProposal (JSON). Match-render only needs the
// shape — the source of truth for the type lives in match-buttons.ts.
interface ProposalForRender {
  by: string;
  deck?: string;
  stake?: string;
  status: "building" | "pending";
}

function parseProposalForRender(json: string | null): ProposalForRender | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (
      v &&
      typeof v.by === "string" &&
      (v.status === "building" || v.status === "pending")
    ) {
      const out: ProposalForRender = { by: v.by, status: v.status };
      if (typeof v.deck === "string") out.deck = v.deck;
      if (typeof v.stake === "string") out.stake = v.stake;
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

function mention(player: Player): string {
  return `<@${player.discordId}>`;
}

function renderWaitingAccept(s: MatchSession, a: Player, b: Player) {
  const modeLine = s.isCasual
    ? `Casual challenge · **Best of ${s.bestOf}** · not recorded to the league.`
    : `League set (best of 2) · recorded to standings.`;
  // Custom-combo invites tell the opponent what they're agreeing to up
  // front. Accepting = both players agree to this deck/stake instead of
  // running the ban/pick flow.
  let comboLine = "";
  if (s.customCombo) {
    try {
      const c = JSON.parse(s.customCombo) as { deck?: string; stake?: string };
      if (c.deck && c.stake) {
        const deckIcon = deckEmoji(c.deck) ?? "";
        const stakeIcon = stakeEmoji(c.stake) ?? "";
        const icons = [deckIcon, stakeIcon].filter(Boolean).join(" ");
        comboLine =
          `\n\n🎯 **Agreed combo** (skips ban/pick): ${icons ? `${icons} ` : ""}**${c.deck} / ${c.stake}**`;
      }
    } catch {
      // ignore — malformed customCombo just doesn't render
    }
  }
  const embed = new EmbedBuilder()
    .setTitle(s.isCasual ? "🎴 Challenge" : "🎴 Match invite")
    .setDescription(
      `${mention(a)} wants to play ${mention(b)}.\n` +
        `${modeLine}` +
        comboLine +
        `\n\n${mention(b)}, accept within 5 minutes to start.`,
    )
    .setColor(s.isCasual ? 0x95a5a6 : 0x5865f2)
    .setFooter({ text: `Match ${s.id}` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`match:accept:${s.id}`).setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`match:decline:${s.id}`).setLabel("Decline").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

function renderChooseFirst(s: MatchSession, a: Player, b: Player, g1: GameState | null) {
  if (!g1?.winnerId) return renderError(s, a, b, "Game 1 winner missing");
  const loserId = g1.winnerId === a.id ? b.id : a.id;
  const loser = loserId === a.id ? a : b;
  const embed = new EmbedBuilder()
    .setTitle("🎯 Game 2 — choose who bans first")
    .setDescription(`${mention(loser)} lost game 1. They pick who bans first in game 2.`)
    .setColor(0xf1c40f);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:choosefirst:${s.id}:${a.id}`)
      .setLabel(`${a.displayName} bans first`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`match:choosefirst:${s.id}:${b.id}`)
      .setLabel(`${b.displayName} bans first`)
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

function renderGame(s: MatchSession, a: Player, b: Player, pool: DeckEntry[], game: GameState, gameNumber: 1 | 2 | 3, opts: RenderOptions = {}) {
  const policy = parsePolicy(s.policy);
  const phase = phaseFor(game, a.id, b.id, policy);
  const first = game.firstId === a.id ? a : b;
  const otherPlayer = game.firstId === a.id ? b : a;
  const remaining = remainingCombos(pool, game.bans);
  const colors = { 1: 0x3498db, 2: 0x9b59b6, 3: 0xe67e22 };
  const modeLabel = s.isCasual ? `Casual · Best of ${s.bestOf}` : "League";

  const embed = new EmbedBuilder()
    .setTitle(`🎮 Game ${gameNumber} — ${modeLabel}`)
    .setColor(colors[gameNumber])
    .setFooter({ text: `Match ${s.id}` });

  // Game-1 ban phase: if a custom-combo proposal is in flight, replace
  // the ban dropdown UI with the proposal UI. Either player can also
  // KICK OFF a proposal from the ban phase via the "Propose custom
  // combo" button — when no proposal exists, that button is appended
  // to the normal ban controls.
  if (phase.kind === "BAN") {
    const proposal = parseProposalForRender(s.customComboProposal);
    if (proposal) {
      return renderProposal(s, a, b, proposal, opts.allowedStakes ?? []);
    }
  }

  if (phase.kind === "BAN") {
    const whose = phase.whoseBanId === a.id ? a : b;
    const expected = phase.remainingForThem;
    // The select menu lives directly on the PUBLIC message. Discord
    // never syncs in-progress dropdown selections to other viewers, so
    // the off-turn player sees the menu + placeholder but not what the
    // active banner is choosing. Selecting opens an EPHEMERAL confirm
    // (renderBanConfirmPrompt) visible only to the banner — that's the
    // private review surface. We show only what's LEFT in the pool — the
    // dropdown options need it anyway, and there's no need to spell out
    // what's already gone.
    const sortedRemaining = [...remaining].sort((x, y) => {
      const sd = canonicalStakeIndex(x.combo.stake) - canonicalStakeIndex(y.combo.stake);
      if (sd !== 0) return sd;
      return canonicalDeckIndex(x.combo.deck) - canonicalDeckIndex(y.combo.deck);
    });
    const poolLines = sortedRemaining.map(({ combo }, i) => {
      const di = deckEmoji(combo.deck) ?? "";
      const si = stakeEmoji(combo.stake) ?? "";
      const icons = [di, si].filter(Boolean).join(" ");
      return `${i + 1}. ${icons ? `${icons} ` : ""}${combo.deck} / ${combo.stake}`;
    });
    embed.setDescription(
      `🎯 **${whose.displayName}** is banning — pick **${expected}**.\n\n` +
        `**Pool (${sortedRemaining.length} left):**\n` +
        poolLines.join("\n"),
    );
    const rerollLabel =
      game.rerollVoteByA || game.rerollVoteByB
        ? "Confirm reroll"
        : "Reroll pool";
    // Public select menu (min=max=expected). The actor guard lives in
    // the handler; non-actors who touch it get an ephemeral "not your
    // turn" and the public message is left untouched.
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`match:banselect:${s.id}`)
      .setPlaceholder(`${whose.displayName}: pick ${expected} to ban`)
      .setMinValues(expected)
      .setMaxValues(expected)
      .addOptions(
        sortedRemaining.map(({ idx, combo }) => {
          const deckDesc = deckDescription(combo.deck);
          const stakeDesc = stakeDescription(combo.stake);
          let desc = deckDesc ?? "";
          if (stakeDesc && desc.length + stakeDesc.length + 12 <= 100) {
            desc = desc ? `${desc} · ${combo.stake}: ${stakeDesc}` : `${combo.stake}: ${stakeDesc}`;
          }
          return {
            label: `${combo.deck} / ${combo.stake}`,
            value: String(idx),
            description: desc ? desc.slice(0, 100) : undefined,
            emoji: deckEmojiPartial(combo.deck),
          };
        }),
      );
    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
    // Random ban auto-rolls the active banner's picks into the same
    // confirm prompt (still a deliberate confirm, just no manual
    // choosing). Reroll + Propose are shared-action buttons either
    // player can click. Cancel/pause/helper live on the helper row.
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`match:banrandom:${s.id}`)
        .setLabel(`🎲 Random ban${expected > 1 ? "s" : ""}`)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`match:reroll:${s.id}`)
        .setLabel(rerollLabel)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`match:proposestart:${s.id}`)
        .setLabel("Propose custom combo")
        .setStyle(ButtonStyle.Secondary),
    );
    return {
      embeds: [embed],
      components: [selectRow, actionRow],
    };
  }

  if (phase.kind === "PICK") {
    const picker = phase.pickerId === a.id ? a : b;
    // Sort: stake difficulty first, then deck A-Z. Same grouping as
    // the ban menu above (and BMP) so the pick options sit in the
    // same visual order players already scanned.
    const sortedPickRemaining = [...remaining].sort((x, y) => {
      const s = canonicalStakeIndex(x.combo.stake) - canonicalStakeIndex(y.combo.stake);
      if (s !== 0) return s;
      return canonicalDeckIndex(x.combo.deck) - canonicalDeckIndex(y.combo.deck);
    });
    // Spell out each remaining combo's deck + stake effects in the embed
    // so picker has full info without hovering a tooltip somewhere. Both
    // deck and stake emojis render inline (Discord embed text has no
    // one-emoji limit like select options do).
    const optionLines = sortedPickRemaining.map(({ combo }, i) => {
      const deckDesc = deckDescription(combo.deck);
      const stakeDesc = stakeDescription(combo.stake);
      const deckIcon = deckEmoji(combo.deck) ?? "";
      const stakeIcon = stakeEmoji(combo.stake) ?? "";
      const icons = [deckIcon, stakeIcon].filter(Boolean).join(" ");
      const iconPrefix = icons ? `${icons} ` : "";
      return (
        `**${i + 1}. ${iconPrefix}${combo.deck} / ${combo.stake}**` +
        (deckDesc ? `\n  · ${combo.deck}: ${deckDesc}` : "") +
        (stakeDesc ? `\n  · ${combo.stake} stake: ${stakeDesc}` : "")
      );
    });
    embed.setDescription(
      `Bans done. **${picker.displayName}** picks the deck for this game from the 2 remaining.\n\n` +
        optionLines.join("\n\n"),
    );
    const rows = chunkButtons(
      sortedPickRemaining.map(({ idx, combo }) => {
        const btn = new ButtonBuilder()
          .setCustomId(`match:pick:${s.id}:${idx}`)
          .setLabel(`${combo.deck} / ${combo.stake}`)
          .setStyle(ButtonStyle.Success);
        const deckIcon = deckEmojiPartial(combo.deck);
        if (deckIcon) btn.setEmoji({ id: deckIcon.id, name: deckIcon.name, animated: deckIcon.animated });
        return btn;
      }),
    );
    return { embeds: [embed], components: rows };
  }

  if (phase.kind === "PLAYING") {
    const picked = game.pickedDeckIdx !== undefined ? pool[game.pickedDeckIdx] : null;
    // Per-player vote status line: who voted what. When both votes agree
    // the match auto-advances (this render only fires while voting is
    // incomplete or disputed).
    const voteLine = (vote: string | undefined, who: Player) => {
      if (!vote) return `· **${who.displayName}**: not voted`;
      const target = vote === a.id ? a.displayName : b.displayName;
      return `· **${who.displayName}**: voted ${target}`;
    };
    let description = `🎲 Playing: **${picked?.deck ?? "?"} / ${picked?.stake ?? "?"} stake**\n\n`;
    if (game.disputed) {
      description +=
        `⚠️ **Disputed** — players voted for different winners.\n` +
        `${voteLine(game.voteByA, a)}\n` +
        `${voteLine(game.voteByB, b)}\n\n` +
        `Talk it out and click again, OR ask an admin to step in and fix the result.`;
    } else if (game.voteByA || game.voteByB) {
      description +=
        `Vote for the winner. Match advances when both agree.\n` +
        `${voteLine(game.voteByA, a)}\n` +
        `${voteLine(game.voteByB, b)}`;
    } else {
      description += `Both players vote: click who won. Match advances when you agree.`;
    }
    embed.setDescription(description);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`match:winner:${s.id}:${a.id}`)
        .setLabel(`${a.displayName} won`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`match:winner:${s.id}:${b.id}`)
        .setLabel(`${b.displayName} won`)
        .setStyle(ButtonStyle.Primary),
    );
    // DC button. For shootouts, the click handler refuses the auto-
    // forfeit and explains admin review is needed — we still surface
    // the button so players know the path exists.
    const dcRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`match:dc:${s.id}`)
        .setLabel("Opponent DC'd")
        .setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row, dcRow] };
  }

  // Done — shouldn't reach here mid-game
  void otherPlayer;
  embed.setDescription("Game complete.");
  return { embeds: [embed], components: [] };
}

function renderComplete(s: MatchSession, a: Player, b: Player, g1: GameState | null, g2: GameState | null) {
  const g3 = parseGame(s.game3);
  const aWins =
    (g1?.winnerId === a.id ? 1 : 0) +
    (g2?.winnerId === a.id ? 1 : 0) +
    (g3?.winnerId === a.id ? 1 : 0);
  const bWins =
    (g1?.winnerId === b.id ? 1 : 0) +
    (g2?.winnerId === b.id ? 1 : 0) +
    (g3?.winnerId === b.id ? 1 : 0);
  const verdict =
    aWins > bWins ? `🏆 ${a.displayName} ${aWins}-${bWins} ${b.displayName}` :
    bWins > aWins ? `🏆 ${b.displayName} ${bWins}-${aWins} ${a.displayName}` :
    `🤝 ${a.displayName} ${aWins}-${bWins} ${b.displayName}`;
  const tail = s.isCasual
    ? "Casual match — not recorded to the league."
    : "Result recorded. If something looks wrong, ask an admin to override.";
  const embed = new EmbedBuilder()
    .setTitle("✅ Match complete")
    .setDescription(`${verdict}\n${tail}`)
    .setColor(0x2ecc71)
    .setFooter({ text: `Match ${s.id}` });
  return { embeds: [embed], components: [] };
}

// Build the EPHEMERAL confirm prompt shown only to the active banner
// after they select from the public ban dropdown. This is the private
// review surface: the banner sees exactly what they're about to ban and
// commits with one click; the opponent never sees any of it. The chosen
// indices ride in the Confirm button's customId, so there's no tentative
// server state to store or leak.
export function renderBanConfirmPrompt(args: {
  sessionId: string;
  gameNumber: 1 | 2 | 3;
  pool: DeckEntry[];
  selected: number[];
}): { embeds: EmbedBuilder[]; components: ComponentRow[] } {
  const { sessionId, gameNumber, pool, selected } = args;
  const label = (idx: number): string | null => {
    const combo = pool[idx];
    if (!combo) return null;
    const di = deckEmoji(combo.deck) ?? "";
    const si = stakeEmoji(combo.stake) ?? "";
    const icons = [di, si].filter(Boolean).join(" ");
    return `${icons ? `${icons} ` : ""}${combo.deck} / ${combo.stake}`;
  };
  const selLabels = selected.map(label).filter((x): x is string => !!x);

  const embed = new EmbedBuilder()
    .setTitle(`🎯 Confirm your ban${selected.length > 1 ? "s" : ""} — Game ${gameNumber}`)
    .setColor(0xe74c3c)
    .setDescription(
      `You're about to ban:\n${selLabels.map((l) => `• **${l}**`).join("\n")}`,
    )
    .setFooter({ text: `Match ${sessionId}` });

  const idxStr = selected.join(".");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:banconfirm:${sessionId}:${idxStr}`)
      .setLabel(`Confirm ban${selected.length > 1 ? "s" : ""}`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`match:bancancel:${sessionId}`)
      .setLabel("Pick again")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

function renderCancelled(s: MatchSession, a: Player, b: Player) {
  const embed = new EmbedBuilder()
    .setTitle("❌ Match cancelled")
    .setDescription(`${mention(a)} vs ${mention(b)} — match was cancelled or timed out.`)
    .setColor(0xe74c3c)
    .setFooter({ text: `Match ${s.id}` });
  return { embeds: [embed], components: [] };
}

function renderPaused(s: MatchSession, a: Player, b: Player) {
  const pausedAt = s.pausedAt ? `<t:${Math.floor(s.pausedAt.getTime() / 1000)}:R>` : "recently";
  const waitingOn =
    s.resumeInitiatorPlayerId === a.id
      ? `Waiting on ${mention(b)} to click Resume.`
      : s.resumeInitiatorPlayerId === b.id
        ? `Waiting on ${mention(a)} to click Resume.`
        : "Both players click Resume to continue.";
  const embed = new EmbedBuilder()
    .setTitle("⏸️ Match paused")
    .setDescription(
      `${mention(a)} vs ${mention(b)} — paused ${pausedAt}.\n\n` +
        `${waitingOn}\n\n` +
        `_Auto-cancels in 7 days if nobody resumes._`,
    )
    .setColor(0x95a5a6)
    .setFooter({ text: `Match ${s.id}` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:resume:${s.id}`)
      .setLabel(s.resumeInitiatorPlayerId ? "▶️ Resume (1/2)" : "▶️ Resume")
      .setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row] };
}

function renderError(s: MatchSession, a: Player, b: Player, msg: string) {
  const embed = new EmbedBuilder()
    .setTitle("⚠️ Match error")
    .setDescription(`${msg}. Ask an admin to look at session ${s.id}.`)
    .setColor(0xe74c3c);
  void a; void b;
  return { embeds: [embed], components: [] };
}

// Custom-combo negotiation UI rendered inside the GAME_1_BAN phase.
// Two sub-states:
//   building — proposer is still picking deck/stake (select menus + Submit/Cancel)
//   pending  — proposal locked in, waiting for other player (Accept/Counter/Cancel)
// Stake select pulls from the season's preset (`allowedStakes`); decks
// can be ANY canonical deck from the full library per the project rules
// (deck = open library, stake = preset-constrained).
function renderProposal(
  s: MatchSession,
  a: Player,
  b: Player,
  proposal: ProposalForRender,
  allowedStakes: string[],
): { embeds: EmbedBuilder[]; components: ComponentRow[] } {
  const proposer = proposal.by === a.id ? a : b;
  const responder = proposal.by === a.id ? b : a;
  const deckIcon = proposal.deck ? deckEmoji(proposal.deck) ?? "" : "";
  const stakeIcon = proposal.stake ? stakeEmoji(proposal.stake) ?? "" : "";
  const icons = [deckIcon, stakeIcon].filter(Boolean).join(" ");

  const embed = new EmbedBuilder()
    .setTitle("🎯 Custom combo proposal")
    .setColor(proposal.status === "pending" ? 0xf1c40f : 0x95a5a6)
    .setFooter({ text: `Match ${s.id}` });

  if (proposal.status === "building") {
    embed.setDescription(
      `**${proposer.displayName}** is building a custom combo. Accepting one skips ban/pick — ` +
        `every game of this match uses the agreed deck/stake.\n\n` +
        `Deck: ${proposal.deck ? `${deckIcon} **${proposal.deck}**` : "_not picked_"}\n` +
        `Stake: ${proposal.stake ? `${stakeIcon} **${proposal.stake}**` : "_not picked_"}\n\n` +
        `${proposer.displayName} picks both, then submits. ${responder.displayName} responds with Accept/Counter/Cancel.`,
    );
    // Deck select — full canonical deck library, sorted A-Z.
    const sortedDecks = [...CANONICAL_DECKS].sort((x, y) => x.name.localeCompare(y.name));
    const deckSelect = new StringSelectMenuBuilder()
      .setCustomId(`match:proposedeck:${s.id}`)
      .setPlaceholder(proposal.deck ? `Deck: ${proposal.deck}` : "Pick a deck")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        sortedDecks.slice(0, 25).map((d) => ({
          label: d.name,
          value: d.name,
          description: d.description ? d.description.slice(0, 100) : undefined,
          default: proposal.deck === d.name,
          emoji: deckEmojiPartial(d.name),
        })),
      );
    // Stake select — only stakes the season's preset allows.
    const stakeOptions = allowedStakes.slice(0, 25).map((name) => ({
      label: name,
      value: name,
      description: stakeDescription(name)?.slice(0, 100),
      default: proposal.stake === name,
      emoji: stakeEmojiPartial(name),
    }));
    const stakeSelect = new StringSelectMenuBuilder()
      .setCustomId(`match:proposestake:${s.id}`)
      .setPlaceholder(proposal.stake ? `Stake: ${proposal.stake}` : "Pick a stake")
      .setMinValues(1)
      .setMaxValues(1);
    if (stakeOptions.length > 0) stakeSelect.addOptions(stakeOptions);
    const ready = !!proposal.deck && !!proposal.stake;
    const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`match:proposesubmit:${s.id}`)
        .setLabel(ready ? "Submit proposal" : "Pick deck + stake to submit")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!ready),
      new ButtonBuilder()
        .setCustomId(`match:proposecancel:${s.id}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    );
    const rows: ComponentRow[] = [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(deckSelect),
    ];
    // If preset has no stakes, skip the row — proposer can't pick one.
    if (stakeOptions.length > 0) {
      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(stakeSelect));
    }
    rows.push(actions);
    return { embeds: [embed], components: rows };
  }

  // status === 'pending'
  embed.setDescription(
    `**${proposer.displayName}** proposes:\n\n` +
      `${icons ? `${icons}  ` : ""}**${proposal.deck} / ${proposal.stake}**\n\n` +
      `${responder.displayName}, accept to lock this combo in for all games of the match. ` +
      `Counter to take over the proposal yourself, or cancel to go back to ban/pick.`,
  );
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:proposeaccept:${s.id}`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`match:proposecounter:${s.id}`)
      .setLabel("Counter")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`match:proposecancel:${s.id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [actions] };
}

function chunkButtons(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)));
    if (rows.length >= 5) break; // Discord max 5 rows per message
  }
  return rows;
}

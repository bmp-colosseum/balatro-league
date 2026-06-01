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
import { deckDescription, stakeDescription } from "./balatro-info.js";
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

export function renderMatch(
  session: MatchSession,
  playerA: Player,
  playerB: Player,
): { embeds: EmbedBuilder[]; components: ComponentRow[] } {
  const game1 = parseGame(session.game1);
  const game2 = parseGame(session.game2);

  if (session.state === "WAITING_ACCEPT") {
    return renderWaitingAccept(session, playerA, playerB);
  }
  if (session.state === "GAME_2_CHOOSE_FIRST") {
    return renderChooseFirst(session, playerA, playerB, game1);
  }
  if (session.state === "COMPLETE") {
    return renderComplete(session, playerA, playerB, game1, game2);
  }
  if (session.state === "CANCELLED") {
    return renderCancelled(session, playerA, playerB);
  }

  // Game 1 / 2 / 3 phases
  const gameNum: 1 | 2 | 3 = session.state.startsWith("GAME_1") ? 1
    : session.state.startsWith("GAME_2") ? 2 : 3;
  const game = gameNum === 1 ? game1 : gameNum === 2 ? game2 : parseGame(session.game3);
  // GAME_N_CHOOSE_FIRST is rendered by a separate path
  if (session.state === "GAME_3_CHOOSE_FIRST") {
    return renderChooseFirst(session, playerA, playerB, game2);
  }
  if (!game) return renderError(session, playerA, playerB, "Game state missing");
  return renderGame(session, playerA, playerB, game.pool, game, gameNum);
}

function mention(player: Player): string {
  return `<@${player.discordId}>`;
}

function renderWaitingAccept(s: MatchSession, a: Player, b: Player) {
  const modeLine = s.isCasual
    ? `Casual challenge · **Best of ${s.bestOf}** · not recorded to the league.`
    : `League set (best of 2) · recorded to standings.`;
  const embed = new EmbedBuilder()
    .setTitle(s.isCasual ? "🎴 Challenge" : "🎴 Match invite")
    .setDescription(
      `${mention(a)} wants to play ${mention(b)}.\n` +
        `${modeLine}\n\n` +
        `${mention(b)}, accept within 5 minutes to start.`,
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

function renderGame(s: MatchSession, a: Player, b: Player, pool: DeckEntry[], game: GameState, gameNumber: 1 | 2 | 3) {
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

  if (phase.kind === "BAN") {
    const whose = phase.whoseBanId === a.id ? a : b;
    const expected = phase.remainingForThem;
    const pending = (game.pendingBans ?? []).filter((idx) =>
      remaining.some((r) => r.idx === idx),
    );
    const pendingLabels = pending
      .map((idx) => {
        const combo = pool[idx];
        return combo ? `${combo.deck} / ${combo.stake}` : null;
      })
      .filter((s): s is string => !!s);
    // Single-player reroll request reminder (other player needs to agree).
    const rerollLine =
      game.rerollVoteByA && !game.rerollVoteByB
        ? `\n\n🔄 **${a.displayName}** wants to reroll the pool. **${b.displayName}** click "Confirm reroll" to apply.`
        : !game.rerollVoteByA && game.rerollVoteByB
        ? `\n\n🔄 **${b.displayName}** wants to reroll the pool. **${a.displayName}** click "Confirm reroll" to apply.`
        : "";
    // Game 1's first-ban player is genuinely a coin flip; games 2+ were
    // chosen by the loser of the previous game, so the "(coin toss)" tag
    // is wrong there. Naming the picker would need a lookup into the
    // previous game's winner — keep it simple, just say how it was decided.
    const firstAttribution =
      gameNumber === 1
        ? `**${first.displayName}** bans first (coin toss).`
        : `**${first.displayName}** bans first (chosen by the loser of game ${gameNumber - 1}).`;
    embed.setDescription(
      `${firstAttribution}\n\n` +
        `**${whose.displayName}** to ban — pick **${expected}** combo(s) in the menu, then click Confirm.\n` +
        `Pool: ${remaining.length} combo(s) remaining.` +
        (pendingLabels.length > 0
          ? `\n\n**Pending**: ${pendingLabels.join(", ")} _(not yet applied)_`
          : "") +
        rerollLine,
    );
    // Multi-select dropdown of remaining combos; min == max means Discord
    // enforces an exact count of selections on submit. Default-mark the
    // pending picks so the menu remembers them across re-renders.
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`match:banselect:${s.id}`)
      .setPlaceholder(`Pick ${expected} combo(s) to ban`)
      .setMinValues(expected)
      .setMaxValues(expected)
      .addOptions(
        remaining.map(({ idx, combo }) => {
          // Discord caps option description at 100 chars. Deck effect is
          // the more useful signal for a ban decision; stake just modifies
          // difficulty so we tack on a short tag when both fit.
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
            default: pending.includes(idx),
          };
        }),
      );
    const rerollLabel =
      game.rerollVoteByA || game.rerollVoteByB
        ? "Confirm reroll"
        : "Reroll pool";
    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`match:banconfirm:${s.id}`)
        .setLabel(pending.length === expected ? `Confirm ${expected} ban(s)` : `Select ${expected - pending.length} more…`)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(pending.length !== expected),
      new ButtonBuilder()
        .setCustomId(`match:reroll:${s.id}`)
        .setLabel(rerollLabel)
        .setStyle(ButtonStyle.Secondary),
    );
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
        confirmRow,
      ],
    };
  }

  if (phase.kind === "PICK") {
    const picker = phase.pickerId === a.id ? a : b;
    // Spell out each remaining combo's deck + stake effects in the embed
    // so picker has full info without hovering a tooltip somewhere.
    const optionLines = remaining.map(({ combo }, i) => {
      const deckDesc = deckDescription(combo.deck);
      const stakeDesc = stakeDescription(combo.stake);
      return (
        `**${i + 1}. ${combo.deck} / ${combo.stake}**` +
        (deckDesc ? `\n  · ${combo.deck}: ${deckDesc}` : "") +
        (stakeDesc ? `\n  · ${combo.stake} stake: ${stakeDesc}` : "")
      );
    });
    embed.setDescription(
      `Bans done. **${picker.displayName}** picks the deck for this game from the 2 remaining.\n\n` +
        optionLines.join("\n\n"),
    );
    const rows = chunkButtons(
      remaining.map(({ idx, combo }) =>
        new ButtonBuilder()
          .setCustomId(`match:pick:${s.id}:${idx}`)
          .setLabel(`${combo.deck} / ${combo.stake}`)
          .setStyle(ButtonStyle.Success),
      ),
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
    return { embeds: [embed], components: [row] };
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

function renderCancelled(s: MatchSession, a: Player, b: Player) {
  const embed = new EmbedBuilder()
    .setTitle("❌ Match cancelled")
    .setDescription(`${mention(a)} vs ${mention(b)} — match was cancelled or timed out.`)
    .setColor(0xe74c3c)
    .setFooter({ text: `Match ${s.id}` });
  return { embeds: [embed], components: [] };
}

function renderError(s: MatchSession, a: Player, b: Player, msg: string) {
  const embed = new EmbedBuilder()
    .setTitle("⚠️ Match error")
    .setDescription(`${msg}. Ask an admin to look at session ${s.id}.`)
    .setColor(0xe74c3c);
  void a; void b;
  return { embeds: [embed], components: [] };
}

function chunkButtons(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)));
    if (rows.length >= 5) break; // Discord max 5 rows per message
  }
  return rows;
}

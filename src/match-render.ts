// Renders the embed + button rows for the current state of a match session.
// Called any time the session transitions state.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";

type AnyComponentRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;
import type { MatchSession, Player } from "@prisma/client";
import { phaseFor, remainingCombos, type GameState } from "./match-session.js";
import type { DeckEntry } from "./match-config.js";

function parseGame(json: string | null): GameState | null {
  if (!json) return null;
  try { return JSON.parse(json) as GameState; } catch { return null; }
}
function parsePool(json: string | null): DeckEntry[] {
  if (!json) return [];
  try { return JSON.parse(json) as DeckEntry[]; } catch { return []; }
}

export function renderMatch(
  session: MatchSession,
  playerA: Player,
  playerB: Player,
): { embeds: EmbedBuilder[]; components: AnyComponentRow[] } {
  const pool = parsePool(session.pool);
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

  // Game 1 or 2 phases
  const isGame1 = session.state.startsWith("GAME_1");
  const game = isGame1 ? game1 : game2;
  if (!game) return renderError(session, playerA, playerB, "Game state missing");
  return renderGame(session, playerA, playerB, pool, game, isGame1 ? 1 : 2);
}

function mention(player: Player): string {
  return `<@${player.discordId}>`;
}

function renderWaitingAccept(s: MatchSession, a: Player, b: Player) {
  const embed = new EmbedBuilder()
    .setTitle("🎴 Match invite")
    .setDescription(
      `${mention(a)} wants to play their league set against ${mention(b)}.\n\n` +
        `${mention(b)}, accept within 5 minutes to start the match.`,
    )
    .setColor(0x5865f2)
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

function renderGame(s: MatchSession, a: Player, b: Player, pool: DeckEntry[], game: GameState, gameNumber: 1 | 2) {
  const phase = phaseFor(game, a.id, b.id, pool.length);
  const first = game.firstId === a.id ? a : b;
  const otherPlayer = game.firstId === a.id ? b : a;
  const remaining = remainingCombos(pool, game.bans);

  const embed = new EmbedBuilder()
    .setTitle(`🎮 Game ${gameNumber}`)
    .setColor(gameNumber === 1 ? 0x3498db : 0x9b59b6)
    .setFooter({ text: `Match ${s.id}` });

  if (phase.kind === "BAN") {
    const whose = phase.whoseBanId === a.id ? a : b;
    embed.setDescription(
      `**${first.displayName}** bans first (coin toss).\n\n` +
        `**${whose.displayName}** to ban ${phase.remainingForThem} combo(s) below.\n` +
        `Pool: ${remaining.length} combo(s) remaining.`,
    );
    const select = new StringSelectMenuBuilder()
      .setCustomId(`match:bans:${s.id}`)
      .setPlaceholder(`Select ${phase.remainingForThem} combo(s) to ban`)
      .setMinValues(phase.remainingForThem)
      .setMaxValues(phase.remainingForThem)
      .addOptions(
        remaining.map(({ idx, combo }) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${combo.deck} / ${combo.stake}`)
            .setValue(String(idx)),
        ),
      );
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    return { embeds: [embed], components: [row] };
  }

  if (phase.kind === "PICK") {
    const picker = phase.pickerId === a.id ? a : b;
    embed.setDescription(
      `Bans done. **${picker.displayName}** picks the deck for this game from the 2 remaining.`,
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
    embed.setDescription(
      `🎲 Playing: **${picked?.deck ?? "?"} / ${picked?.stake ?? "?"} stake**\n\n` +
        `Report the winner once the game's done.`,
    );
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
  const aWins = (g1?.winnerId === a.id ? 1 : 0) + (g2?.winnerId === a.id ? 1 : 0);
  const bWins = (g1?.winnerId === b.id ? 1 : 0) + (g2?.winnerId === b.id ? 1 : 0);
  const verdict = aWins === 2 ? `🏆 ${a.displayName} swept ${b.displayName}` :
    bWins === 2 ? `🏆 ${b.displayName} swept ${a.displayName}` :
    `🤝 ${a.displayName} 1-1 ${b.displayName}`;
  const embed = new EmbedBuilder()
    .setTitle("✅ Match complete")
    .setDescription(`${verdict}\nResult recorded. If something looks wrong, ask an admin to override.`)
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

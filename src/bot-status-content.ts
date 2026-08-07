// Shared rendering for a BotHealth snapshot (bot-health.ts). Two audiences
// consume this, and they see DIFFERENT embeds so internal detail never
// leaks to players:
//   - buildHealthEmbed        -- full technical detail (gateway ping, REST
//     p95/error-rate, db latency, stalled queue names). Admin/owner only:
//     /league-bot-status when the caller passes the admin permission check
//     (commands/bot-status.ts).
//   - buildPublicHealthEmbed  -- plain-language, NUMBER-FREE status. Used by
//     the self-updating #bot-status channel message (channel-refresh.ts's
//     refreshBotStatusMessage, which every player can read) and by
//     /league-bot-status for non-admin callers.
// Both surfaces call into this module so admin and player views can never
// silently drift, and so a fix to the wording only has one place to land.
//
// PURE module -- no Discord client, no I/O. buildBotStatusRenderKey
// produces a short deterministic string used ONLY to decide whether the
// channel message needs an edit at all (see channel-refresh.ts) -- it's now
// keyed off exactly what buildPublicHealthEmbed renders, so an internal-only
// change (a queue backlog, ms/percent jitter) never triggers a pointless
// edit for a message players read.

import { EmbedBuilder } from "discord.js";
import { describeAttribution, type BotHealth, type HealthLevel } from "./bot-health.js";
import { isPlayerImpacting } from "./health-broadcast.js";

const LEVEL_COLOR: Record<HealthLevel, number> = {
  ok: 0x57f287,
  degraded: 0xfee75c,
  down: 0xed4245,
};

const LEVEL_EMOJI: Record<HealthLevel, string> = {
  ok: "\u{1F7E2}",
  degraded: "\u{1F7E1}",
  down: "\u{1F534}",
};

function fmtMs(ms: number | null): string {
  return ms === null ? "insufficient data" : `${Math.round(ms)}ms`;
}

function fmtRate(rate: number | null): string {
  return rate === null ? "insufficient data" : `${(rate * 100).toFixed(1)}%`;
}

// Builds the embed both /league-bot-status and the channel refresher send.
// The description's "Last checked <t:...:R>" uses Discord's relative
// timestamp format, which the CLIENT renders live -- so the message reads as
// fresh between edits without the bot needing to touch it every tick.
export function buildHealthEmbed(health: BotHealth): EmbedBuilder {
  const checkedAtUnix = Math.floor(health.checkedAt.getTime() / 1000);
  const stalledLowPriority = health.queue.stalledLowPriority ?? [];
  const queueLines = [
    health.queue.stalled.length
      ? `${LEVEL_EMOJI.degraded} stalled: ${health.queue.stalled.join(", ")}`
      : `${LEVEL_EMOJI.ok} ok`,
  ];
  if (stalledLowPriority.length) {
    queueLines.push(`${LEVEL_EMOJI.ok} low-priority stalled (not alerted): ${stalledLowPriority.join(", ")}`);
  }
  return new EmbedBuilder()
    .setTitle(`${LEVEL_EMOJI[health.level]} Bot health -- ${health.level.toUpperCase()}`)
    .setColor(LEVEL_COLOR[health.level])
    .setDescription(`Last checked <t:${checkedAtUnix}:R>`)
    .addFields(
      {
        name: "Discord",
        value: [
          `Gateway ping: ${fmtMs(health.discord.gatewayPingMs)}`,
          `REST p95: ${fmtMs(health.discord.restP95Ms)}`,
          `REST error rate: ${fmtRate(health.discord.restErrorRate)}`,
        ].join("\n"),
      },
      {
        name: "Database",
        value: `${health.db.ok ? LEVEL_EMOJI.ok + " reachable" : LEVEL_EMOJI.down + " unreachable"} -- latency ${fmtMs(health.db.latencyMs)}`,
      },
      {
        name: "Queue",
        value: queueLines.join("\n"),
      },
      {
        name: "Likely cause",
        value: describeAttribution(health.attribution, health.discordStatus),
      },
      {
        name: "Notes",
        value: health.notes.map((n) => `- ${n}`).join("\n"),
      },
    );
}

// PURE. Deterministic summary of the MATERIAL parts of a health snapshot --
// material meaning "would change what buildPublicHealthEmbed renders".
// That's just two things: the overall level, and (only when degraded)
// whether the cause is player-impacting -- that's the one branch in
// publicHealthCopy() below. Everything else (exact latency numbers, error
// rates, db latency, which queue is stalled, the timestamp) is invisible to
// players, so changing it must NOT change this key. channel-refresh.ts's
// refreshBotStatusMessage compares this key tick-to-tick (mirroring
// bot-health.ts's lastPresenceKey pattern) and skips the Discord edit when
// it hasn't changed, so a steady system -- or one with a purely internal
// hiccup -- doesn't get edited 1440x/day for something players can't see.
export function buildBotStatusRenderKey(health: BotHealth): string {
  const parts: unknown[] = [health.level, health.level === "degraded" ? isPlayerImpacting(health) : null];
  return parts.map((p) => String(p)).join("|");
}

// PURE. Friendly, number-free title + body for a health level. The
// degraded case is the only one that branches on the CAUSE, and only
// between two buckets: something a player would actually feel
// (isPlayerImpacting -- shared with health-broadcast.ts so this copy can
// never claim something different than what the incident broadcast said)
// vs. a purely internal issue (e.g. a backlogged queue) that players never
// touch.
function publicHealthCopy(health: BotHealth): { title: string; description: string } {
  if (health.level === "down") {
    return {
      title: "The bot is having problems",
      description: "Admins have been notified.",
    };
  }
  if (health.level === "degraded") {
    const description = isPlayerImpacting(health)
      ? "Discord is responding slowly, so buttons and results may lag. Your clicks are still landing."
      : "We're working on a background issue. Matches are unaffected.";
    return { title: "Some things may be slow", description };
  }
  return {
    title: "Everything's working",
    description: "Matches, reporting and commands are all running normally.",
  };
}

// Builds the PLAYER-FACING embed -- plain language, no ms/percentage
// figures, no subsystem/queue names. See the module header for who reads
// this (the #bot-status channel message, and /league-bot-status for
// non-admin callers). Same relative "Last checked" convention as
// buildHealthEmbed so the message reads as fresh between edits.
export function buildPublicHealthEmbed(health: BotHealth): EmbedBuilder {
  const checkedAtUnix = Math.floor(health.checkedAt.getTime() / 1000);
  const { title, description } = publicHealthCopy(health);
  return new EmbedBuilder()
    .setTitle(`${LEVEL_EMOJI[health.level]} ${title}`)
    .setColor(LEVEL_COLOR[health.level])
    .setDescription(`${description}\n\nLast checked <t:${checkedAtUnix}:R>`);
}

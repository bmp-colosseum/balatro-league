// Shared rendering for a BotHealth snapshot (bot-health.ts). Two surfaces
// consume this: /league-bot-status (commands/bot-status.ts, an ephemeral
// reply) and the self-updating #bot-status channel message
// (channel-refresh.ts's refreshBotStatusMessage). Both call buildHealthEmbed
// so they can never drift apart into two different renderings of the same
// snapshot.
//
// PURE module -- no Discord client, no I/O. buildHealthEmbed constructs a
// (not-yet-sent) EmbedBuilder from plain data; buildBotStatusRenderKey
// produces a short deterministic string used ONLY to decide whether the
// channel message needs an edit at all (see channel-refresh.ts) -- it
// deliberately rounds away sub-threshold jitter so a steady system doesn't
// trigger an edit every 60s tick.

import { EmbedBuilder } from "discord.js";
import type { BotHealth, HealthLevel } from "./bot-health.js";

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
        value: health.queue.stalled.length
          ? `${LEVEL_EMOJI.degraded} stalled: ${health.queue.stalled.join(", ")}`
          : `${LEVEL_EMOJI.ok} ok`,
      },
      {
        name: "Notes",
        value: health.notes.map((n) => `- ${n}`).join("\n"),
      },
    );
}

// Buckets a millisecond value to the nearest ROUND_MS so a few ms of jitter
// (or a rerun with a slightly different sample window) doesn't flip the key.
const ROUND_MS = 100;
// Buckets an error rate (0..1) to the nearest whole percentage point.
const ROUND_ERROR_RATE = 0.01;

function roundMs(v: number | null): number | null {
  return v === null ? null : Math.round(v / ROUND_MS) * ROUND_MS;
}

function roundRate(v: number | null): number | null {
  return v === null ? null : Math.round(v / ROUND_ERROR_RATE) * ROUND_ERROR_RATE;
}

// PURE. Deterministic summary of the MATERIAL parts of a health snapshot --
// the overall + per-subsystem levels, coarse-rounded latency/error numbers,
// and which queues are stalled. Two snapshots that differ only by exact
// timestamp or by less than one rounding bucket produce the SAME key; a
// snapshot that changes level, crosses a rounding bucket, or changes which
// queue is stalled produces a DIFFERENT key. channel-refresh.ts's
// refreshBotStatusMessage compares this key tick-to-tick (mirroring
// bot-health.ts's lastPresenceKey pattern) and skips the Discord edit when
// it hasn't changed, so a steady system doesn't get edited 1440x/day.
export function buildBotStatusRenderKey(health: BotHealth): string {
  const parts: unknown[] = [
    health.level,
    health.discord.level,
    roundMs(health.discord.gatewayPingMs),
    roundMs(health.discord.restP95Ms),
    roundRate(health.discord.restErrorRate),
    health.db.ok,
    roundMs(health.db.latencyMs),
    health.queue.ok,
    [...health.queue.stalled].sort().join(","),
  ];
  return parts.map((p) => String(p)).join("|");
}

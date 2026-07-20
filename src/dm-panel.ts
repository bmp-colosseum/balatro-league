// Per-player "DM panel" -- one message per league player, sent once and then
// REFRESHED BY EDITING IT IN PLACE on a timer (never deleted+reposted, which
// would fire a Discord notification every cycle -- editing is silent). Shows
// the season deadline plus the player's own situation (division/rank/matches
// left) and the same division-controls buttons used everywhere else.
//
// This module NEVER touches inbound DMs (see inbound-dm.ts / captureInboundDm)
// -- it only ever sends/edits messages it itself owns.
//
// Reuses, never re-derives:
//   - the personal-summary core lives in commands/status.ts
//     (computeStatusSummaryForPlayer) -- the same DB round-trip /status and
//     the "My standings" button already use.
//   - the button row is divisionControlsRow() (division-controls.ts).
//   - the season timeline is seasonTimelineLines()/parseBufferDays()
//     (season-timing.ts), resolved ONCE per refresh cycle, not per player.
//
// Storage: no schema change -- {channelId, messageId} JSON under a
// LeagueConfig key `dm_panel:<playerId>` (same raw-key pattern as
// shootout.ts's noticeKey() / sticky-actions.ts's stickyConfigKey()).
//
// State machine per player, per tick:
//   no stored record                    -> send a fresh DM, store the ids
//   stored record, edit succeeds        -> done (silent, no notification)
//   stored record, message/channel gone -> clear the record, send fresh
//                  (10008/10003)
//   stored record, DMs closed/blocked   -> clear the record, skip (would
//                  (50007/10013/50001)     fail identically on resend)
//   stored record, any other failure    -> leave the record, retry next tick
//                  (transient -- network blip, unexpected 5xx, ...)
//
// Every player is handled in its own try/catch so one blocked/DMs-off player
// can never abort the walk over the rest of the league (match-sweep /
// sticky-actions pattern).

import { type BaseMessageOptions, type Client } from "discord.js";
import { activePublicSeason } from "./active-season.js";
import { prisma } from "./db.js";
import { playerActionRows } from "./division-controls.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";
import { seasonTimelineLines, parseBufferDays } from "./season-timing.js";
import { computeStatusSummaryForPlayer, type PlayerStatusSummary } from "./commands/status.js";
import { isUndeliverableDm } from "./discord-helpers.js";
import { logDiscordError } from "./log-discord-error.js";

// ---- Tunables --------------------------------------------------------------

// How often every player's panel gets re-rendered (edit in place). Env
// override with a finite/positive guard so a bad value can't silently disable
// the loop or busy-spin it. Default 60 minutes.
const envRefreshMs = Number(process.env.DM_PANEL_REFRESH_MS);
export const DM_PANEL_REFRESH_MS =
  Number.isFinite(envRefreshMs) && envRefreshMs > 0 ? envRefreshMs : 60 * 60 * 1000;

// Small pause between players in a refresh pass so a 200-player league
// doesn't burst Discord's per-route rate limit all at once. Default 300ms.
const envDelayMs = Number(process.env.DM_PANEL_SEND_DELAY_MS);
export const DM_PANEL_SEND_DELAY_MS = Number.isFinite(envDelayMs) && envDelayMs >= 0 ? envDelayMs : 300;

const dmPanelConfigKey = (playerId: string): string => `dm_panel:${playerId}`;

// ---- Pure core ---------------------------------------------------------------

export interface DmPanelRecord {
  channelId: string;
  messageId: string;
}

// Parse the stored JSON blob defensively -- garbage/partial/foreign data is
// treated as "no record" so the shell just sends a fresh panel rather than
// throwing on a malformed LeagueConfig row.
export function parseDmPanelRecord(raw: string | null | undefined): DmPanelRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).channelId === "string" &&
      typeof (parsed as Record<string, unknown>).messageId === "string"
    ) {
      return parsed as DmPanelRecord;
    }
    return null;
  } catch {
    return null;
  }
}

export type DmPanelAction = "send" | "edit";

// send-vs-edit gate: a stored record means "try to edit it in place"; no
// record (first run, or a prior cycle cleared it) means "send fresh".
export function decideDmPanelAction(stored: DmPanelRecord | null): DmPanelAction {
  return stored ? "edit" : "send";
}

export type DmPanelEditOutcome = "resend" | "skip-undeliverable" | "skip-transient";

export interface DmPanelErrorLike {
  code?: number;
}

// Classifies a failed edit attempt (a Discord REST error shape) into what the
// shell should do next. Pure -- takes a plain {code} so it's testable with
// literal error-like objects, no discord.js client involved.
//   10008/10003 (unknown message/channel) -> the stored message is gone:
//     clear the record and send a fresh one this same cycle.
//   50007/10013/50001 (DMs closed / blocked / no access) -> permanently
//     undeliverable for now: clear the record, don't resend (it would just
//     fail identically).
//   anything else (network blip, unexpected 5xx, ...) -> transient: leave the
//     stored record alone and retry the edit next cycle.
export function classifyDmPanelEditError(err: DmPanelErrorLike | null | undefined): DmPanelEditOutcome {
  const code = err?.code;
  if (code === 10008 || code === 10003) return "resend";
  if (code === 50007 || code === 10013 || code === 50001) return "skip-undeliverable";
  return "skip-transient";
}

// Compact panel content -- a few lines, never a giant embed. `summary` is the
// shared personal-status snapshot from computeStatusSummaryForPlayer;
// `timelineLines` is the season-deadline block, resolved once per cycle.
export function buildDmPanelLines(summary: PlayerStatusSummary, timelineLines: string[]): string[] {
  const lines: string[] = ["**Your League Panel**", ...timelineLines];
  if (summary.kind !== "ok") {
    lines.push(summary.message ?? "No status available right now.");
    return lines;
  }
  lines.push(
    `**${summary.divisionName}** (${summary.tierName} tier) - rank #${summary.rank} of ${summary.totalInDivision}`,
  );
  lines.push(
    `${summary.points} pts - ${summary.wins}W ${summary.draws}D ${summary.losses}L (${summary.played} played)`,
  );
  if (summary.movement) lines.push(summary.movement);
  // Jump straight to their division channel. A <#id> mention renders as a
  // clickable channel link inside a DM too, so no full URL is needed.
  if (summary.divisionChannelId) lines.push(`Your division channel: <#${summary.divisionChannelId}>`);
  const remaining = summary.remainingOpponents ?? [];
  lines.push(
    remaining.length ? `${remaining.length} left to play: ${remaining.join(", ")}` : "All your matches are done!",
  );
  return lines;
}

// Full send/edit payload: compact content + the standard division-controls
// row, mentions cleared so a refresh (or the initial send) never pings.
export function buildDmPanel(summary: PlayerStatusSummary, timelineLines: string[]): BaseMessageOptions {
  return {
    content: buildDmPanelLines(summary, timelineLines).join("\n\n"),
    components: playerActionRows(),
    allowedMentions: { parse: [] },
  };
}

// ---- Storage shell (LeagueConfig, no schema change) ------------------------

async function readDmPanelRecord(playerId: string): Promise<DmPanelRecord | null> {
  const row = await prisma.leagueConfig.findUnique({ where: { key: dmPanelConfigKey(playerId) } });
  return parseDmPanelRecord(row?.value ?? null);
}

async function storeDmPanelRecord(playerId: string, record: DmPanelRecord): Promise<void> {
  const key = dmPanelConfigKey(playerId);
  const value = JSON.stringify(record);
  await prisma.leagueConfig.upsert({
    where: { key },
    create: { key, value, updatedBy: "system" },
    update: { value, updatedBy: "system" },
  });
}

async function clearDmPanelRecord(playerId: string): Promise<void> {
  await prisma.leagueConfig.deleteMany({ where: { key: dmPanelConfigKey(playerId) } });
}

// ---- Discord shell ----------------------------------------------------------

async function tryEditPanel(
  client: Client,
  record: DmPanelRecord,
  options: BaseMessageOptions,
): Promise<"ok" | DmPanelEditOutcome> {
  try {
    const channel = await client.channels.fetch(record.channelId).catch(() => null);
    if (!channel || !("send" in channel) || !("messages" in channel)) return "resend";
    await channel.messages.edit(record.messageId, options);
    return "ok";
  } catch (err) {
    logDiscordError("dm-panel.edit", err, { channelId: record.channelId, messageId: record.messageId });
    return classifyDmPanelEditError({ code: (err as { code?: number })?.code });
  }
}

async function sendFreshPanel(
  client: Client,
  player: { id: string; discordId: string },
  options: BaseMessageOptions,
): Promise<void> {
  try {
    const user = await client.users.fetch(player.discordId);
    const sent = await user.send(options);
    await storeDmPanelRecord(player.id, { channelId: sent.channelId, messageId: sent.id });
  } catch (err) {
    if (isUndeliverableDm(err)) {
      console.warn(`[dm-panel] ${player.discordId} undeliverable -- skipping`);
      return;
    }
    logDiscordError("dm-panel.send", err, { userId: player.discordId });
  }
}

// Send-or-refresh for ONE player. Never throws -- every failure (blocked DMs,
// deleted channel, an unexpected DB error) is caught, logged, and skipped so
// the caller's walk over every player can never be aborted by one bad player.
export async function sendOrRefreshDmPanel(
  client: Client,
  player: { id: string; discordId: string },
  timelineLines: string[],
): Promise<void> {
  try {
    const summary = await computeStatusSummaryForPlayer(player.id);
    const options = buildDmPanel(summary, timelineLines);
    const stored = await readDmPanelRecord(player.id);
    const action = decideDmPanelAction(stored);

    if (action === "edit" && stored) {
      const outcome = await tryEditPanel(client, stored, options);
      if (outcome === "ok") return;
      if (outcome === "skip-transient") return; // leave the record, retry next cycle
      // "resend" (message/channel gone) or "skip-undeliverable" (DMs closed) --
      // either way the stored message can't be reused.
      await clearDmPanelRecord(player.id);
      if (outcome === "skip-undeliverable") {
        console.warn(`[dm-panel] ${player.discordId} undeliverable (edit) -- cleared stored panel`);
        return;
      }
    }

    await sendFreshPanel(client, player, options);
  } catch (err) {
    console.warn(`[dm-panel] refresh failed for player ${player.id}:`, err);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The tick body: resolve the season timeline once, then walk every ACTIVE
// division member of the active season and refresh their panel one at a
// time (small delay between sends -- see DM_PANEL_SEND_DELAY_MS). No active
// season = nothing to do. Also the season-start blast entry point --
// dm-panel.blast (queue.ts) calls this same function so the kickoff blast
// and the hourly tick share one implementation.
// Master switch. OFF unless LeagueConfig `dm_panels_enabled` is exactly "true".
// Without this, the first hourly tick after deploy would DM every active player
// immediately -- we only want panels to start flowing when the TO turns them on
// at season kickoff. Flip it on /admin/config.
export const DM_PANELS_ENABLED_KEY = "dm_panels_enabled";

export async function dmPanelsEnabled(): Promise<boolean> {
  const row = await prisma.leagueConfig.findUnique({ where: { key: DM_PANELS_ENABLED_KEY } });
  return (row?.value ?? "").trim().toLowerCase() === "true";
}

export async function refreshAllDmPanels(client: Client): Promise<{ processed: number; failed: number }> {
  if (!(await dmPanelsEnabled())) return { processed: 0, failed: 0 };
  const season = await activePublicSeason();
  if (!season) return { processed: 0, failed: 0 };
  const timelineLines = seasonTimelineLines(
    season.scheduledEndAt,
    parseBufferDays(await getConfig(LeagueConfigKey.TiebreakBufferDays)),
  );
  const members = await prisma.divisionMember.findMany({
    where: { status: "ACTIVE", division: { seasonId: season.id } },
    select: { player: { select: { id: true, discordId: true } } },
  });

  let processed = 0;
  let failed = 0;
  for (const m of members) {
    try {
      await sendOrRefreshDmPanel(client, m.player, timelineLines);
      processed++;
    } catch (err) {
      // sendOrRefreshDmPanel already catches internally -- this is a second
      // safety net so one truly unexpected throw still can't break the loop.
      failed++;
      console.warn(`[dm-panel] unexpected failure for player ${m.player.id}:`, err);
    }
    if (DM_PANEL_SEND_DELAY_MS > 0) await delay(DM_PANEL_SEND_DELAY_MS);
  }
  console.log(`[dm-panel] refreshed ${processed} panel(s), ${failed} failure(s)`);
  return { processed, failed };
}

// Boot entry point -- mirrors startMatchSweep/startStickyActions: run once
// immediately (covers a season that started while the bot was down), then on
// a fixed interval.
export function startDmPanels(client: Client): void {
  void refreshAllDmPanels(client).catch((err) => console.warn("[dm-panel] boot refresh failed:", err));
  setInterval(() => {
    void refreshAllDmPanels(client).catch((err) => console.warn("[dm-panel] refresh tick failed:", err));
  }, DM_PANEL_REFRESH_MS);
}

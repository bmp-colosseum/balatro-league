// Per-player "DM panel" -- one message per league player, sent once and then
// REFRESHED BY EDITING IT IN PLACE on a timer (never deleted+reposted, which
// would fire a Discord notification every cycle -- editing is silent). Shows
// the season deadline plus the player's own situation (division/rank/matches
// left) and the same division-controls buttons used everywhere else.
//
// This is now also the SINGLE season-start DM: queue.ts's
// announceSeasonStartIfComplete enqueues a dm-panel.blast at season kickoff
// (same first-send-vs-edit machinery below), and buildDmPanelLines leads an
// "ok" summary with a short season/division intro line plus a matchups
// section -- the content the old separate queueSeasonOnboardingDms DM used to
// carry. That separate DM now only fires as a fallback when DM panels are
// OFF (dmPanelsEnabled() false) -- see shouldSendFallbackSeasonStartDm below
// and its call site in queue.ts -- so a player is never left with zero
// season-start DMs.
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
import { formatSeasonLabel } from "./format-season.js";
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
// For an "ok" summary this doubles as the season-start DM content: a short
// "season is live, you're in X" intro line leads, and the matchups section
// at the end lists every remaining opponent on its own line (the same
// information the old separate season-start DM carried).
// Render a seasonTimelineLines() head line as one plain bold line instead of
// an H2 -- an H2 ("## [flag] Finish all your games by...") renders as a giant
// heading in a DM on mobile (finding 10 / B14 in
// .claude/knowledge/bot-ux/01-findings.md). Only the head line carries the
// "## " prefix; any buffer-explanation line underneath is already plain.
function flattenTimelineHeading(line: string): string {
  return line.startsWith("## ") ? `**${line.slice(3)}**` : line;
}

export function buildDmPanelLines(summary: PlayerStatusSummary, timelineLines: string[], seasonLabel: string): string[] {
  const lines: string[] = [`**${seasonLabel}: your panel**`];
  if (summary.kind === "ok") {
    lines.push(`You're playing **${summary.seasonLabel}** in **${summary.divisionName}**.`);
  }
  lines.push(...timelineLines.map(flattenTimelineHeading));
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
  // A <@id> mention often renders as "unknown user" in a DM (the client
  // hasn't resolved that member) -- pair each name with its typed "@handle"
  // (summary.remainingOpponentHandles, same index as remainingOpponents) so
  // the player can always find who they're playing, same convention as
  // every other player-facing mention site (src/mention.ts).
  const handles = summary.remainingOpponentHandles ?? [];
  lines.push(
    remaining.length
      ? `**Matchups still to play (${remaining.length}):**\n${remaining
          .map((name, i) => (handles[i] ? `- ${name} (${handles[i]})` : `- ${name}`))
          .join("\n")}`
      : "All your matches are done!",
  );
  return lines;
}

// Discord's hard cap on a non-embed message's `content`. Defensive only --
// a compact panel (a handful of status lines + a division-sized opponent
// list) sits nowhere near this in practice, but capPanelContent makes sure a
// future field added here fails safe (truncated with a note) instead of the
// send erroring outright.
export const DISCORD_CONTENT_LIMIT = 2000;

export function capPanelContent(content: string, limit: number = DISCORD_CONTENT_LIMIT): string {
  if (content.length <= limit) return content;
  const marker = "\n...(truncated)";
  return content.slice(0, Math.max(0, limit - marker.length)) + marker;
}

// Full send/edit payload: compact content + the standard division-controls
// row, mentions cleared so a refresh (or the initial send) never pings.
export function buildDmPanel(summary: PlayerStatusSummary, timelineLines: string[], seasonLabel: string): BaseMessageOptions {
  return {
    content: capPanelContent(buildDmPanelLines(summary, timelineLines, seasonLabel).join("\n\n")),
    components: playerActionRows(),
    allowedMentions: { parse: [] },
  };
}

// Final panel content once a player's season has ended -- replaces the
// live progress lines (rank/points/matchups) with a one-line close so the
// panel stops showing a deadline that's days in the past forever (see
// finding 10, B13 in .claude/knowledge/bot-ux/01-findings.md: before this,
// refreshAllDmPanels just bails out with no active season and the stale
// panel is never touched again).
export function buildDmPanelFinalLines(seasonLabel: string, divisionName: string, rank: number, totalInDivision: number): string[] {
  return [`**${seasonLabel} is over.** You finished #${rank} of ${totalInDivision} in ${divisionName}.`];
}

// No buttons -- every quick action (Start a match, Who do I play?, ...) is
// for an in-progress season, so none of them apply to a closed one.
export function buildDmPanelFinal(seasonLabel: string, divisionName: string, rank: number, totalInDivision: number): BaseMessageOptions {
  return {
    content: capPanelContent(buildDmPanelFinalLines(seasonLabel, divisionName, rank, totalInDivision).join("\n\n")),
    components: [],
    allowedMentions: { parse: [] },
  };
}

// Gate for queue.ts's season-start fallback: the separate (pre-merge)
// season-start matchups DM must still fire when DM panels are OFF, so a
// player is never left with zero season-start DMs -- but when panels are ON
// the panel DM itself now carries the intro + matchups, and sending both
// would double-DM everyone. Pure so the branch is a one-line unit test, not
// something you can only exercise through the live dmPanelsEnabled() DB read.
export function shouldSendFallbackSeasonStartDm(dmPanelsEnabled: boolean): boolean {
  return !dmPanelsEnabled;
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
  seasonLabel: string,
): Promise<void> {
  try {
    const summary = await computeStatusSummaryForPlayer(player.id);
    const options = buildDmPanel(summary, timelineLines, seasonLabel);
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

// One row of a finalized season's placement, pre-computed by the caller
// (web/lib/end-season.ts already has the exact standings it used for the
// rating math + the promoted/relegated DMs) -- this module just renders +
// delivers it, same edit-or-send machinery as the live panel.
export interface SeasonFinalStanding {
  playerId: string;
  discordId: string;
  divisionName: string;
  rank: number;
  totalInDivision: number;
}

async function finalizeDmPanelForPlayer(
  client: Client,
  player: { id: string; discordId: string },
  options: BaseMessageOptions,
): Promise<void> {
  const stored = await readDmPanelRecord(player.id);
  if (stored) {
    const outcome = await tryEditPanel(client, stored, options);
    if (outcome === "ok") return;
    await clearDmPanelRecord(player.id);
    if (outcome === "skip-undeliverable") return;
  }
  await sendFreshPanel(client, player, options);
}

// Finalize every player's panel for a season that just ended -- edits the
// stored panel message in place when one exists (silent, matching the
// live-refresh convention), or sends a fresh final DM for a player who
// never had one (DM panels turned on mid-season, etc). Never throws per
// player, same convention as refreshAllDmPanels.
export async function finalizeDmPanelsForSeason(
  client: Client,
  seasonLabel: string,
  standings: SeasonFinalStanding[],
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  for (const row of standings) {
    try {
      const options = buildDmPanelFinal(seasonLabel, row.divisionName, row.rank, row.totalInDivision);
      await finalizeDmPanelForPlayer(client, { id: row.playerId, discordId: row.discordId }, options);
      processed++;
    } catch (err) {
      failed++;
      console.warn(`[dm-panel] finalize failed for player ${row.playerId}:`, err);
    }
  }
  console.log(`[dm-panel] finalized ${processed} panel(s) for "${seasonLabel}", ${failed} failure(s)`);
  return { processed, failed };
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
  const seasonLabel = formatSeasonLabel(season);
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
      await sendOrRefreshDmPanel(client, m.player, timelineLines, seasonLabel);
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

// Roster check-in blast: DM each flagged player the "still playing?" message
// with Still-playing / I'm-out buttons, and stamp checkinStatus="pending" so a
// re-run never asks them twice. Skips anyone who opted out of reminders or has
// already been asked/answered. The bot owns this (Discord client + DM sending);
// the web enqueues it via the roster.checkin pg-boss job.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { prisma } from "./db.js";
import { getDiscordClient } from "./discord.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";
import { env } from "./env.js";
import { buildCheckinMessage } from "./checkin-message.js";

export async function runRosterCheckin(opts: { playerIds: string[]; seasonId: string }): Promise<number> {
  if (opts.playerIds.length === 0) return 0;
  const guildId = env.DISCORD_GUILD_ID;
  const supportChannelId = await getConfig(LeagueConfigKey.SupportChannelId);
  const season = await prisma.season.findUnique({ where: { id: opts.seasonId }, select: { scheduledEndAt: true } });
  const jump = (cid: string | null | undefined) =>
    guildId && cid ? `https://discord.com/channels/${guildId}/${cid}` : null;
  const supportUrl = jump(supportChannelId);
  const client = getDiscordClient();

  let sent = 0;
  for (const playerId of opts.playerIds) {
    const member = await prisma.divisionMember.findFirst({
      where: { playerId, seasonId: opts.seasonId, status: "ACTIVE" },
      include: { player: true, division: { select: { name: true, discordChannelId: true } } },
    });
    if (!member) continue;
    if (member.player.signupReminderOptOut) continue; // respect opt-out
    // De-dup: never re-ask someone already pending/answered.
    if (member.checkinStatus === "pending" || member.checkinStatus === "in" || member.checkinStatus === "out") continue;

    const content = buildCheckinMessage({
      name: member.player.displayName,
      divisionName: member.division.name,
      divisionChannelUrl: jump(member.division.discordChannelId),
      supportChannelUrl: supportUrl,
      seasonEndsAt: season?.scheduledEndAt ?? null,
    });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`roster:in:${member.id}`).setLabel("Still playing").setStyle(ButtonStyle.Success),
    );
    try {
      const user = await client.users.fetch(member.player.discordId);
      await user.send({ content, components: [row] });
      await prisma.divisionMember.update({ where: { id: member.id }, data: { checkinStatus: "pending", checkinAt: new Date() } });
      sent++;
    } catch (err) {
      console.warn(`[roster-checkin] DM to ${member.player.discordId} failed:`, err);
      // DMs closed / blocked — mark so the admin sees it; a re-run can retry.
      await prisma.divisionMember
        .update({ where: { id: member.id }, data: { checkinStatus: "dm-failed", checkinAt: new Date() } })
        .catch(() => {});
    }
  }
  return sent;
}

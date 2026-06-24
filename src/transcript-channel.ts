// Staff-only #league-transcripts feed. When a match/dispute thread closes, the
// bot posts a brief summary (who spoke + message counts) and a link to the web
// transcript here, so staff have a Discord-side index of conversations to
// review. The channel is auto-created (staff-only, gated by the RoleBinding
// tiers) on first use and its id cached in LeagueConfig.

import {
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  type Client,
  type OverwriteResolvable,
  type TextChannel,
} from "discord.js";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { webUrl } from "./web-url.js";

const STAFF_ALLOW = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.SendMessages,
];
const BOT_ALLOW = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.ReadMessageHistory,
];

// Resolve the staff transcripts channel, creating it (staff-only) if needed.
export async function ensureTranscriptsChannel(client: Client): Promise<TextChannel | null> {
  const guildId = env.DISCORD_GUILD_ID;
  if (!guildId) return null;

  const existingId = await getConfig(LeagueConfigKey.TranscriptsChannelId);
  if (existingId) {
    const ch = await client.channels.fetch(existingId).catch(() => null);
    if (ch && ch.type === ChannelType.GuildText) return ch as TextChannel;
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;

  // discord.js resolves each overwrite id against the role/member CACHE — an
  // uncached or deleted id throws "not a cached User or Role" and kills the whole
  // create. So populate the caches first, then only include ids that actually
  // resolve.
  await guild.roles.fetch().catch(() => {});
  const me = await guild.members.fetchMe().catch(() => null);

  // Staff tiers (OWNER/ADMIN/HELPER/DEVOPS) get view access — same model as
  // #league-admin-chat. @everyone is denied. Skip any RoleBinding pointing at a
  // role that no longer exists in the guild.
  const staff = await prisma.roleBinding.findMany({
    where: { tier: { in: ["OWNER", "ADMIN", "HELPER", "DEVOPS"] } },
    select: { discordRoleId: true },
  });
  const categoryId = await getConfig(LeagueConfigKey.LeagueCategoryId);

  const overwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    ...staff
      .filter((s) => guild.roles.cache.has(s.discordRoleId))
      .map((s) => ({ id: s.discordRoleId, allow: STAFF_ALLOW })),
  ];
  if (me) overwrites.push({ id: me.id, allow: BOT_ALLOW });

  try {
    const ch = await guild.channels.create({
      name: "league-transcripts",
      type: ChannelType.GuildText,
      parent: categoryId ?? undefined,
      topic: "📄 Moderation transcripts — a link + summary for each match/dispute thread. Staff-only.",
      permissionOverwrites: overwrites,
    });
    await setConfig(LeagueConfigKey.TranscriptsChannelId, ch.id, "system");
    console.log(`[transcript-channel] created #league-transcripts (${ch.id})`);
    return ch as TextChannel;
  } catch (err) {
    console.warn("[transcript-channel] create failed:", err);
    return null;
  }
}

// Post the summary + link for a thread's captured transcript. No-op if nothing
// was said (so empty/cancelled threads don't spam the channel). Best-effort.
export async function postTranscriptSummary(client: Client, threadId: string): Promise<void> {
  try {
    // Ensure the staff channel exists on every match close (idempotent — only
    // creates it once, then reuses). Doing this BEFORE the message check means
    // the channel appears as soon as a match completes, even if that thread had
    // no chat — so "the channel never showed up" can't be a silent no-op.
    const channel = await ensureTranscriptsChannel(client);
    if (!channel) {
      console.warn("[transcript-channel] no channel (create failed / missing ManageChannels?) for thread", threadId);
      return;
    }

    const messages = await prisma.threadMessage.findMany({
      where: { threadId },
      select: { authorName: true, matchId: true, kind: true, deletedAt: true },
    });
    if (messages.length === 0) {
      console.log(`[transcript-channel] thread ${threadId} closed with 0 captured messages — channel ensured, nothing to post.`);
      return;
    }

    const participants = [...new Set(messages.map((m) => m.authorName))];
    const deleted = messages.filter((m) => m.deletedAt).length;
    const matchId = messages.find((m) => m.matchId)?.matchId ?? null;
    const kind = messages.find((m) => m.kind === "dispute") ? "dispute" : "match";

    const link = webUrl(`admin/transcripts/${threadId}`);
    const embed = new EmbedBuilder()
      .setTitle(`📄 ${kind === "dispute" ? "Dispute" : "Match"} transcript`)
      .setColor(kind === "dispute" ? 0xe67e22 : 0x5865f2)
      .setDescription(
        `**Who spoke:** ${participants.join(", ")}\n` +
          `**Messages:** ${messages.length}${deleted ? ` · ${deleted} deleted` : ""}\n` +
          (matchId ? `**Match:** \`${matchId}\`\n` : "") +
          `\n[View transcript →](${link})`,
      );
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.warn("[transcript-channel] post failed:", err);
  }
}

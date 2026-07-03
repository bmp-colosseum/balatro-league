// Outbound notifications: DMs (closed DMs are logged + skipped, never retried) and the
// #draft channel post for live picks. Message links are site-relative paths from the web;
// we absolutize them here.
import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import { env } from "./env";
import { apiGet } from "./api";

const absolutize = (msg: string) => msg.replace(/(^|\s)(\/[a-zA-Z0-9/_%-]+)/g, (m, pre, path) => `${pre}${env.TOUR_WEB_URL}${path}`);

export async function sendDm(client: Client, discordId: string, content: string): Promise<boolean> {
  try {
    const user = await client.users.fetch(discordId);
    await user.send(absolutize(content));
    return true;
  } catch {
    console.warn(`[dm] could not DM ${discordId} (DMs closed / unknown user) — skipped`);
    return false;
  }
}

export async function channelOf(client: Client, configKey: string): Promise<TextChannel | null> {
  const cfg = await apiGet<{ key: string; value: string | null }>(`/api/bot/config?key=${encodeURIComponent(configKey)}`);
  if (!cfg.value) return null;
  const ch = await client.channels.fetch(cfg.value).catch(() => null);
  if (!ch || !ch.isTextBased() || ch.isDMBased()) return null;
  return ch as TextChannel;
}

export interface DraftPickJob {
  season: string;
  teamName: string;
  playerName: string;
  round: number;
  pickInRound: number;
  overall: number;
  done: boolean;
  next: { teamName: string; captainDiscordId: string | null; round: number; overall: number } | null;
  urlPath: string;
}

const ord = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
};

// #draft post for a live pick + DM the next captain that they're on the clock.
export async function announceDraftPick(client: Client, job: DraftPickJob): Promise<void> {
  const ch = await channelOf(client, "channel.draft");
  if (ch) {
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`R${job.round} P${job.pickInRound} (${job.overall}${ord(job.overall)} overall): ${job.teamName} select ${job.playerName}`)
      .setDescription(job.done ? `${job.season} — that's a wrap, the draft is COMPLETE!` : job.next ? `${job.season} — on the clock: ${job.next.teamName} (${job.next.overall}${ord(job.next.overall)} overall)` : job.season)
      .setURL(`${env.TOUR_WEB_URL}${job.urlPath}`)
      .setTimestamp(new Date());
    await ch.send({ embeds: [embed] });
  } else {
    console.warn("[draft] channel.draft not configured — pick post skipped (set it at /admin/config)");
  }
  if (!job.done && job.next?.captainDiscordId) {
    await sendDm(
      client,
      job.next.captainDiscordId,
      `You're on the clock in the ${job.season} draft (Round ${job.next.round}, ${job.next.overall}${ord(job.next.overall)} overall). Pick here: ${job.urlPath}`,
    );
  }
}

export interface PairingTurnJob {
  discordId: string;
  kind: "respond" | "propose";
  weekNumber: number;
  myTeamName: string;
  oppTeamName: string;
  urlPath: string;
}

export async function pingPairingTurn(client: Client, job: PairingTurnJob): Promise<void> {
  const verb = job.kind === "respond" ? `They proposed — your response is up` : `Your turn to propose`;
  await sendDm(
    client,
    job.discordId,
    `Week ${job.weekNumber} pairing (${job.myTeamName} vs ${job.oppTeamName}): ${verb}. Pair here: ${job.urlPath}`,
  );
}

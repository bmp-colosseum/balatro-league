import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  type TextChannel,
  type BaseMessageOptions,
} from "discord.js";
import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { ensureLeagueMatchesChannel } from "./league-matches-channel.js";
import { activePublicSeason } from "./active-season.js";
import { seasonEndsHeader } from "./season-timing.js";

// The pinned #league-matches message + its "Start a match" button. Clicking it
// opens an ephemeral dropdown of the clicker's remaining scheduled opponents
// (see commands/league-matches-buttons.ts) so people can start a match without
// typing /start-match. allowedMentions cleared so re-rendering never pings.
function renderLeagueMatchesMessage(endsHeader: string): BaseMessageOptions {
  const lines = [
    ...(endsHeader ? [endsHeader, ""] : []),
    "## 🎴 Start a League Match",
    "Ready to play? Hit **Start a match**, pick an opponent from your schedule, and I'll send them an invite to accept — no slash commands needed.",
    "",
    "_Each match runs in a private thread here. Scheduling is still your responsibility; this just saves you the typing._",
    "",
    "_Tied for a promotion/relegation spot at season's end? Hit **Start shootout** — it only works when you actually owe one._",
  ];
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("league-matches:start").setLabel("Start a match").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("league-matches:shootout").setLabel("Start shootout").setStyle(ButtonStyle.Secondary),
  );
  return { content: lines.join("\n"), components: [row], allowedMentions: { parse: [] } };
}

// Post (or refresh) the pinned "Start a match" message in #league-matches and
// store its id. Idempotent — safe to call from bootstrap + /league refresh-messages.
// Resolves (auto-creating) the channel itself, so callers don't need the id.
export async function ensureLeagueMatchesMessage(client: Client): Promise<void> {
  const channelId = await ensureLeagueMatchesChannel();
  if (!channelId) return;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return;
  const tc = ch as TextChannel;
  const season = await activePublicSeason();
  const payload = renderLeagueMatchesMessage(seasonEndsHeader(season?.scheduledEndAt ?? null));

  const existingId = await getConfig(LeagueConfigKey.LeagueMatchesMessageId);
  if (existingId) {
    const ok = await tc.messages
      .edit(existingId, payload)
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
  const sent = await tc.send(payload);
  await sent.pin().catch(() => {});
  await setConfig(LeagueConfigKey.LeagueMatchesMessageId, sent.id, "system");
}

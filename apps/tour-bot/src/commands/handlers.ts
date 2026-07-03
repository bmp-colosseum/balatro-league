// /ppt command + pick'em button handlers. Every read comes from /api/bot/read; the pick'em
// write goes through /api/bot/pickem (same services as the site). Embeds link back to the web.
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
} from "discord.js";
import { env } from "./../env";
import { apiGet, apiPost } from "./../api";

const url = (path: string) => `${env.TOUR_WEB_URL}${path}`;
const GOLD = 0xf1c40f;

export async function handlePptCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: sub === "mymatch" || sub === "pickem" ? MessageFlags.Ephemeral : undefined });
  try {
    if (sub === "standings") await standings(interaction);
    else if (sub === "schedule") await schedule(interaction);
    else if (sub === "bracket") await bracket(interaction);
    else if (sub === "mymatch") await mymatch(interaction);
    else if (sub === "pickem") await pickem(interaction);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Something went wrong.";
    await interaction.editReply({ content: `Couldn't do that: ${msg}` }).catch(() => {});
  }
}

async function standings(i: ChatInputCommandInteraction) {
  const season = i.options.getString("season");
  const d = await apiGet<{
    seasonName: string;
    groups: { conference: string; rows: { rank: number; team: string; w: number; l: number; setsW: number; setsL: number }[] }[];
    urlPath: string;
  }>(`/api/bot/read?kind=standings${season ? `&season=${encodeURIComponent(season)}` : ""}`);
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(`${d.seasonName} — Standings`).setURL(url(d.urlPath));
  for (const g of d.groups) {
    embed.addFields({
      name: g.conference,
      value: g.rows.map((r) => `${r.rank}. **${r.team}** ${r.w}-${r.l} (sets ${r.setsW}-${r.setsL})`).join("\n").slice(0, 1024) || "—",
    });
  }
  await i.editReply({ embeds: [embed] });
}

async function schedule(i: ChatInputCommandInteraction) {
  const season = i.options.getString("season");
  const week = i.options.getInteger("week");
  const qs = [`kind=schedule`, season ? `season=${encodeURIComponent(season)}` : null, week != null ? `week=${week}` : null].filter(Boolean).join("&");
  const d = await apiGet<{ seasonName: string; week: number; matchups: { teamA: string; teamB: string; setsA: number; setsB: number }[]; urlPath: string }>(`/api/bot/read?${qs}`);
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`${d.seasonName} — Week ${d.week}`)
    .setURL(url(d.urlPath))
    .setDescription(d.matchups.map((m) => `**${m.teamA}** ${m.setsA}-${m.setsB} **${m.teamB}**`).join("\n").slice(0, 4000) || "No matchups.");
  await i.editReply({ embeds: [embed] });
}

async function bracket(i: ChatInputCommandInteraction) {
  const season = i.options.getString("season");
  const d = await apiGet<{
    seasonName: string;
    champion: string | null;
    rounds: { label: string; series: { a: string; b: string; scoreA: number | null; scoreB: number | null; winner: string | null }[] }[];
    urlPath: string;
  }>(`/api/bot/read?kind=bracket${season ? `&season=${encodeURIComponent(season)}` : ""}`);
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`${d.seasonName} — Playoffs${d.champion ? ` · Champion: ${d.champion}` : ""}`)
    .setURL(url(d.urlPath));
  for (const r of d.rounds) {
    embed.addFields({
      name: r.label,
      value: r.series
        .map((s) => `${s.winner === "A" ? `**${s.a}**` : s.a} ${s.scoreA ?? "-"}-${s.scoreB ?? "-"} ${s.winner === "B" ? `**${s.b}**` : s.b}`)
        .join("\n")
        .slice(0, 1024) || "—",
    });
  }
  await i.editReply({ embeds: [embed] });
}

async function mymatch(i: ChatInputCommandInteraction) {
  const d = await apiGet<
    | { linked: false }
    | { linked: true; name: string; sets: { status: string; week: number | null; opponent: string; season: string }[]; urlPath: string }
  >(`/api/bot/read?kind=mymatch&discordId=${i.user.id}`);
  if (!d.linked) {
    await i.editReply({ content: `Your Discord isn't linked to a Tour player yet — sign up or claim your history at ${url("/signup")}` });
    return;
  }
  if (!d.sets.length) {
    await i.editReply({ content: `You're all caught up — no outstanding sets. ${url(d.urlPath)}` });
    return;
  }
  const lines = d.sets.map((s) => {
    const what = s.status === "REPORTED" ? "confirm/dispute the reported result" : "unplayed";
    return `- ${s.season}${s.week != null ? ` Week ${s.week}` : ""} vs **${s.opponent}** — ${what}`;
  });
  await i.editReply({ content: `${lines.join("\n")}\nHandle them at ${url(d.urlPath)}` });
}

interface PickemOpenSet {
  setId: string;
  week: number;
  playerA: string;
  playerAId: string;
  playerB: string;
  playerBId: string;
  myPick: string | null;
}

async function pickem(i: ChatInputCommandInteraction) {
  const d = await apiGet<{ seasonName: string; open: PickemOpenSet[]; urlPath: string }>(`/api/bot/read?kind=pickem&discordId=${i.user.id}`);
  if (!d.open.length) {
    await i.editReply({ content: `No open sets to pick right now — the board fills when the week's matchups are posted. ${url(d.urlPath)}` });
    return;
  }
  const shown = d.open.slice(0, 5); // 1 row per set (Discord caps 5 rows/message)
  const rows = shown.map((s) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`pickem:${s.setId}:${s.playerAId}`)
        .setLabel(`${s.myPick === s.playerAId ? "✓ " : ""}${s.playerA}`.slice(0, 80))
        .setStyle(s.myPick === s.playerAId ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`noop:${s.setId}`).setLabel(`W${s.week} · vs`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`pickem:${s.setId}:${s.playerBId}`)
        .setLabel(`${s.myPick === s.playerBId ? "✓ " : ""}${s.playerB}`.slice(0, 80))
        .setStyle(s.myPick === s.playerBId ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
  );
  await i.editReply({
    content: `**${d.seasonName} Pick'em** — ${d.open.length} open set${d.open.length === 1 ? "" : "s"}${d.open.length > 5 ? ` (showing 5 — the rest at ${url(d.urlPath)})` : ""}. Pick a winner:`,
    components: rows,
  });
}

export async function handlePickemButton(interaction: ButtonInteraction): Promise<void> {
  const [, setId, pickedPlayerId] = interaction.customId.split(":");
  if (!setId || !pickedPlayerId) return;
  try {
    await apiPost("/api/bot/pickem", {
      discordId: interaction.user.id,
      name: interaction.user.globalName ?? interaction.user.username,
      setId,
      pickedPlayerId,
    });
    await interaction.reply({ content: "Pick saved. You can change it until the match starts.", flags: MessageFlags.Ephemeral });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "pick failed";
    await interaction.reply({ content: `Couldn't save that pick: ${msg}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

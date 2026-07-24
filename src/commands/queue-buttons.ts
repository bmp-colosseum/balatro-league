import { MessageFlags, type ButtonInteraction } from "discord.js";
import { actorFromInteractionUser } from "../audit.js";
import { getOrCreatePlayer, guildDisplayName } from "../players.js";
import { activePublicSeason } from "../active-season.js";
import {
  joinQueue,
  leaveQueue,
  tryStartFromQueue,
  refreshQueueMessage,
  queueStatusFor,
  isInActiveDivision,
  remainingMatchCount,
  type QueueStatus,
} from "../league-queue.js";
import { isDiscordIdBanned, BANNED_MESSAGE } from "../bans.js";
import { enqueueQueueOpponentNotify } from "../queue.js";
import type { ButtonHandler } from "./types.js";

const names = (ps: { displayName: string }[]) => ps.map((p) => p.displayName).join(", ");

// The "who's around for me" block shared by the queue-up / leave / status replies.
function statusLines(s: QueueStatus): string[] {
  const lines: string[] = [];
  lines.push(
    s.free.length ? `**Free right now (${s.free.length}):** ${names(s.free)}` : "_Nobody else is free right now._",
  );
  if (s.remainingOpponents.length === 0) {
    lines.push("You've played everyone this season — no matches left. 🎉");
  } else {
    lines.push(`**Your remaining opponents (${s.remainingOpponents.length}):** ${names(s.remainingOpponents)}`);
    lines.push(
      s.freeOpponents.length ? `→ free right now: **${names(s.freeOpponents)}**` : "→ none of them are free yet.",
    );
  }
  return lines;
}

// #league-queue buttons. "I'm free" queues you up (and fires the normal match
// invite if a scheduled opponent is already free); "Leave" pulls you out; "My
// status" shows a private snapshot. All replies are ephemeral; join/leave also
// refresh the pinned message's free list.
export const queueButtons: ButtonHandler = {
  prefix: "queue:",
  async execute(interaction: ButtonInteraction) {
    const action = interaction.customId.split(":")[1];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const me = await getOrCreatePlayer(interaction.user, guildDisplayName(interaction));
    const season = await activePublicSeason();

    if (action === "leave") {
      const was = await leaveQueue(me.id);
      await refreshQueueMessage(interaction.client);
      const head = was ? "✅ You've left the queue." : "You weren't in the queue.";
      if (!season) {
        await interaction.editReply(head);
        return;
      }
      const s = await queueStatusFor(me.id, season.id);
      await interaction.editReply([head, "", ...statusLines(s)].join("\n"));
      return;
    }

    if (!season) {
      await interaction.editReply("No active season right now — nothing to queue for.");
      return;
    }

    if (action === "status") {
      const s = await queueStatusFor(me.id, season.id);
      const head = s.queued
        ? "📋 **You're in the queue** ✅"
        : "📋 **You're not in the queue.** Hit **Queue up** to join.";
      await interaction.editReply([head, "", ...statusLines(s)].join("\n"));
      return;
    }

    if (action === "join") {
      // Banned players can't queue (createLeagueMatchInvite would refuse anyway —
      // this just rejects them up front instead of parking them in the queue).
      if (await isDiscordIdBanned(interaction.user.id)) {
        await interaction.editReply(BANNED_MESSAGE);
        return;
      }
      // League players only.
      if (!(await isInActiveDivision(me.id, season.id))) {
        await interaction.editReply("The queue is for league players — you're not in a division this season.");
        return;
      }
      // Must have scheduled matches left to play.
      if ((await remainingMatchCount(me.id, season.id)) === 0) {
        await interaction.editReply("You've played all your scheduled matches this season — nothing left to queue for. 🎉");
        return;
      }
      // Being mid-match is fine — you can line up your next opponent while you
      // play. The queue only ever pairs you with a still-scheduled opponent, and
      // the match-claim refuses a duplicate against someone you're already playing.
      await joinQueue(me.id, season.id);
      const outcome = await tryStartFromQueue({
        client: interaction.client,
        me,
        actor: actorFromInteractionUser(interaction.user),
      });
      await refreshQueueMessage(interaction.client);

      if (outcome.matched) {
        await interaction.editReply(
          `🎮 **Matched with ${outcome.oppName}!** A match invite is up — accept it to start.` +
            (outcome.inviteUrl ? `\n${outcome.inviteUrl}` : ""),
        );
        return;
      }

      // No instant pair -> nudge any opted-in opponent who still owes this player
      // a match that they're now around. Durable + cooldown-gated in the worker;
      // fire-and-forget so the reply isn't held up.
      void enqueueQueueOpponentNotify({ joinerId: me.id, seasonId: season.id }).catch(() => {});

      const s = await queueStatusFor(me.id, season.id);
      const head = outcome.error
        ? `You're queued, but I couldn't start a match just now: ${outcome.error}`
        : "✅ **You're in the queue.** I'll open a match the moment a scheduled opponent is also queued. Hit **Leave queue** when you're no longer free.";
      await interaction.editReply([head, "", ...statusLines(s)].join("\n"));
      return;
    }

    await interaction.editReply("Unknown queue action.");
  },
};

// pg-boss workers — the bot's job intake (league src/queue.ts pattern). The web enqueues
// (apps/tour/lib/queue.ts); this side owns the workers. Connection budget: max 3.
//
// Jobs:
//   tour.roles.reconcile { season }  — sync a season's Player/Captain roles (also daily cron).
import { PgBoss } from "pg-boss";
import type { Client, Guild } from "discord.js";
import { env } from "./env";
import { apiGet } from "./api";
import { reconcileSeasonRoles } from "./roles";
import { announceSet, announceMatchup } from "./announce";
import { announceDraftPick, pingPairingTurn, sendDm, type DraftPickJob, type PairingTurnJob } from "./notify";

const RECONCILE_QUEUE = "tour.roles.reconcile";
const ANNOUNCE_SET_QUEUE = "tour.announce.result";
const ANNOUNCE_MATCHUP_QUEUE = "tour.announce.matchup";
const DRAFT_PICK_QUEUE = "tour.draft.pick";
const PAIRING_TURN_QUEUE = "tour.pairing.turn";

async function guildOf(client: Client): Promise<Guild> {
  return client.guilds.cache.get(env.TOUR_GUILD_ID) ?? (await client.guilds.fetch(env.TOUR_GUILD_ID));
}

export async function startQueue(client: Client): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: "pgboss", max: 3 });
  boss.on("error", (err: Error) => console.warn("[pg-boss] error:", err));
  await boss.start();

  await boss.createQueue(RECONCILE_QUEUE).catch(() => {});
  await boss.work(RECONCILE_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { season } = job.data as { season: string };
      if (!season) continue;
      const guild = await guildOf(client);
      const r = await reconcileSeasonRoles(guild, season);
      console.log(
        `[roles] ${season}: +${r.added} -${r.removed} (skipped ${r.skipped}, unmappable ${r.unmappable})` +
          `${r.provisioned.length ? ` provisioned ${r.provisioned.join(" ")}` : ""}${r.addsOnly ? " [adds-only: no GuildMembers intent]" : ""}`,
      );
    }
  });

  // Results → #results (channel.results in TourConfig; unset = log + complete).
  await boss.createQueue(ANNOUNCE_SET_QUEUE).catch(() => {});
  await boss.work(ANNOUNCE_SET_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { setId } = job.data as { setId: string };
      if (setId) await announceSet(client, setId);
    }
  });
  await boss.createQueue(ANNOUNCE_MATCHUP_QUEUE).catch(() => {});
  await boss.work(ANNOUNCE_MATCHUP_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { matchupId } = job.data as { matchupId: string };
      if (matchupId) await announceMatchup(client, matchupId);
    }
  });

  // Live draft: pick post to #draft + on-the-clock DM.
  await boss.createQueue(DRAFT_PICK_QUEUE).catch(() => {});
  await boss.work(DRAFT_PICK_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await announceDraftPick(client, job.data as DraftPickJob);
  });

  // Pairing: your-turn DMs.
  await boss.createQueue(PAIRING_TURN_QUEUE).catch(() => {});
  await boss.work(PAIRING_TURN_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await pingPairingTurn(client, job.data as PairingTurnJob);
  });

  // Deadline nudges (SOFT — reminders only): Friday reminder + Sunday-morning last call.
  const runNudges = async (label: string) => {
    const res = await apiGet<{ nudges: { discordId: string; message: string }[] }>("/api/bot/nudges");
    let sent = 0;
    for (const n of res.nudges) if (await sendDm(client, n.discordId, n.message)) sent++;
    console.log(`[nudge:${label}] ${sent}/${res.nudges.length} DMs sent`);
  };
  const NUDGE_FRIDAY = "tour.nudge.friday";
  const NUDGE_SUNDAY = "tour.nudge.lastcall";
  await boss.createQueue(NUDGE_FRIDAY).catch(() => {});
  await boss.work(NUDGE_FRIDAY, { batchSize: 1 }, () => runNudges("friday"));
  await boss.schedule(NUDGE_FRIDAY, "0 17 * * 5"); // Friday 17:00 UTC (~noon ET)
  await boss.createQueue(NUDGE_SUNDAY).catch(() => {});
  await boss.work(NUDGE_SUNDAY, { batchSize: 1 }, () => runNudges("sunday"));
  await boss.schedule(NUDGE_SUNDAY, "0 15 * * 0"); // Sunday 15:00 UTC (~10-11am ET last call)

  // Daily self-heal: reconcile every ACTIVE-ish season (drift from manual Discord edits).
  const CRON_QUEUE = "tour.roles.reconcile-all";
  await boss.createQueue(CRON_QUEUE).catch(() => {});
  await boss.work(CRON_QUEUE, { batchSize: 1 }, async () => {
    const seasons = await apiGet<{ seasons?: { name: string; state?: string }[] } | { name: string; state?: string }[]>("/api/admin/seasons");
    const list = Array.isArray(seasons) ? seasons : (seasons.seasons ?? []);
    for (const s of list) {
      // Only live-ish seasons need role upkeep; DONE seasons keep their roles frozen.
      if (s.state && ["SIGNUPS", "DRAFTING", "REGULAR", "PLAYOFFS"].includes(s.state)) {
        await boss.send(RECONCILE_QUEUE, { season: s.name }, { singletonKey: `roles:${s.name}`, singletonSeconds: 30 });
      }
    }
  });
  await boss.schedule(CRON_QUEUE, "0 7 * * *"); // daily 07:00 UTC (league pattern)

  console.log("[pg-boss] workers ready");
  return boss;
}

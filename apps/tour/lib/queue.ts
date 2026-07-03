// Web-side pg-boss client for the TOUR bot — ONLY enqueues; apps/tour-bot owns the
// workers. Same Postgres, schema "pgboss", so a job sent here is picked up there.
// Mirrors the league's web/lib/queue.ts (lazy single instance, survives hot-reload).
//
// Add a job type? Add an enqueueX() here AND a boss.work() in apps/tour-bot/src/queue.ts.
// The job name is the contract.
import { PgBoss } from "pg-boss";

declare global {
  // eslint-disable-next-line no-var
  var __tourPgboss: PgBoss | undefined;
  // eslint-disable-next-line no-var
  var __tourPgbossStart: Promise<void> | undefined;
}

function getBoss(): PgBoss {
  if (!globalThis.__tourPgboss) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set — cannot enqueue jobs");
    globalThis.__tourPgboss = new PgBoss({ connectionString: url, schema: "pgboss", max: 2 });
    globalThis.__tourPgboss.on("error", (err: Error) => console.warn("[pg-boss tour-web] error:", err));
  }
  return globalThis.__tourPgboss;
}

async function ensureStarted(): Promise<void> {
  if (!globalThis.__tourPgbossStart) {
    globalThis.__tourPgbossStart = getBoss()
      .start()
      .then(() => {
        console.log("[pg-boss tour-web] connected");
      })
      .catch((err) => {
        globalThis.__tourPgbossStart = undefined; // don't cache the failure
        throw err;
      });
  }
  return globalThis.__tourPgbossStart;
}

// Ask the bot to reconcile a season's Player/Captain Discord roles to the roster state.
// Debounced per season (a sub + reseed in one admin session = one sync). Fire-and-forget
// from mutations: NEVER let a queue hiccup fail the roster change itself.
export async function enqueueRoleReconcile(seasonName: string): Promise<void> {
  try {
    await ensureStarted();
    await getBoss().send("tour.roles.reconcile", { season: seasonName }, {
      retryLimit: 3,
      retryBackoff: true,
      singletonKey: `roles:${seasonName}`,
      singletonSeconds: 30,
    });
  } catch (err) {
    console.warn("[pg-boss tour-web] enqueueRoleReconcile failed:", err);
  }
}

// A set was decided (confirmed / forfeit) — post it to #results. Singleton per set so
// re-confirms / admin re-reports never double-post.
export async function enqueueAnnounceResult(setId: string): Promise<void> {
  try {
    await ensureStarted();
    await getBoss().send("tour.announce.result", { setId }, {
      retryLimit: 3,
      retryBackoff: true,
      singletonKey: `announce-set:${setId}`,
      singletonSeconds: 60,
    });
  } catch (err) {
    console.warn("[pg-boss tour-web] enqueueAnnounceResult failed:", err);
  }
}

// A draft pick was made — post it to #draft and DM the next captain ("on the clock").
// Full payload so the bot needs no reads. One job per pick (keyed on overall number).
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
export async function enqueueDraftPick(job: DraftPickJob): Promise<void> {
  try {
    await ensureStarted();
    await getBoss().send("tour.draft.pick", job, {
      retryLimit: 3,
      retryBackoff: true,
      singletonKey: `draft-pick:${job.season}:${job.overall}`,
      singletonSeconds: 60,
    });
  } catch (err) {
    console.warn("[pg-boss tour-web] enqueueDraftPick failed:", err);
  }
}

// Weekly pairing: it's now this captain's move (respond to a proposal / propose next).
export interface PairingTurnJob {
  discordId: string;
  kind: "respond" | "propose";
  weekNumber: number;
  myTeamName: string;
  oppTeamName: string;
  urlPath: string;
}
export async function enqueuePairingTurn(job: PairingTurnJob): Promise<void> {
  try {
    await ensureStarted();
    await getBoss().send("tour.pairing.turn", job, {
      retryLimit: 3,
      retryBackoff: true,
      singletonKey: `pairing-turn:${job.discordId}:${job.urlPath}:${job.kind}`,
      singletonSeconds: 60,
    });
  } catch (err) {
    console.warn("[pg-boss tour-web] enqueuePairingTurn failed:", err);
  }
}

// A matchup's team result just became decided — post the rollup banner.
export async function enqueueAnnounceMatchup(matchupId: string): Promise<void> {
  try {
    await ensureStarted();
    await getBoss().send("tour.announce.matchup", { matchupId }, {
      retryLimit: 3,
      retryBackoff: true,
      singletonKey: `announce-matchup:${matchupId}`,
      singletonSeconds: 60,
    });
  } catch (err) {
    console.warn("[pg-boss tour-web] enqueueAnnounceMatchup failed:", err);
  }
}

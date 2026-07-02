// Signups service — the season's registrant pool. Hybrid model (§14.2): players
// self-serve later via Discord OAuth; the committee curates by moving PENDING →
// APPROVED. The set of APPROVED signups IS the draft pool. Pure: validates +
// touches the DB, no auth (the caller gates). Keyed on (season, discordId).
import { prisma } from "../db";

export type SignupStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";

async function seasonIdByName(name: string) {
  const s = await prisma.tourSeason.findUnique({ where: { name }, select: { id: true } });
  if (!s) throw new Error(`No season "${name}"`);
  return s.id;
}

export async function listSignups(seasonName: string) {
  const seasonId = await seasonIdByName(seasonName);
  return prisma.signup.findMany({
    where: { seasonId },
    orderBy: [{ createdAt: "asc" }],
  });
}

export interface SignupInput {
  discordId: string;
  displayName?: string;
  timezone?: string;
  availability?: string;
  willingToCaptain?: boolean;
  bmpHandle?: string;
  // The real form (option labels stored verbatim — the wording is part of the culture):
  scheduleAgency?: string;
  playFrequency?: string;
  teamActivity?: string;
  coachWilling?: boolean;
  coachWanted?: boolean;
  coachingNote?: string;
  captainInterest?: string;
  helperInterest?: boolean;
  englishOk?: boolean;
  discordActivity?: number | null;
  upcomingBreaks?: string;
  weeklyCommit?: string;
  outreach?: string;
  modCheck?: string;
  respectPledge?: string;
  asyncExp?: string;
  comments?: string;
  twitchFollow?: string;
  // Auto-pulled (never asked):
  bmpMmr?: number | null;
  bmpTier?: string | null;
}

// Canonical option sets (exact wording from the historical form).
export const SIGNUP_OPTIONS = {
  scheduleAgency: [
    "Yes, I have commitments but I mostly control my freetime",
    "Somewhat, I have a lot of obligations, but can make time",
    "No, I do not have much control",
  ],
  captainInterest: ["Yes, I would love to!", "I will if it is needed", "Not interested"],
  upcomingBreaks: ["No", "Possibly", "Yes"],
  yesMaybeNo: ["Yes", "Maybe", "No"],
  asyncExp: ["Yes, in a similar tournament to this", "Yes, in other contexts", "No"],
  twitchFollow: ["Of course!", "Yes, and I'll subscribe with Twitch Prime!", "No, L self promo"],
} as const;

const clean = (v: string | undefined) => {
  const t = (v ?? "").trim();
  return t || null;
};

// Phases where adding a signup makes sense (the pool is still forming). After the
// draft builds rosters (REGULAR onward) there's no pool to add to.
const SIGNUP_OPEN_STATES = ["SIGNUPS", "DRAFTING"] as const;

// Upsert by (season, discordId) — idempotent, so re-submitting updates the row.
export async function addSignup(seasonName: string, input: SignupInput) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true, state: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  if (!(SIGNUP_OPEN_STATES as readonly string[]).includes(season.state)) {
    throw new Error(`Signups are closed for ${seasonName} (it's ${season.state.toLowerCase()}).`);
  }
  const seasonId = season.id;
  const discordId = (input.discordId ?? "").trim();
  if (!discordId) throw new Error("Discord ID is required");
  // willingToCaptain stays in sync with captainInterest (draft-pool queries key on it).
  const willingToCaptain =
    input.captainInterest != null ? input.captainInterest !== "Not interested" : !!input.willingToCaptain;
  const form = {
    scheduleAgency: clean(input.scheduleAgency),
    playFrequency: clean(input.playFrequency),
    teamActivity: clean(input.teamActivity),
    coachWilling: !!input.coachWilling,
    coachWanted: !!input.coachWanted,
    coachingNote: clean(input.coachingNote),
    captainInterest: clean(input.captainInterest),
    helperInterest: !!input.helperInterest,
    englishOk: input.englishOk ?? true,
    discordActivity: input.discordActivity ?? null,
    upcomingBreaks: clean(input.upcomingBreaks),
    weeklyCommit: clean(input.weeklyCommit),
    outreach: clean(input.outreach),
    modCheck: clean(input.modCheck),
    respectPledge: clean(input.respectPledge),
    asyncExp: clean(input.asyncExp),
    comments: clean(input.comments),
    twitchFollow: clean(input.twitchFollow),
    ...(input.bmpMmr != null ? { bmpMmr: input.bmpMmr, bmpTier: input.bmpTier ?? null } : {}),
  };
  return prisma.signup.upsert({
    where: { seasonId_discordId: { seasonId, discordId } },
    create: {
      seasonId,
      discordId,
      displayName: clean(input.displayName),
      timezone: clean(input.timezone),
      availability: clean(input.availability),
      willingToCaptain,
      bmpHandle: clean(input.bmpHandle),
      ...form,
    },
    update: {
      displayName: clean(input.displayName) ?? undefined,
      timezone: clean(input.timezone) ?? undefined,
      availability: clean(input.availability) ?? undefined,
      willingToCaptain,
      bmpHandle: clean(input.bmpHandle) ?? undefined,
      ...form,
    },
  });
}

// Prior-season participation per discordId — derived from roster history, so the form
// never has to ask "did you play last season?". Distinguishes captain / player / substitute.
export type PriorParticipation = { label: string; seasons: number } | null;
export async function priorParticipation(discordIds: string[]): Promise<Map<string, PriorParticipation>> {
  const out = new Map<string, PriorParticipation>();
  if (!discordIds.length) return out;
  const players = await prisma.player.findMany({ where: { discordId: { in: discordIds } }, select: { id: true, discordId: true } });
  const byPlayer = new Map(players.map((p) => [p.id, p.discordId]));
  if (!players.length) return out;
  const pids = players.map((p) => p.id);
  const [entries, captaincies, subs] = await Promise.all([
    prisma.rosterEntry.findMany({ where: { playerId: { in: pids } }, select: { playerId: true, roster: { select: { teamSeason: { select: { seasonId: true } } } } } }),
    prisma.teamSeason.findMany({ where: { captainPlayerId: { in: pids } }, select: { captainPlayerId: true } }),
    prisma.rosterMove.findMany({ where: { playerId: { in: pids }, kind: "SUB" }, select: { playerId: true } }),
  ]);
  const seasonsOf = new Map<string, Set<string>>();
  for (const e of entries) {
    const set = seasonsOf.get(e.playerId) ?? new Set<string>();
    set.add(e.roster.teamSeason.seasonId);
    seasonsOf.set(e.playerId, set);
  }
  const captained = new Set(captaincies.map((c) => c.captainPlayerId));
  const subbed = new Set(subs.map((s) => s.playerId));
  for (const [pid, discordId] of byPlayer) {
    const n = seasonsOf.get(pid)?.size ?? 0;
    if (!n) continue;
    const label = captained.has(pid) ? "captain" : subbed.has(pid) ? "substitute" : "player";
    out.set(discordId, { label, seasons: n });
  }
  return out;
}

// The season currently accepting self-serve signups (SIGNUPS state), if any.
export async function getOpenSignupSeason() {
  return prisma.tourSeason.findFirst({ where: { state: "SIGNUPS" }, orderBy: { createdAt: "desc" } });
}

export async function getMySignup(seasonId: string, discordId: string) {
  return prisma.signup.findUnique({ where: { seasonId_discordId: { seasonId, discordId } } });
}

// A player withdraws themselves (keeps the row + history; just flips status).
export async function withdrawSignup(seasonName: string, discordId: string) {
  const seasonId = await seasonIdByName(seasonName);
  const s = await prisma.signup.findUnique({ where: { seasonId_discordId: { seasonId, discordId } } });
  if (s) await prisma.signup.update({ where: { id: s.id }, data: { status: "WITHDRAWN" } });
}

export async function setSignupStatus(signupId: string, status: SignupStatus) {
  return prisma.signup.update({ where: { id: signupId }, data: { status } });
}

export async function removeSignup(signupId: string) {
  return prisma.signup.delete({ where: { id: signupId } });
}

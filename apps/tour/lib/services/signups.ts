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
}

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
  return prisma.signup.upsert({
    where: { seasonId_discordId: { seasonId, discordId } },
    create: {
      seasonId,
      discordId,
      displayName: clean(input.displayName),
      timezone: clean(input.timezone),
      availability: clean(input.availability),
      willingToCaptain: !!input.willingToCaptain,
      bmpHandle: clean(input.bmpHandle),
    },
    update: {
      displayName: clean(input.displayName) ?? undefined,
      timezone: clean(input.timezone) ?? undefined,
      availability: clean(input.availability) ?? undefined,
      willingToCaptain: input.willingToCaptain,
      bmpHandle: clean(input.bmpHandle) ?? undefined,
    },
  });
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

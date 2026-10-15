// Loader for the public /join landing page. Pulls the Discord invite URL,
// the currently-OPEN signup round (with a non-withdrawn signup count), the
// viewer's interest/signup state, and admin-ness for the inline config nudge.
// Auth (session lookup) happens here because the page's data IS auth-shaped;
// it does not gate access — /join is public.

import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { loadDiscordInviteUrl } from "@/lib/loaders/discord-invite";
import { signupSeasonLabel } from "@/lib/signup-season-label-core";

// Shared by loadJoinPageData and loadOpenSignupSummary below -- both need
// "does this round already have a built Season, and if so what's its
// number/subtitle" before they can derive a label, and that's the only
// query-shaped step signupSeasonLabel itself can't do (it's pure).
async function seasonInfoForRound(
  resultingSeasonId: string | null,
): Promise<{ seasonNumber: number | null; subtitle: string | null }> {
  if (!resultingSeasonId) return { seasonNumber: null, subtitle: null };
  const s = await prisma.season.findUnique({
    where: { id: resultingSeasonId },
    select: { number: true, subtitle: true },
  });
  return s ? { seasonNumber: s.number, subtitle: s.subtitle } : { seasonNumber: null, subtitle: null };
}

export interface JoinPageData {
  discordInviteUrl: string | null;
  openRound: {
    id: string;
    name: string;
    seasonLabel: string | null;
    signupCount: number;
  } | null;
  viewerDiscordId: string | null;
  viewerIsSubscribed: boolean;
  viewerIsSignedUp: boolean;
  // Only true for ADMIN+ tier viewers. Drives the inline "set the
  // invite URL" nudge that shows up when the LeagueConfig key is
  // empty — public visitors never see that message.
  viewerIsAdmin: boolean;
}

export async function loadJoinPageData(): Promise<JoinPageData> {
  const session = await auth();
  const viewerDiscordId =
    (session?.user as { discordId?: string } | undefined)?.discordId ?? null;

  const [discordInviteUrl, round, interest, mySignup] = await Promise.all([
    loadDiscordInviteUrl(),
    prisma.signupRound.findFirst({
      where: { status: "OPEN" },
      orderBy: { openedAt: "desc" },
      include: {
        // Count non-withdrawn signups for the public counter shown on
        // the page. _count on Prisma includes can't take a `where`
        // filter, so we shape this via a relation query instead.
        signups: { where: { withdrawn: false }, select: { id: true } },
      },
    }),
    viewerDiscordId
      ? prisma.seasonInterest.findUnique({ where: { discordId: viewerDiscordId } })
      : Promise.resolve(null),
    null,
  ]);

  // If the round has a resultingSeasonId, derive its label through the
  // one shared rule (lib/signup-season-label-core.ts) -- same helper
  // loadOpenSignupSummary below uses, so a round never gets a different
  // label depending on which loader asked. Unlike the old inline version,
  // this always returns a label (round-name-derived when no Season row
  // exists yet) instead of null -- the /join page's own `?? round.name`
  // fallback for that case still renders the same text either way.
  let seasonLabel: string | null = null;
  if (round) {
    const { seasonNumber, subtitle } = await seasonInfoForRound(round.resultingSeasonId);
    seasonLabel = signupSeasonLabel({ seasonNumber, subtitle, roundName: round.name });
  }

  // Second query — couldn't run in the Promise.all above because round.id
  // isn't known until after the round fetch resolves.
  let viewerIsSignedUp = false;
  if (round && viewerDiscordId) {
    const existing = await prisma.signup.findUnique({
      where: { roundId_discordId: { roundId: round.id, discordId: viewerDiscordId } },
    });
    viewerIsSignedUp = !!(existing && !existing.withdrawn);
  }
  void mySignup;

  // Admin check only runs if we know the viewer is logged in — saves
  // a roundtrip for anonymous public visitors.
  const viewerIsAdmin = viewerDiscordId ? await isAdminUser() : false;

  return {
    discordInviteUrl,
    openRound: round
      ? { id: round.id, name: round.name, seasonLabel, signupCount: round.signups.length }
      : null,
    viewerDiscordId,
    viewerIsSubscribed: !!interest,
    viewerIsSignedUp,
    viewerIsAdmin,
  };
}

// Play-window length for the "how it works" blurb. Default two weeks; admins
// can change season_length_days on /admin/config.
export async function loadSeasonLengthDays(): Promise<number> {
  const lenRow = await prisma.leagueConfig.findUnique({ where: { key: "season_length_days" } });
  return Number(lenRow?.value) > 0 ? Number(lenRow!.value) : 14;
}

// The currently-OPEN signup round, id only — drives the "sign-ups are open"
// CTA on the public /standings page. Most-recently opened wins. Kept
// alongside loadOpenSignupSummary below (which most new callers want
// instead) since SiteNav only needs the boolean "is something open".
export async function loadOpenSignupRoundId(): Promise<{ id: string } | null> {
  return prisma.signupRound.findFirst({
    where: { status: "OPEN" },
    orderBy: { openedAt: "desc" },
    select: { id: true },
  });
}

export interface OpenSignupSummary {
  id: string;
  name: string;
  seasonLabel: string;
  signupCount: number;
  closesAt: Date | null;
}

// The currently-OPEN signup round, named -- drives the home page hero line
// and the StandingsBoard banner (components/StandingsBoard.tsx), both of
// which need to say WHICH season is signing up, not just that one is.
// Most-recently-opened round wins, same tie-break as loadOpenSignupRoundId.
export async function loadOpenSignupSummary(): Promise<OpenSignupSummary | null> {
  const round = await prisma.signupRound.findFirst({
    where: { status: "OPEN" },
    orderBy: { openedAt: "desc" },
    include: {
      signups: { where: { withdrawn: false }, select: { id: true } },
    },
  });
  if (!round) return null;

  const { seasonNumber, subtitle } = await seasonInfoForRound(round.resultingSeasonId);

  return {
    id: round.id,
    name: round.name,
    seasonLabel: signupSeasonLabel({ seasonNumber, subtitle, roundName: round.name }),
    signupCount: round.signups.length,
    closesAt: round.closesAt,
  };
}

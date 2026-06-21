// Loader for the public /join landing page. Pulls the Discord invite URL,
// the currently-OPEN signup round (with a non-withdrawn signup count), the
// viewer's interest/signup state, and admin-ness for the inline config nudge.
// Auth (session lookup) happens here because the page's data IS auth-shaped;
// it does not gate access — /join is public.

import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { prisma } from "@/lib/prisma";

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

  const [inviteRow, round, interest, mySignup] = await Promise.all([
    prisma.leagueConfig.findUnique({
      where: { key: "discord_server_invite_url" },
      select: { value: true },
    }),
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

  // If the round has a resultingSeasonId, fetch its label for context.
  let seasonLabel: string | null = null;
  if (round?.resultingSeasonId) {
    const s = await prisma.season.findUnique({
      where: { id: round.resultingSeasonId },
      select: { number: true, subtitle: true },
    });
    if (s) {
      seasonLabel = s.subtitle ? `Season ${s.number} — ${s.subtitle}` : `Season ${s.number}`;
    }
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
    discordInviteUrl: inviteRow?.value ?? null,
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
// CTA on the public /standings page. Most-recently opened wins.
export async function loadOpenSignupRoundId(): Promise<{ id: string } | null> {
  return prisma.signupRound.findFirst({
    where: { status: "OPEN" },
    orderBy: { openedAt: "desc" },
    select: { id: true },
  });
}

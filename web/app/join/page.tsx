// Public landing page for prospective players. Three states depending
// on auth + whether a signup round is currently OPEN:
//
//   1. Logged-out         → invite link + "Sign in with Discord" CTA
//   2. Logged-in, no round → opt-in toggle for next-season notifications
//   3. Logged-in, OPEN round → one-click sign-up + opt-in toggle
//
// All data flows through loadJoinPageData; mutations live in actions.ts.

import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { SiteNav } from "@/components/SiteNav";
import {
  signupFromJoinAction,
  subscribeFromJoinAction,
  unsubscribeFromJoinAction,
  withdrawFromJoinAction,
} from "./actions";

export const dynamic = "force-dynamic";

interface JoinPageData {
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

async function loadJoinPageData(): Promise<JoinPageData> {
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

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const { ok, err } = await searchParams;
  const data = await loadJoinPageData();
  const isLoggedIn = !!data.viewerDiscordId;

  // Play-window length for the "how it works" blurb. Default two weeks; admins
  // can change season_length_days on /admin/config.
  const lenRow = await prisma.leagueConfig.findUnique({ where: { key: "season_length_days" } });
  const lenDays = Number(lenRow?.value) > 0 ? Number(lenRow!.value) : 14;
  const playWindowLabel = lenDays % 7 === 0 ? `${lenDays / 7} week${lenDays / 7 === 1 ? "" : "s"}` : `${lenDays} days`;

  return (
    <>
      <SiteNav activePath="/join" />
      <main>
        <h2>Join the league</h2>
        <p className="muted">
          A Balatro multiplayer league on Discord. Sign up, get put in a division, and play
          your assigned opponents — 2 games each. Climb the divisions season to season.
        </p>

        {ok === "signed-up" && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ You're signed up. You'll get your division when the season starts — keep an eye on Discord.
          </div>
        )}
        {ok === "withdrew" && (
          <div className="card" style={{ borderColor: "#f1c40f", color: "#f1c40f" }}>
            You've withdrawn from this round. Sign up again any time before sign-ups close.
          </div>
        )}
        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        {/* Step 1: Discord server invite. Hidden entirely when no URL
            is configured — surfacing a "no link set" warning to public
            visitors looks broken. Admin gets an inline nudge instead so
            they know to set the config. */}
        {data.discordInviteUrl && (
          <div className="card">
            <strong>Step 1 — Join the Discord server</strong>
            <p className="muted" style={{ marginTop: 4 }}>
              Matches and results all happen in Discord. Join the server before you sign up.
            </p>
            <a
              href={data.discordInviteUrl}
              target="_blank"
              rel="noreferrer"
              className="primary-btn"
              style={{
                display: "inline-block",
                background: "#5865f2",
                color: "white",
                padding: "8px 16px",
                borderRadius: 4,
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              <Image src="/Balatro_League.png" alt="" width={16} height={16} className="mr-1.5 inline-block rounded-[2px] align-[-2px]" /> Open Discord invite
            </a>
          </div>
        )}
        {!data.discordInviteUrl && data.viewerIsAdmin && (
          <div className="card" style={{ borderColor: "#f1c40f" }}>
            <strong style={{ color: "#f1c40f" }}>⚠ Admin nudge:</strong>{" "}
            <span className="muted">
              No public invite link configured. Set{" "}
              <code>discord_server_invite_url</code> on{" "}
              <Link href="/admin/config">/admin/config</Link> so the Step 1 card
              appears for visitors.
            </span>
          </div>
        )}

        {/* Step 2: depends on auth state + whether a round is open. */}
        {!isLoggedIn ? (
          <div className="card">
            <strong>Step 2 — Sign in with Discord</strong>
            <p className="muted" style={{ marginTop: 4 }}>
              So your signup links to your account. No password needed.
            </p>
            <Link
              href="/auth/signin?callbackUrl=%2Fjoin"
              style={{
                display: "inline-block",
                background: "#5865f2",
                color: "white",
                padding: "8px 16px",
                borderRadius: 4,
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Sign in with Discord
            </Link>
          </div>
        ) : (
          <>
            {data.openRound ? (
              <div className="card">
                <strong>Step 2 — {data.openRound.seasonLabel ?? data.openRound.name} is open!</strong>
                <p className="muted" style={{ marginTop: 4 }}>
                  {data.openRound.signupCount} player{data.openRound.signupCount === 1 ? "" : "s"} signed up so far.
                </p>
                {data.viewerIsSignedUp ? (
                  <div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={{ color: "#2ecc71", fontWeight: 600 }}>
                        ✓ You're signed up.
                      </span>
                      <form action={withdrawFromJoinAction}>
                        <input type="hidden" name="roundId" value={data.openRound.id} />
                        <Button type="submit" variant="secondary" size="sm">Withdraw</Button>
                      </form>
                    </div>
                    <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      That&apos;s it — you&apos;ll get your division when the season starts. Withdraw any time before signups close.
                    </p>
                  </div>
                ) : (
                  <form action={signupFromJoinAction}>
                    <input type="hidden" name="roundId" value={data.openRound.id} />
                    <Button type="submit" className="bg-[var(--success)] text-white hover:opacity-90">
                      <Image src="/Balatro_League.png" alt="" width={16} height={16} className="mr-1.5 inline-block rounded-[2px] align-[-2px]" /> Sign me up
                    </Button>
                    <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                      You can also click the <strong>Sign Up</strong> button on the signup post in Discord.
                      Both create the same registration.
                    </p>
                  </form>
                )}
              </div>
            ) : (
              <div className="card">
                <strong>Step 2 — No active signup right now</strong>
                <p className="muted" style={{ marginTop: 4 }}>
                  No season is currently accepting signups. Toggle below to get a DM the moment the next one opens.
                </p>
                {data.viewerIsSubscribed ? (
                  <form action={unsubscribeFromJoinAction}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ color: "#2ecc71", fontWeight: 600 }}>
                        ✓ You'll be notified when signups open.
                      </span>
                      <Button type="submit" variant="secondary" size="sm">Turn off</Button>
                    </div>
                  </form>
                ) : (
                  <form action={subscribeFromJoinAction}>
                    <Button type="submit">🔔 Notify me when next season opens</Button>
                    <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                      We&apos;ll DM you when signups open. Manage anytime from your <Link href="/me">profile</Link>.
                    </p>
                  </form>
                )}
              </div>
            )}
          </>
        )}

        <div className="card muted" style={{ fontSize: 13 }}>
          <strong>How it works</strong>
          <ul style={{ marginTop: 6 }}>
            <li>Sign up and wait for the season to start.</li>
            <li>You&apos;re placed in a division and get a Discord channel for it.</li>
            <li>Play 2 games against each of your assigned opponents (top divisions play everyone; most play 4 others). You get about {playWindowLabel} to finish.</li>
            <li>Finish near the top to move up a division next season, near the bottom to move down.</li>
          </ul>
        </div>
      </main>
    </>
  );
}

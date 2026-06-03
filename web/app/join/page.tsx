// Public landing page for prospective players. Three states depending
// on auth + whether a signup round is currently OPEN:
//
//   1. Logged-out         → invite link + "Sign in with Discord" CTA
//   2. Logged-in, no round → opt-in toggle for next-season notifications
//   3. Logged-in, OPEN round → one-click sign-up + opt-in toggle
//
// All data flows through loadJoinPageData; mutations live in actions.ts.

import Link from "next/link";
import { auth } from "@/auth";
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

  return {
    discordInviteUrl: inviteRow?.value ?? null,
    openRound: round
      ? { id: round.id, name: round.name, seasonLabel, signupCount: round.signups.length }
      : null,
    viewerDiscordId,
    viewerIsSubscribed: !!interest,
    viewerIsSignedUp,
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

  return (
    <>
      <SiteNav activePath="/join" />
      <main>
        <h2>Join the league</h2>
        <p className="muted">
          A round-robin Balatro multiplayer league with promotion/relegation
          divisions. Best-of-2 sets, weekly play, run by humans, all on Discord.
        </p>

        {ok === "signed-up" && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ You're signed up. See you in Discord when the season starts.
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

        {/* Step 1: Discord server invite. Always shown so people know
            where the league actually runs even if they haven't logged in. */}
        <div className="card">
          <strong>Step 1 — Join the Discord server</strong>
          <p className="muted" style={{ marginTop: 4 }}>
            Everything happens in Discord — match scheduling, ban/pick, results.
            You need to be in the server before signups so the bot can DM you
            and assign your division role.
          </p>
          {data.discordInviteUrl ? (
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
              🃏 Open Discord invite
            </a>
          ) : (
            <p className="muted">
              No public invite link configured yet. Ask the league admin to set{" "}
              <code>discord_server_invite_url</code> on <code>/admin/config</code>.
            </p>
          )}
        </div>

        {/* Step 2: depends on auth state + whether a round is open. */}
        {!isLoggedIn ? (
          <div className="card">
            <strong>Step 2 — Sign in with Discord</strong>
            <p className="muted" style={{ marginTop: 4 }}>
              We use Discord login so signups + notifications go to the right account.
              No password to remember.
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
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ color: "#2ecc71", fontWeight: 600 }}>
                      ✓ You're signed up.
                    </span>
                    <form action={withdrawFromJoinAction}>
                      <input type="hidden" name="roundId" value={data.openRound.id} />
                      <button type="submit" className="secondary" style={{ fontSize: 12 }}>
                        Withdraw
                      </button>
                    </form>
                  </div>
                ) : (
                  <form action={signupFromJoinAction}>
                    <input type="hidden" name="roundId" value={data.openRound.id} />
                    <button
                      type="submit"
                      style={{
                        background: "#2ecc71",
                        color: "white",
                        padding: "8px 16px",
                        borderRadius: 4,
                        border: "none",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      🃏 Sign me up
                    </button>
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
                      <button type="submit" className="secondary" style={{ fontSize: 12 }}>
                        Turn off
                      </button>
                    </div>
                  </form>
                ) : (
                  <form action={subscribeFromJoinAction}>
                    <button
                      type="submit"
                      style={{
                        background: "#5865f2",
                        color: "white",
                        padding: "8px 16px",
                        borderRadius: 4,
                        border: "none",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      🔔 Notify me when next season opens
                    </button>
                    <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                      The bot DMs you the moment the league admin opens the next signup round.
                      Manage from your <Link href="/me">profile</Link> any time.
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
            <li>Sign up → admin builds divisions → you get a Discord role + channel for your division.</li>
            <li>Best-of-2 sets against every other player in your division.</li>
            <li>Top finishers promote, bottom finishers relegate, ties broken by 1-game showdowns.</li>
            <li>Season ends, ratings recompute, next season opens with the same flow.</li>
          </ul>
        </div>
      </main>
    </>
  );
}

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
import { SiteNav } from "@/components/SiteNav";
import { Callout } from "@/components/Callout";
import { loadJoinPageData, loadSeasonLengthDays } from "@/lib/loaders/join";
import {
  signupFromJoinAction,
  subscribeFromJoinAction,
  unsubscribeFromJoinAction,
  withdrawFromJoinAction,
} from "./actions";

export const dynamic = "force-dynamic";

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
  const lenDays = await loadSeasonLengthDays();
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
          <Callout type="success">
            ✓ You're signed up. You'll get your division when the season starts — keep an eye on Discord.
          </Callout>
        )}
        {ok === "withdrew" && (
          <Callout type="accent">
            You've withdrawn from this round. Sign up again any time before sign-ups close.
          </Callout>
        )}
        {err && (
          <Callout type="danger">
            {err}
          </Callout>
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
                background: "var(--accent-2)",
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
          <div className="card card-accent">
            <strong style={{ color: "var(--accent)" }}>⚠ Admin nudge:</strong>{" "}
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
                background: "var(--accent-2)",
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
                      <span style={{ color: "var(--success)", fontWeight: 600 }}>
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
                      <span style={{ color: "var(--success)", fontWeight: 600 }}>
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

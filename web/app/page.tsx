// Home page (`/`). Used to be a bare 307 to /standings with no landing
// content at all (SEO audit finding 5, .claude/knowledge/seo/01-audit-and-plan.md
// Tier 2 item 1) -- the site had nothing to say about itself to a crawler or
// a first-time visitor landing on the bare domain. This is a real
// server-rendered page: a one-sentence pitch, three short intro blocks (how
// it works, this season, join), then the FULL standings embedded below
// through the exact same data path and components /standings itself uses
// (components/StandingsBoard.tsx) -- so this page both pitches the league
// AND proves it's live and active without a click.
//
// /standings stays the canonical URL for the standings CONTENT (its own
// pageMetadata canonical is unchanged); this page's own canonical is "/".
// The embedded board here renders its season heading as h2 (not h1) since
// this page's own h1 is "Balatro League" -- one h1 per page, per
// design-system/MASTER.md and the SEO audit's L7 single-h1 fix -- and
// suppresses its own open-signups banner since the "Join" block below
// already covers that CTA prominently.

import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { SiteNav } from "@/components/SiteNav";
import { StandingsBoard } from "@/components/StandingsBoard";
import { SeasonWindow } from "@/components/SeasonWindow";
import { loadStandingsPageData } from "@/lib/loaders/standings";
import { loadOpenSignupRoundId } from "@/lib/loaders/join";
import { loadDiscordInviteUrl } from "@/lib/loaders/discord-invite";
import { getShowBmpMmr } from "@/lib/preferences";
import { pageMetadata } from "@/lib/seo";
import { seasonMatchTotals, seasonProgressLine, topDivisionRows } from "@/lib/home-page-core";

export const dynamic = "force-dynamic"; // Always fresh -- same reasoning as /standings

const DESCRIPTION =
  "A free, community-run Balatro multiplayer league played on Discord with the Balatro Multiplayer mod. Sign up, get placed in a division by rating, and play your scheduled opponents every season.";

// The home page is the one place the brand name belongs FIRST in the
// <title> ("Balatro League | ..."), not appended after a per-page subject
// via the root layout's "%s | Balatro League" template every other page
// uses -- `title.absolute` bypasses that template for just this field.
// openGraph/twitter still go through pageMetadata's normal `title` input
// (plain "Balatro League", matching the root layout's own default OG title)
// so a pasted link's unfurl card isn't needlessly long.
export const metadata: Metadata = {
  ...pageMetadata({ title: "Balatro League", description: DESCRIPTION, path: "/" }),
  title: { absolute: "Balatro League | Balatro Multiplayer league on Discord" },
};

export default async function HomePage() {
  const showBmpMmr = await getShowBmpMmr();
  const session = await auth();
  const viewerDiscordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  const [data, openRound, discordInviteUrl] = await Promise.all([
    loadStandingsPageData({ showBmpMmr, viewerDiscordId }),
    loadOpenSignupRoundId(),
    loadDiscordInviteUrl(),
  ]);

  const { totalPlayed, totalExpected } = seasonMatchTotals(data.tiers);
  const legendaryTop = topDivisionRows(data.tiers, "Legendary", 3);

  return (
    <>
      <SiteNav activePath="/" />
      <main>
        <div className="card">
          <h1>Balatro League</h1>
          <p className="muted" style={{ marginTop: 4, fontSize: 16 }}>
            A free Balatro Multiplayer league on Discord: divisions, promotion and relegation, a new
            season every few weeks.
          </p>
        </div>

        <div className="grid grid-3">
          <div className="card">
            <h2>How it works</h2>
            <ol style={{ margin: "8px 0", paddingLeft: 20, display: "grid", gap: 6, listStyle: "decimal" }}>
              <li>Sign up for the next season.</li>
              <li>Get placed in a division by rating.</li>
              <li>Play your scheduled opponents and report results -- climb the divisions season to season.</li>
            </ol>
            <p style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
              <Link href="/how-it-works">Full rules</Link>
              <Link href="/join">Join the league</Link>
            </p>
          </div>

          <div className="card">
            <h2>This season</h2>
            {data.season ? (
              <>
                <p className="pixel" style={{ fontSize: 18, marginTop: 4 }}>{data.season.name}</p>
                <SeasonWindow start={data.season.startedAt} end={data.season.scheduledEndAt} />
                <p className="muted" style={{ marginTop: 8 }}>
                  {seasonProgressLine({ totalPlayed, totalExpected })}
                </p>
                {legendaryTop.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".8px" }}>
                      Top of Legendary
                    </div>
                    <ol style={{ margin: "6px 0 0", paddingLeft: 20, listStyle: "decimal" }}>
                      {legendaryTop.map((row) => (
                        <li key={row.rank}>
                          {row.displayName} <span className="muted">-- {row.points} pts</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                <p style={{ marginTop: 10 }}>
                  <Link href="#standings">Full standings below</Link>
                </p>
              </>
            ) : (
              <>
                <p className="muted" style={{ marginTop: 4 }}>No active season right now.</p>
                <p style={{ marginTop: 10 }}>
                  <Link href="/join">Get notified for the next one</Link>
                </p>
              </>
            )}
          </div>

          <div className="card">
            <h2>Join</h2>
            <p className="muted" style={{ marginTop: 4 }}>
              Free to join. Sign in with Discord, get placed in a division, and play your scheduled
              opponents.
            </p>
            <p style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <Button
                render={<Link href="/join" />}
                nativeButton={false}
                className="h-11 px-5 text-base"
                style={{ background: "var(--gold)", color: "var(--gold-ink)" }}
              >
                Join the league
              </Button>
              {discordInviteUrl && (
                <Button
                  render={<a href={discordInviteUrl} target="_blank" rel="noreferrer" />}
                  nativeButton={false}
                  variant="secondary"
                  className="h-11 px-5 text-base"
                >
                  Open Discord invite
                </Button>
              )}
            </p>
            <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
              There is also the{" "}
              <a href="https://tour.balatroleague.com/" target="_blank" rel="noreferrer">
                Pizza Power Team Tour
              </a>
              , a drafted-team version of the same mod.
            </p>
          </div>
        </div>

        {/* Anchor target for the "This season" card's "Full standings below"
            link -- StandingsBoard renders its own h2 ("Standings" / "<season>
            -- Standings"), so this wraps it rather than adding a second,
            redundant "Standings" heading right above it. */}
        <div id="standings" style={{ scrollMarginTop: 16 }}>
          <StandingsBoard
            data={data}
            openRound={openRound}
            showBmpMmr={showBmpMmr}
            headingLevel="h2"
            showOpenSignupBanner={false}
          />
        </div>
      </main>
    </>
  );
}

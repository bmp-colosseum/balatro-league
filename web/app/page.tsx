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
import { loadStandingsPageData } from "@/lib/loaders/standings";
import { loadOpenSignupRoundId } from "@/lib/loaders/join";
import { loadDiscordInviteUrl } from "@/lib/loaders/discord-invite";
import { getShowBmpMmr } from "@/lib/preferences";
import { pageMetadata } from "@/lib/seo";

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


  return (
    <>
      <SiteNav activePath="/" />
      <main>
        <div className="card home-hero" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, justifyContent: "space-between" }}>
          <div style={{ minWidth: 0, flex: "1 1 320px" }}>
            <h1 style={{ margin: 0 }}>Balatro League</h1>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 15 }}>
              A free Balatro Multiplayer league on Discord: divisions, promotion and relegation, a new
              season every few weeks.
            </p>
          </div>
          <p style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: 0 }}>
            <Button
              render={<Link href="/join" />}
              nativeButton={false}
              className="h-11 px-5 text-base"
              style={{ background: "var(--gold)", color: "var(--gold-ink)" }}
            >
              Join the league
            </Button>
            <Button render={<Link href="/how-it-works" />} nativeButton={false} variant="secondary" className="h-11 px-5 text-base">
              How it works
            </Button>
            {discordInviteUrl && (
              <Button
                render={<a href={discordInviteUrl} target="_blank" rel="noreferrer" />}
                nativeButton={false}
                variant="secondary"
                className="h-11 px-5 text-base"
              >
                Discord
              </Button>
            )}
          </p>
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

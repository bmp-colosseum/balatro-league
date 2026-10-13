import { auth } from "@/auth";
import { loadStandingsPageData } from "@/lib/loaders/standings";
import { loadOpenSignupRoundId } from "@/lib/loaders/join";
import { getShowBmpMmr } from "@/lib/preferences";
import { SiteNav } from "@/components/SiteNav";
import { StandingsBoard } from "@/components/StandingsBoard";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic"; // Always fresh — DB writes happen out-of-band via the bot

export const metadata = pageMetadata({
  title: "Standings",
  description: "Current Balatro League standings across every division, updated live as matches are reported.",
  path: "/standings",
});

export default async function StandingsPage() {
  const showBmpMmr = await getShowBmpMmr();
  // Viewer's Discord id (for the v2 "you" badge) -- undefined when signed
  // out, same session shape SiteNav/the /me page already read.
  const session = await auth();
  const viewerDiscordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  const [data, openRound] = await Promise.all([
    loadStandingsPageData({ showBmpMmr, viewerDiscordId }),
    loadOpenSignupRoundId(),
  ]);

  return (
    <>
      <SiteNav activePath="/standings" />
      <main>
        <StandingsBoard data={data} openRound={openRound} showBmpMmr={showBmpMmr} />
      </main>
    </>
  );
}

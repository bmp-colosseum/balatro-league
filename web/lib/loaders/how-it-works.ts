// Loader for the public /how-it-works page. Derives the same
// OnboardingGuideInput the bot's onboarding DM builds (src/onboarding-dm.ts)
// from the active season + support-channel config, so the page's copy never
// disagrees with what a new player gets DMed -- same fallback to "the
// current season" / no window line when no season is active (the evergreen
// case), same support-channel jump link derivation.

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";
import { buildOnboardingGuideSections, type OnboardingGuideContent } from "@/lib/onboarding-guide";
import { seasonWindowLinesPlain } from "@/lib/season-window-text";

// Same convention as web/lib/report.ts / signup-discord.ts for building an
// absolute site URL from inside the web app itself.
function siteUrl(path: string): string {
  const base = (process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "") || "https://www.balatroleague.com";
  return `${base}${path}`;
}

export interface HowItWorksPageData {
  content: OnboardingGuideContent;
  // Whether there's a currently-active season -- purely informational for
  // the page (e.g. to decide whether to show a "Season N" eyebrow); the
  // guide content itself already degrades to evergreen wording on its own
  // when this is false.
  hasActiveSeason: boolean;
  // Same jump link fed into the "need-help" section's body -- exposed
  // separately so the page's own "Something wrong with a result?" closer
  // can link the support channel without parsing it back out of the guide's
  // rendered HTML.
  supportChannelUrl: string | null;
}

export async function loadHowItWorksPageData(): Promise<HowItWorksPageData> {
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    select: { number: true, subtitle: true, startedAt: true, scheduledStartAt: true, scheduledEndAt: true },
  });

  const seasonLabel = season ? formatSeasonLabel(season) : "the current season";
  const seasonWindowLines = season
    ? seasonWindowLinesPlain({
        scheduledStartAt: season.scheduledStartAt,
        startedAt: season.startedAt,
        scheduledEndAt: season.scheduledEndAt,
        isActive: true,
      })
    : [];

  const supportChannelRow = await prisma.leagueConfig.findUnique({
    where: { key: "support_channel_id" },
    select: { value: true },
  });
  const guildId = process.env.DISCORD_GUILD_ID;
  const supportChannelUrl =
    guildId && supportChannelRow?.value ? `https://discord.com/channels/${guildId}/${supportChannelRow.value}` : null;

  const content = buildOnboardingGuideSections({
    seasonLabel,
    seasonWindowLines,
    standingsUrl: siteUrl("/standings"),
    supportChannelUrl,
  });

  return { content, hasActiveSeason: !!season, supportChannelUrl };
}

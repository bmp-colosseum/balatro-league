// Thin route wrapper — the actual UI lives in the shared <ProfileView>, which
// /me renders too (no redirect). This page just maps the [id] param +
// dispute query flags onto it.
import { cache } from "react";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { ProfileView } from "@/components/ProfileView";
import { JsonLd } from "@/components/JsonLd";
import { pageMetadata, absoluteUrl } from "@/lib/seo";
import { breadcrumbJsonLd } from "@/lib/json-ld";

export const dynamic = "force-dynamic";

// React's request memoization: generateMetadata and the page component both want
// just the display name, so this runs once per request no matter how many callers
// ask for it (same pattern as lib/tour-profile.ts's tourProfilePath).
const loadPlayerName = cache(async (id: string) =>
  prisma.player.findUnique({ where: { id }, select: { displayName: true } }),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const player = await loadPlayerName(id);
  // title.absolute bypasses the root layout's "%s | Balatro League" template --
  // a plain string here would otherwise double up to "Balatro League | Balatro League".
  if (!player) return { title: { absolute: "Balatro League" } };
  // Indexable as of 2026-10-13 -- the TO decided exposing Discord display names/
  // avatars to search is fine (was an open question in the SEO audit; see
  // docs/handbook/seo.md). No noIndex here: a real title/description/canonical,
  // same as every other public page.
  return pageMetadata({
    title: player.displayName,
    description: `${player.displayName}'s Balatro League match history, division, and stats.`,
    path: `/profile/${id}`,
  });
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ disputeOk?: string; disputeErr?: string }>;
}) {
  const { id } = await params;
  const { disputeOk, disputeErr } = await searchParams;
  // Best-effort for the breadcrumb's own label -- a missing/renamed player still
  // renders ProfileView (which does its own notFound() handling); the breadcrumb
  // just falls back to a generic "Profile" crumb rather than blocking the page.
  const player = await loadPlayerName(id);
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Standings", url: absoluteUrl("/standings") },
          { name: player?.displayName ?? "Profile", url: absoluteUrl(`/profile/${id}`) },
        ])}
      />
      <ProfileView playerId={id} disputeOk={disputeOk} disputeErr={disputeErr} />
    </>
  );
}

import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { SITE_URL } from "@/lib/seo";
import { buildSitemapEntries, type SitemapEntryInput } from "@/lib/seo/sitemap-entries";

// Next caches a metadata route like this one at build time unless it's told
// otherwise -- same reasoning as every DB-backed page in this app (see
// app/standings/page.tsx's "Always fresh -- DB writes happen out-of-band via the
// bot"). Without this, `next build` tries to run the Prisma queries below at build
// time (no DATABASE_URL / DB reachable from a CI build box) instead of per-request.
export const dynamic = "force-dynamic";

// Static public routes. /players is deliberately excluded: it redirects signed-out
// visitors (incl. Googlebot) straight to /auth/signin, so a sitemap entry would just
// point crawlers at a 307 with nothing to index. /changes 404s for non-admins, same
// reasoning. See docs/handbook/seo.md.
const STATIC_PATHS: SitemapEntryInput[] = [
  { path: "/standings" },
  { path: "/seasons" },
  { path: "/hall-of-fame" },
  { path: "/how-it-works" },
  { path: "/join" },
  { path: "/stats" },
  { path: "/traits" },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // One query each for every season / division row, non-archived only -- division's
  // own `season` relation is already selected here so lastModified for both comes
  // out of these two queries with no extra round trips ("cheap", per the plan).
  // Profile paths: two groupBy aggregates over Match (indexed on playerAId/
  // playerBId, filtered to CONFIRMED -- a played, counted result), each player's
  // id paired with their latest confirmedAt across either side of the match. A
  // player who's never played a confirmed match gets no sitemap entry (their
  // profile still exists and is still indexable if linked to -- it's just not
  // worth a crawl budget entry with nothing on it).
  const [seasons, divisions, playedAsA, playedAsB] = await Promise.all([
    prisma.season.findMany({
      where: { archivedAt: null },
      select: { id: true, startedAt: true, endedAt: true, scheduledEndAt: true },
    }),
    prisma.division.findMany({
      where: { season: { archivedAt: null } },
      select: {
        id: true,
        season: { select: { startedAt: true, endedAt: true, scheduledEndAt: true } },
      },
    }),
    prisma.match.groupBy({
      by: ["playerAId"],
      where: { status: "CONFIRMED" },
      _max: { confirmedAt: true },
    }),
    prisma.match.groupBy({
      by: ["playerBId"],
      where: { status: "CONFIRMED" },
      _max: { confirmedAt: true },
    }),
  ]);

  const seasonPaths: SitemapEntryInput[] = seasons.map((s) => ({
    path: `/seasons/${s.id}`,
    lastModified: s.endedAt ?? s.scheduledEndAt ?? s.startedAt,
  }));
  const divisionPaths: SitemapEntryInput[] = divisions.map((d) => ({
    path: `/divisions/${d.id}`,
    lastModified: d.season.endedAt ?? d.season.scheduledEndAt ?? d.season.startedAt,
  }));

  // Merge both sides -- a player's most recent confirmed match might be as
  // either playerA or playerB, so take whichever side's max is later.
  const lastPlayedByPlayerId = new Map<string, Date>();
  for (const row of playedAsA) {
    if (row._max.confirmedAt) lastPlayedByPlayerId.set(row.playerAId, row._max.confirmedAt);
  }
  for (const row of playedAsB) {
    if (!row._max.confirmedAt) continue;
    const existing = lastPlayedByPlayerId.get(row.playerBId);
    if (!existing || row._max.confirmedAt > existing) lastPlayedByPlayerId.set(row.playerBId, row._max.confirmedAt);
  }
  const profilePaths: SitemapEntryInput[] = Array.from(lastPlayedByPlayerId.entries()).map(
    ([playerId, lastModified]) => ({ path: `/profile/${playerId}`, lastModified }),
  );

  return buildSitemapEntries(SITE_URL, [...STATIC_PATHS, ...seasonPaths, ...divisionPaths, ...profilePaths]);
}

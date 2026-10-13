// Pure builder for app/robots.ts's returned object -- no Next.js import here (the
// shape below is structurally identical to Next's MetadataRoute.Robots, so app/
// robots.ts just returns this call directly), so this stays testable from
// web/lib without pulling in "next" or its route-handler machinery.
//
// NOTE: /profile is NOT in the disallow list -- player profiles are indexable
// public content as of 2026-10-13 (the TO decided exposing Discord display
// names/avatars to search is fine; see docs/handbook/seo.md), so of course
// they're crawlable. The same principle applies to any FUTURE noindex-but-
// crawlable page too: a page's <meta name="robots" content="noindex"> only
// works if the crawler is ALLOWED to fetch the page and see that tag --
// disallowing it in robots.txt would hide the noindex instruction itself and
// risk the bare URL getting indexed anyway (from external links) with no
// description. Block real private sections here; use per-page noindex (lib/
// seo.ts's `noIndex` flag) for "crawlable but not indexed" ones.

export interface RobotsRules {
  rules: { userAgent: string; allow: string; disallow: string[] };
  sitemap: string;
}

export function buildRobotsRules(siteUrl: string, disallow: string[]): RobotsRules {
  return {
    rules: { userAgent: "*", allow: "/", disallow },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}

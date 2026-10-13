// Pure builder for app/robots.ts's returned object -- no Next.js import here (the
// shape below is structurally identical to Next's MetadataRoute.Robots, so app/
// robots.ts just returns this call directly), so this stays testable from
// web/lib without pulling in "next" or its route-handler machinery.
//
// NOTE: /profile is deliberately NOT in the disallow list even though profiles are
// noindex (see lib/seo.ts's `noIndex` flag, used by app/profile/[id]/page.tsx).
// Google's own guidance is that a page's <meta name="robots" content="noindex">
// only works if the crawler is ALLOWED to fetch the page and see that tag --
// disallowing it in robots.txt would hide the noindex instruction itself and risk
// the bare URL getting indexed anyway (from external links) with no
// description. Block real private sections here; use per-page noindex for
// "crawlable but not indexed" ones.

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

import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";
import { buildRobotsRules } from "@/lib/seo/robots-rules";

// Real private sections only -- /profile is intentionally NOT here even though
// profile pages are noindex (see lib/seo/robots-rules.ts's comment: a page can only
// honor a <meta name="robots" content="noindex"> if the crawler is allowed to fetch
// it in the first place).
const DISALLOW = ["/admin", "/me", "/auth", "/report", "/changes", "/api"];

export default function robots(): MetadataRoute.Robots {
  return buildRobotsRules(SITE_URL, DISALLOW);
}

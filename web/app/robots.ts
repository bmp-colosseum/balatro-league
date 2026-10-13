import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";
import { buildRobotsRules } from "@/lib/seo/robots-rules";

// Real private sections only -- /profile is indexable public content (see lib/
// seo/robots-rules.ts's comment for why a noindex-but-crawlable page would ALSO
// need to stay off this list).
const DISALLOW = ["/admin", "/me", "/auth", "/report", "/changes", "/api"];

export default function robots(): MetadataRoute.Robots {
  return buildRobotsRules(SITE_URL, DISALLOW);
}

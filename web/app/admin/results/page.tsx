// Legacy route -- the Results / Resolve / Disputes pages merged into one
// admin Matches page (see web/app/admin/matches/page.tsx and
// .claude/knowledge/ux-audit/01-findings.md, "Target: three weekly pages").
// Kept as a redirect so existing links/bookmarks still land somewhere
// useful: a division filter carries straight over, "player" search isn't
// preserved (the merged page filters by division/status/age/dropped, not by
// player lookup).

import { redirect } from "next/navigation";

export default async function LegacyResultsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ division?: string }>;
}) {
  const { division } = await searchParams;
  redirect(division ? `/admin/matches?division=${encodeURIComponent(division)}` : "/admin/matches");
}

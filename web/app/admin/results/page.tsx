// Legacy route -- the Results / Resolve / Disputes pages merged into one
// admin Matches page (see web/app/admin/matches/page.tsx and
// .claude/knowledge/ux-audit/01-findings.md, "Target: three weekly pages").
// Kept as a redirect so existing links/bookmarks still land somewhere
// useful: a division filter carries straight over, and so does a "player"
// search -- the merged page now has its own ?player= name/handle filter.

import { redirect } from "next/navigation";

export default async function LegacyResultsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ division?: string; player?: string }>;
}) {
  const { division, player } = await searchParams;
  const q = new URLSearchParams();
  if (division) q.set("division", division);
  if (player) q.set("player", player);
  const qs = q.toString();
  redirect(qs ? `/admin/matches?${qs}` : "/admin/matches");
}

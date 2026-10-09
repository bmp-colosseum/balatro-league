// Legacy route -- the bulk-resolve queue merged into /admin/matches (see
// page.tsx there and .claude/knowledge/ux-audit/01-findings.md, "Target:
// three weekly pages"). The preview-then-apply bulk flow (tick rows, pick an
// action + reason, preview, apply) is unchanged -- same core logic
// (lib/bulk-resolve-core.ts / lib/bulk-resolve.ts) -- just folded into the
// one shared list. Forwards every filter this page understood; its
// "unplayed-scheduled" status value becomes the merged page's "unplayed".

import { redirect } from "next/navigation";

const STATUS_MAP: Record<string, string> = {
  pending: "pending",
  disputed: "disputed",
  "unplayed-scheduled": "unplayed",
};

export default async function LegacyResolveRedirect({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; division?: string; status?: string; olderThan?: string; dropped?: string }>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  if (sp.season) q.set("season", sp.season);
  if (sp.division) q.set("division", sp.division);
  if (sp.status && STATUS_MAP[sp.status]) q.set("status", STATUS_MAP[sp.status]!);
  if (sp.olderThan) q.set("olderThan", sp.olderThan);
  if (sp.dropped === "1") q.set("dropped", "1");
  const qs = q.toString();
  redirect(qs ? `/admin/matches?${qs}` : "/admin/matches");
}

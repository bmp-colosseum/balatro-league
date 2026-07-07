import { SeasonNav, type SeasonNavTab } from "@/components/SeasonNav";
import { getViewer, isAdmin } from "@/lib/auth";
import { capabilitiesFor, captainTeamsFor, hasAnyAccess, seasonIdByName } from "@/lib/permissions";

// Persistent, capability-filtered sub-nav across every /admin/seasons/[name]/* page, so moving
// between sections no longer round-trips through the hub tile grid. Gating mirrors the hub's
// `stages` list (app/admin/seasons/[name]/page.tsx) -- keep the two in sync if that list changes.
// Each admin page still renders its own <main>; this layout only adds the nav in a spacing
// container above {children} (same shape as app/seasons/[name]/layout.tsx for the public side).
export default async function AdminSeasonLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ name: string }>;
}) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const seasonId = await seasonIdByName(name);

  // Not a real season (e.g. a typo'd/legacy path) -- render children with no nav.
  if (!seasonId) return <>{children}</>;

  const [viewer, to] = await Promise.all([getViewer(), isAdmin()]);
  const [caps, captainTeams, anyAccess] = await Promise.all([
    capabilitiesFor(viewer, seasonId),
    captainTeamsFor(viewer, seasonId),
    hasAnyAccess(viewer),
  ]);
  const isCaptain = captainTeams.size > 0;
  const cap = (c: "NEWS" | "RANKINGS" | "ROSTERS" | "DRAFT") => to || caps.has(c);

  const enc = encodeURIComponent(name);
  const items: { href: string; label: string; show: boolean }[] = [
    { href: `/admin/seasons/${enc}/signups`, label: "Signups", show: to },
    { href: `/admin/seasons/${enc}/teams`, label: "Teams", show: to },
    { href: `/admin/seasons/${enc}/draft`, label: "Draft", show: cap("DRAFT") || isCaptain },
    { href: `/admin/seasons/${enc}/schedule`, label: "Schedule", show: to },
    { href: `/admin/seasons/${enc}/roster`, label: "Roster", show: cap("ROSTERS") || isCaptain },
    { href: `/admin/seasons/${enc}/roster/requests`, label: "Requests", show: cap("ROSTERS") },
    { href: `/admin/seasons/${enc}/playoffs`, label: "Playoffs", show: to },
    { href: `/admin/seasons/${enc}/end`, label: "End", show: to },
    { href: `/admin/seasons/${enc}/fantasy`, label: "Fantasy", show: to },
    { href: `/admin/seasons/${enc}/discord`, label: "Discord", show: to },
    { href: `/admin/seasons/${enc}/news`, label: "News", show: cap("NEWS") },
    { href: `/admin/seasons/${enc}/rankings`, label: "Rankings", show: cap("RANKINGS") },
  ];
  const tabs: SeasonNavTab[] = [
    { href: `/admin/seasons/${enc}`, label: "Hub" },
    ...items.filter((i) => i.show).map(({ href, label }) => ({ href, label })),
  ];

  // No section access at all for this season, and none globally either -- let the page render
  // its own NoAccess message instead of a nav that only ever shows "Hub".
  if (tabs.length <= 1 && !anyAccess) return <>{children}</>;

  return (
    <>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 24px 0" }}>
        <SeasonNav seasonName={name} tabs={tabs} />
      </div>
      {children}
    </>
  );
}

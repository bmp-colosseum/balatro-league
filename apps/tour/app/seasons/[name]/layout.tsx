import { SeasonNav, type SeasonNavTab } from "@/components/SeasonNav";
import { getViewer, isAdmin } from "@/lib/auth";
import { seasonIdByName, captainTeamsFor } from "@/lib/permissions";
import { getFantasyLeague } from "@/lib/services/fantasy";

// Wraps every /seasons/[name]/* page (incl. conf/[conf], fantasy/draft) with a
// persistent, role-aware sub-nav. Fun-first ordering for everyone (players'
// web draw is pick'em/fantasy); "Manage" is appended only for captains/TOs.
// Each child page still renders its own <main> — this layout adds no extra
// wrapper beyond the nav's own spacing container.
export default async function SeasonLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ name: string }>;
}) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const seasonId = await seasonIdByName(name);

  // Not a real season (e.g. a typo'd/legacy path) — render children with no nav.
  if (!seasonId) return <>{children}</>;

  const [viewer, admin, hasFantasy] = await Promise.all([
    getViewer(),
    isAdmin(),
    getFantasyLeague(name).then((l) => l !== null),
  ]);
  const isCaptain = (await captainTeamsFor(viewer, seasonId)).size > 0;

  const enc = encodeURIComponent(name);
  const tabs: SeasonNavTab[] = [
    { href: `/seasons/${enc}`, label: "Overview" },
    { href: `/seasons/${enc}/rankings`, label: "Rankings" },
    { href: `/seasons/${enc}/weeks`, label: "Weeks" },
    { href: `/seasons/${enc}/bracket`, label: "Playoffs" },
    { href: `/seasons/${enc}/pickem`, label: "Pick'em", emphasis: true },
    ...(hasFantasy ? [{ href: `/seasons/${enc}/fantasy`, label: "Fantasy", emphasis: true }] : []),
    { href: `/seasons/${enc}/news`, label: "News" },
    { href: `/seasons/${enc}/timeline`, label: "Timeline" },
    { href: `/seasons/${enc}/draft`, label: "Draft" },
  ];
  if (admin || isCaptain) tabs.push({ href: `/admin/seasons/${enc}`, label: "Manage" });

  return (
    <>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 24px 0" }}>
        <SeasonNav seasonName={name} tabs={tabs} />
      </div>
      {children}
    </>
  );
}

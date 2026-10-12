// Gold season pill next to the product-switcher mark (components/SiteNav.tsx) --
// names the active season and links into it. design-system/MASTER.md /
// .claude/knowledge/ux-cohesion/01-findings.md section b: "a season pill, gold
// outline, 'Season 9'. The Tour already has this. The League should copy it and
// let it open the seasons list." Hidden entirely when no season is marked active
// (pre-season / between seasons) -- a pill naming nothing would read as broken,
// not informative.
import Link from "next/link";

export function SeasonPill({
  seasonId,
  seasonName,
}: {
  seasonId: string | null;
  seasonName: string | null;
}) {
  if (!seasonId || !seasonName) return null;
  return (
    <Link
      href={`/seasons/${seasonId}`}
      className="season-pill"
      aria-label={`Active season: ${seasonName}. View season`}
    >
      <span className="max-w-[9ch] truncate sm:max-w-none">{seasonName}</span>
    </Link>
  );
}

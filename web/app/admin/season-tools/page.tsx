import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { loadAdminHomeStats } from "@/lib/loaders/admin";
import { loadSignupRoundsIndex } from "@/lib/loaders/admin-signups";
import { loadBulkResolveQueue } from "@/lib/loaders/admin-resolve";
import { loadSeasonAuditOverview } from "@/lib/loaders/season-audit";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { pickCurrentSignupRound, seasonToolsSeasonId } from "@/lib/season-tools-core";

export const dynamic = "force-dynamic";

// One checklist row: a title, one line of guidance, an optional live status
// chip, and one or more links into the existing page(s) that do the work.
// This hub holds no logic of its own beyond picking which link target to
// use (season-tools-core.ts) -- every number on it comes from a loader the
// rest of the admin already calls.
function Step({
  n,
  title,
  guidance,
  chip,
  links,
}: {
  n: number;
  title: string;
  guidance: string;
  chip?: string;
  links: { href: string; label: string }[];
}) {
  return (
    <div className="card" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div
        className="muted"
        style={{ fontSize: 12, fontWeight: 600, minWidth: 20, textAlign: "right" }}
      >
        {n}.
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <strong>{title}</strong>
          {chip && (
            <span className="pill" style={{ fontSize: 11 }}>
              {chip}
            </span>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "2px 0 8px" }}>
          {guidance}
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
          {links.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label} {"->"}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div
      className="muted"
      style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 20, marginBottom: 4 }}
    >
      {children}
    </div>
  );
}

export default async function SeasonToolsPage() {
  await requireAdmin();

  const [stats, signupRounds, resolveQueue, auditOverview] = await Promise.all([
    loadAdminHomeStats(),
    loadSignupRoundsIndex(),
    loadBulkResolveQueue({}),
    loadSeasonAuditOverview(),
  ]);

  const currentRound = pickCurrentSignupRound(signupRounds);
  const closeOutSeasonId = seasonToolsSeasonId(stats.activeSeason?.id ?? null, auditOverview.defaultSeasonId);
  const closeOutAudit = closeOutSeasonId
    ? auditOverview.seasons.find((s) => s.seasonId === closeOutSeasonId) ?? null
    : null;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/season-tools" />
      <main>
        <h2>Season tools</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          The once-a-season checklist, in the order a TO actually does it. Each step links to its own
          page -- nothing on this page itself writes anything.
        </p>

        <Step
          n={1}
          title="Open signups"
          guidance="Open a round so players can sign up for next season."
          chip={currentRound ? `${currentRound.status === "OPEN" ? "open" : currentRound.status.toLowerCase()}: ${currentRound.signups.length} signed up` : "no round open"}
          links={[{ href: "/admin/signups", label: "Signups" }]}
        />
        <Step
          n={2}
          title="Review signups"
          guidance="Check who's in and the pre-season MMR distribution before building divisions."
          links={[{ href: currentRound ? `/admin/signups/${currentRound.id}` : "/admin/signups", label: "Review" }]}
        />
        <Step
          n={3}
          title="Build divisions"
          guidance="Preview tier placement, then build the season's divisions from this round."
          links={
            currentRound
              ? [
                  { href: `/admin/signups/${currentRound.id}/preview`, label: "Preview" },
                  { href: `/admin/signups/${currentRound.id}/build`, label: "Build" },
                  { href: "/admin/divisions", label: "View divisions" },
                ]
              : [{ href: "/admin/signups", label: "Signups" }]
          }
        />
        <Step
          n={4}
          title="Activate"
          guidance="Start the season once divisions look right."
          chip={stats.activeSeason ? `season active: ${stats.activeSeason.name}` : "no active season"}
          links={[{ href: "/admin/seasons", label: "Seasons" }]}
        />

        <SectionLabel>During the season</SectionLabel>
        <Step
          n={5}
          title="Resolve"
          guidance="Clear stuck pending and disputed matches as the season runs."
          chip={`unplayed: ${resolveQueue.totalUnfiltered}`}
          links={[{ href: "/admin/matches?status=pending", label: "Matches" }]}
        />
        <Step
          n={6}
          title="Standings preview"
          guidance="Check the scoring mode (best-N) and tiebreak before the season ends."
          links={[{ href: "/admin/standings-preview", label: "Standings preview" }]}
        />
        <Step
          n={7}
          title="Play times"
          guidance="See when players are available -- read-only reference."
          links={[{ href: "/admin/play-times", label: "Play times" }]}
        />

        <SectionLabel>End of season</SectionLabel>
        <Step
          n={8}
          title="Season audit"
          guidance="Catch scoring or data problems before ending the season."
          chip={closeOutAudit ? `audit: ${closeOutAudit.countsBySeverity.error} errors` : undefined}
          links={[{ href: "/admin/season-audit", label: "Season audit" }]}
        />
        <Step
          n={9}
          title="Winners"
          guidance="Mark each division's winner and give out champion roles."
          links={[{ href: closeOutSeasonId ? `/admin/seasons/${closeOutSeasonId}/winners` : "/admin/seasons", label: "Winners" }]}
        />
        <Step
          n={10}
          title="End season"
          guidance="Writes final placements and ratings, deletes the season's Discord division channels and roles (champion roles stay), and DMs every promoted and relegated player. Cannot be undone."
          links={[{ href: stats.activeSeason ? `/admin/seasons/${stats.activeSeason.id}/end` : "/admin/seasons", label: "End season" }]}
        />

        <SectionLabel>After</SectionLabel>
        <Step
          n={11}
          title="Hall of Fame"
          guidance="See career titles once a champion is recorded."
          links={[{ href: "/hall-of-fame", label: "Hall of Fame" }]}
        />
        <Step
          n={12}
          title="Roles"
          guidance="Verify Discord roles match who's actually in each division."
          links={[{ href: "/admin/roles", label: "Role audit" }]}
        />
      </main>
    </>
  );
}

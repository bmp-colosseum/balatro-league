// Consolidated end-of-season "resolve everything" surface. Instead of
// visiting /admin/results, picking a division, resolving one match, and
// repeating per division, this lists every division that still has a
// PENDING/DISPUTED LEAGUE_BO2 match and renders the SAME MatchActionsPanel
// used on /admin/results for each — same actions, same component, one page.

import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { MatchActionsPanel } from "@/components/MatchActionsPanel";
import { CANONICAL_DECKS, CANONICAL_STAKES } from "@/lib/balatro-info";
import { loadUnresolvedMatches } from "@/lib/loaders/admin-resolve";

export const dynamic = "force-dynamic";

const RETURN_TO = "/admin/resolve";

export default async function ResolveAllPage() {
  await requireAdmin();
  const data = await loadUnresolvedMatches();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/resolve" />
      <main>
        <h2>Resolve everything</h2>
        <p className="muted">
          Every division with a scheduled match that isn&apos;t finished yet, all in one place —
          same record / override / DQ / void actions as Results, no need to hunt division by division.
        </p>

        {!data.hasActiveSeason && (
          <Callout type="info">No active season right now.</Callout>
        )}

        {data.hasActiveSeason && data.divisions.length === 0 && (
          <Callout type="success">
            Nothing left to resolve — every scheduled match in {data.seasonLabel} is confirmed.
          </Callout>
        )}

        {data.hasActiveSeason && data.divisions.length > 0 && (
          <>
            <p>
              <strong>{data.totalUnresolved}</strong> match{data.totalUnresolved === 1 ? "" : "es"} left to resolve
              across <strong>{data.divisions.length}</strong> division{data.divisions.length === 1 ? "" : "s"} in {data.seasonLabel}.
            </p>

            {data.divisions.map((d) => (
              <div key={d.divisionId}>
                <h3 style={{ marginTop: 20 }}>{d.tierName} — {d.divisionName}</h3>
                <MatchActionsPanel
                  divisionId={d.divisionId}
                  returnTo={RETURN_TO}
                  decks={CANONICAL_DECKS.map((deck) => deck.name)}
                  stakes={CANONICAL_STAKES.map((stake) => stake.name)}
                  members={d.members}
                  unplayed={d.pairs.map((p) => ({
                    p1Id: p.p1Id,
                    p2Id: p.p2Id,
                    summary: p.status === "DISPUTED" ? "disputed" : undefined,
                  }))}
                  played={[]}
                  showFix={false}
                />
              </div>
            ))}
          </>
        )}
      </main>
    </>
  );
}

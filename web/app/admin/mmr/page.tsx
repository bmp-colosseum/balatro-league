import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Button } from "@/components/ui/button";
import { loadMmrAdmin } from "@/lib/mmr-admin";
import { prisma } from "@/lib/prisma";
import { ConfirmButton } from "@/components/ConfirmButton";
import { MmrLadder, type MmrLadderRow } from "@/components/MmrLadder";
import { applyMmrLadder, fillMissingMmr, recomputeMmr, setLiveMmr } from "./actions";

export const dynamic = "force-dynamic";

// Secret-MMR onboarding screen. Seed everyone's hidden MMR from BMP (×1.5),
// hand-tweak the ones the scrape gets wrong, save. This is the source of truth
// the placement + schedule previews read from.
export default async function MmrAdminPage() {
  await requireAdmin();
  const rows = await loadMmrAdmin();
  const set = rows.filter((r) => r.hiddenMmr != null).length;
  const unset = rows.length - set;

  // Initial ladder order: by stored MMR desc, then BMP peak desc, then name.
  // Unset players fall to a sensible spot by their BMP, ready to drag.
  const ladderRows: MmrLadderRow[] = [...rows]
    .sort((a, b) => {
      const am = a.hiddenMmr ?? -1;
      const bm = b.hiddenMmr ?? -1;
      if (am !== bm) return bm - am;
      const ap = a.bmpPeak ?? -1;
      const bp = b.bmpPeak ?? -1;
      if (ap !== bp) return bp - ap;
      return a.displayName.localeCompare(b.displayName);
    })
    .map((r) => ({
      playerId: r.id,
      displayName: r.displayName,
      hiddenMmr: r.hiddenMmr,
      bmpPeak: r.bmpPeak,
      bmpTier: r.bmpTier,
    }));
  const liveMmr =
    (await prisma.leagueConfig.findUnique({ where: { key: "live_mmr_enabled" } }))?.value === "true";

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/mmr" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Secret MMR</h2>
          <span className="pill" style={{ background: "rgba(118,199,255,0.2)", color: "#76c7ff" }}>
            {set} set · {unset} unset
          </span>
        </div>
        <p className="muted">
          Each player&apos;s hidden league MMR. Two ways to set it: the <strong>ladder</strong> below — drag
          everyone into rank order and they&apos;re spaced exactly 10 apart (the clean cold-start, no lumpy
          BMP gaps) — or <strong>Recompute</strong>, which replays match results for a results-based spread.
          Placement + schedule previews read from this; after launch it updates per match.
        </p>

        <div className="card" style={{ borderColor: liveMmr ? "#2ecc71" : "#f1c40f", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <strong style={{ color: liveMmr ? "#2ecc71" : "#f1c40f" }}>
            Live MMR: {liveMmr ? "ON — hands-off" : "OFF — preview only"}
          </strong>
          <form action={setLiveMmr}>
            <input type="hidden" name="enable" value={liveMmr ? "false" : "true"} />
            <Button type="submit" variant="secondary">{liveMmr ? "Turn OFF" : "Turn ON (go live)"}</Button>
          </form>
          <span className="muted" style={{ fontSize: 12 }}>
            {liveMmr
              ? "Every confirmed match auto-updates MMR via the sweep."
              : "Nothing auto-updates — preview freely. Flip on when you're ready to enact it."}
          </span>
        </div>

        <div className="card" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <form action={fillMissingMmr}>
              <Button type="submit" variant="secondary">Fill missing from BMP (×1.5)</Button>
            </form>
            <span className="muted" style={{ fontSize: 12 }}>
              Only fills the {unset} unset player{unset === 1 ? "" : "s"} — never overwrites a value you typed.
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <form action={recomputeMmr}>
              <ConfirmButton message="Recompute every player's MMR from match history? This overwrites ALL current MMRs (including hand-set ones).">
                ↻ Recompute all from match history (Elowen)
              </ConfirmButton>
            </form>
            <span className="muted" style={{ fontSize: 12 }}>
              Replays every confirmed match from a BMP seed — sets MMR from real results (a strong player
              with weak BMP climbs off their wins). Overwrites everything.
            </span>
          </div>
        </div>

        <div className="card">
          <MmrLadder initial={ladderRows} applyOrder={applyMmrLadder} />
        </div>
      </main>
    </>
  );
}

import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Button } from "@/components/ui/button";
import { loadMmrAdmin } from "@/lib/mmr-admin";
import { loadLiveMmrEnabled } from "@/lib/loaders/admin-mmr";
import { ConfirmButton } from "@/components/ConfirmButton";
import { MmrLadder, type MmrLadderRow } from "@/components/MmrLadder";
import { applyMmrLadder, fillMissingMmr, markMatchesSettled, recomputeMmr, setLiveMmr, saveMmrs } from "./actions";

export const dynamic = "force-dynamic";

// Hidden-MMR onboarding screen. Seed everyone's hidden MMR from BMP (×1.5),
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
  const liveMmr = await loadLiveMmrEnabled();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/mmr" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Hidden MMR</h2>
          <span className="pill" style={{ background: "rgba(118,199,255,0.2)", color: "var(--info)" }}>
            {set} set · {unset} unset
          </span>
        </div>
        <p className="muted">
          Each player&apos;s hidden league MMR. Set it two ways: drag players into rank order in the
          <strong> ladder</strong> below (spaced 10 apart), or <strong>Recompute</strong> it from match results.
          Placement and schedule previews read from this; after launch it updates per match.
        </p>

        <div className="card" style={{ borderColor: liveMmr ? "var(--success)" : "var(--accent)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <strong style={{ color: liveMmr ? "var(--success)" : "var(--accent)" }}>
            Live MMR: {liveMmr ? "ON — hands-off" : "OFF — preview only"}
          </strong>
          <form action={setLiveMmr}>
            <input type="hidden" name="enable" value={liveMmr ? "false" : "true"} />
            <Button type="submit" variant="secondary">{liveMmr ? "Turn OFF" : "Turn ON (go live)"}</Button>
          </form>
          <span className="muted" style={{ fontSize: 12 }}>
            {liveMmr
              ? "Every confirmed match updates MMR automatically."
              : "Nothing updates automatically — preview freely. Turn on when you're ready to go live."}
          </span>
          <div style={{ flexBasis: "100%", borderTop: "1px solid var(--border)", paddingTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <form action={markMatchesSettled}>
              <ConfirmButton message="Mark all current confirmed matches as settled without applying them? Do this before turning live MMR on so past matches are skipped and MMR only moves on new ones. It doesn't change anyone's MMR.">
                Skip past matches (start fresh)
              </ConfirmButton>
            </form>
            <span className="muted" style={{ fontSize: 12 }}>
              ⚠ Do this before turning live MMR on, or it&apos;ll replay every past match. Skipping them means
              MMR only moves on new matches, on top of your seeded values.
            </span>
          </div>
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
              <ConfirmButton message="Recompute every player's MMR from match history? This overwrites ALL current MMRs, including ones you set by hand.">
                ↻ Recompute all from match history
              </ConfirmButton>
            </form>
            <span className="muted" style={{ fontSize: 12 }}>
              Replays every confirmed match, starting from each player&apos;s BMP MMR — so a strong player with
              a weak BMP score climbs off their wins. Overwrites everything.
            </span>
          </div>
        </div>

        <div className="card">
          <MmrLadder initial={ladderRows} applyOrder={applyMmrLadder} />
        </div>

        <details className="card">
          <summary style={{ cursor: "pointer" }}>
            <strong>Set exact MMR per player</strong>{" "}
            <span className="muted" style={{ fontSize: 12 }}>— type a number for each, blank = unset. Save applies all.</span>
          </summary>
          <form action={saveMmrs} style={{ marginTop: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "6px 16px" }}>
              {ladderRows.map((r) => (
                <label key={r.playerId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.displayName}</span>
                  <input
                    type="number"
                    name={`mmr:${r.playerId}`}
                    defaultValue={r.hiddenMmr ?? ""}
                    min={0}
                    style={{ width: 72, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--border, rgba(255,255,255,0.12))", background: "var(--surface-2, rgba(255,255,255,0.05))", color: "var(--text)" }}
                  />
                </label>
              ))}
            </div>
            <Button type="submit" style={{ marginTop: 10 }}>Save all MMRs</Button>
          </form>
        </details>
      </main>
    </>
  );
}

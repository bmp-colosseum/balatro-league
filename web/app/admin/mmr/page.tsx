import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Button } from "@/components/ui/button";
import { loadMmrAdmin } from "@/lib/mmr-admin";
import { loadLiveMmrEnabled, loadMmrSeasons } from "@/lib/loaders/admin-mmr";
import { previewSeasonMmr, type MmrSeedSource } from "@/lib/mmr-recompute";
import { ConfirmButton } from "@/components/ConfirmButton";
import { MmrLadder, type MmrLadderRow } from "@/components/MmrLadder";
import { applyMmrLadder, applySeasonMmrApply, fillMissingMmr, markMatchesSettled, setLiveMmr, saveMmrs } from "./actions";

export const dynamic = "force-dynamic";

const selectStyle = {
  fontSize: 13,
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--border, rgba(255,255,255,0.12))",
  background: "var(--surface-2, rgba(255,255,255,0.05))",
  color: "var(--text)",
} as const;

// Hidden-MMR onboarding screen. Seed everyone's hidden MMR from BMP (×1.5),
// hand-tweak the ones the scrape gets wrong, save. This is the source of truth
// the placement + schedule previews read from.
export default async function MmrAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ mmrSeason?: string; mmrSeed?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const rows = await loadMmrAdmin();
  const set = rows.filter((r) => r.hiddenMmr != null).length;
  const unset = rows.length - set;

  // Recompute basis picker + (when chosen) a read-only preview of the result.
  const seasons = await loadMmrSeasons();
  const seedSource: MmrSeedSource = sp.mmrSeed === "bmp" ? "bmp" : "current";
  const showPreview = sp.mmrSeason !== undefined || sp.mmrSeed !== undefined;
  const preview = showPreview
    ? await previewSeasonMmr({ seasonId: sp.mmrSeason || undefined, seedSource })
    : null;
  const moved = preview ? preview.rows.filter((r) => r.delta !== 0).length : 0;

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
            {liveMmr ? (
              <Button type="submit" variant="secondary">Turn OFF</Button>
            ) : (
              <ConfirmButton
                message="Turn league MMR live? From here on, every confirmed game in the ACTIVE season updates MMR automatically (past seasons are ignored). Any of this season's games not yet applied get applied on the next sweep. To go live WITHOUT applying already-played games, use 'Skip to now' first."
                variant="secondary"
              >
                Turn ON (go live)
              </ConfirmButton>
            )}
          </form>
          <span className="muted" style={{ fontSize: 12 }}>
            {liveMmr
              ? "Every confirmed match updates MMR automatically."
              : "Nothing updates automatically — preview freely. Turn on when you're ready to go live."}
          </span>
          <div style={{ flexBasis: "100%", borderTop: "1px solid var(--border)", paddingTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <form action={markMatchesSettled}>
              <ConfirmButton message="Mark every confirmed match as settled WITHOUT applying it, so live MMR only moves on games played from here on? Doesn't change anyone's current MMR.">
                Skip to now (ignore played games)
              </ConfirmButton>
            </form>
            <span className="muted" style={{ fontSize: 12 }}>
              Optional. Use only if you want live MMR to start fresh from now and ignore this season&apos;s
              already-played games. Otherwise, going live applies those on top of your seeds.
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "4px 0" }}>
          <form action={fillMissingMmr}>
            <Button type="submit" variant="secondary">Fill missing from BMP (×1.5)</Button>
          </form>
          <span className="muted" style={{ fontSize: 12 }}>
            Only fills the {unset} unset player{unset === 1 ? "" : "s"} — never overwrites a value you typed.
          </span>
        </div>

        {/* Configure → preview → apply. Pick which season's games to replay and
            what to start each player from, Preview (a GET — writes nothing), then
            Apply commits exactly what's shown. */}
        <div className="card" style={{ display: "grid", gap: 12 }}>
          <div>
            <strong>Recompute from match results</strong>
            <p className="muted" style={{ fontSize: 12, margin: "2px 0 0" }}>
              Choose what to base MMR on, preview the result, then apply. Nothing saves until you hit Apply.
            </p>
          </div>
          <form method="get" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span className="muted">Replay games from</span>
              <select name="mmrSeason" defaultValue={preview?.seasonId ?? ""} style={selectStyle}>
                {seasons.length === 0 && <option value="">No seasons</option>}
                {seasons.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}{s.isActive ? " (active)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span className="muted">Starting each player from</span>
              <select name="mmrSeed" defaultValue={seedSource} style={selectStyle}>
                <option value="current">Current hidden MMR (keep your seeds)</option>
                <option value="bmp">BMP MMR ×1.5 (cold start)</option>
              </select>
            </label>
            <Button type="submit" variant="secondary">Preview →</Button>
          </form>

          {preview && (
            preview.seasonId === null ? (
              <div className="muted" style={{ fontSize: 13 }}>No season selected.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  Replaying <strong>{preview.matchCount}</strong> confirmed game{preview.matchCount === 1 ? "" : "s"} from{" "}
                  <strong>{preview.seasonLabel}</strong>, starting from{" "}
                  {seedSource === "current" ? "each player's current MMR" : "BMP ×1.5"}.{" "}
                  <strong>{moved}</strong> player{moved === 1 ? "" : "s"} would move. Nothing is saved yet.
                </div>
                <div className="table-scroll" style={{ maxHeight: 360 }}>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>Player</th>
                        <th style={{ textAlign: "right" }}>Start</th>
                        <th style={{ textAlign: "right" }}>→ MMR</th>
                        <th style={{ textAlign: "right" }}>Δ</th>
                        <th style={{ textAlign: "right" }}>Games</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr key={r.playerId} style={{ opacity: r.games === 0 ? 0.5 : 1 }}>
                          <td>{r.displayName}</td>
                          <td style={{ textAlign: "right" }}>{r.seed}</td>
                          <td style={{ textAlign: "right", fontWeight: 600 }}>{r.final}</td>
                          <td style={{ textAlign: "right", color: r.delta > 0 ? "var(--success)" : r.delta < 0 ? "var(--danger)" : "var(--muted)" }}>
                            {r.delta > 0 ? `+${r.delta}` : r.delta}
                          </td>
                          <td style={{ textAlign: "right" }} className="muted">{r.games}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <form action={applySeasonMmrApply}>
                  <input type="hidden" name="mmrSeason" value={preview.seasonId} />
                  <input type="hidden" name="mmrSeed" value={seedSource} />
                  <ConfirmButton message={`Apply these MMRs to all ${preview.rows.length} players? This overwrites everyone's current hidden MMR (including hand-set values) with the previewed numbers.`}>
                    ✓ Apply these MMRs
                  </ConfirmButton>
                </form>
              </div>
            )
          )}
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

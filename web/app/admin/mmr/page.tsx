import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadMmrAdmin } from "@/lib/mmr-admin";
import { fillMissingMmr, saveMmrs } from "./actions";

export const dynamic = "force-dynamic";

// Secret-MMR onboarding screen. Seed everyone's hidden MMR from BMP (×1.5),
// hand-tweak the ones the scrape gets wrong, save. This is the source of truth
// the placement + schedule previews read from.
export default async function MmrAdminPage() {
  await requireAdmin();
  const rows = await loadMmrAdmin();
  const set = rows.filter((r) => r.hiddenMmr != null).length;
  const unset = rows.length - set;

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
          Each player&apos;s hidden league MMR (the 2200 scale). Placement + schedule previews read from
          this. Seed everyone from BMP (peak × 1.5), then hand-fix the ones it gets wrong. You only need
          to do this once — after that it updates per match.
        </p>

        <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <form action={fillMissingMmr}>
            <Button type="submit" variant="secondary">Fill missing from BMP (×1.5)</Button>
          </form>
          <span className="muted" style={{ fontSize: 12 }}>
            Only fills the {unset} unset player{unset === 1 ? "" : "s"} — never overwrites a value you typed.
          </span>
        </div>

        <form action={saveMmrs} className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <strong>{rows.length} players</strong>
            <Button type="submit">Save all</Button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "4px 8px" }}>Player</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>Secret MMR</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }} className="muted">BMP peak</th>
                <th style={{ padding: "4px 8px" }} className="muted">Tier</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }} className="muted">Suggested (×1.5)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <td style={{ padding: "3px 8px" }}>{r.displayName}</td>
                  <td style={{ padding: "3px 8px", textAlign: "right" }}>
                    <Input
                      type="number"
                      name={`mmr:${r.id}`}
                      defaultValue={r.hiddenMmr ?? ""}
                      placeholder={r.suggested != null ? String(r.suggested) : "—"}
                      min={0}
                      max={9999}
                      style={{ width: 80, fontSize: 13, padding: "1px 4px", textAlign: "right" }}
                    />
                  </td>
                  <td style={{ padding: "3px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }} className="muted">
                    {r.bmpPeak ?? "—"}
                  </td>
                  <td style={{ padding: "3px 8px" }} className="muted">{r.bmpTier ?? "—"}</td>
                  <td style={{ padding: "3px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }} className="muted">
                    {r.suggested ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10 }}>
            <Button type="submit">Save all</Button>
          </div>
        </form>
      </main>
    </>
  );
}

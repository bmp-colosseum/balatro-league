// Read-only readout of each signup's stored secret MMR (set on /admin/mmr).
// No longer computes anything — the MMR is real now; this just shows it sorted,
// with BMP peak alongside and a nudge if any are unset.

export interface SeedPlayer {
  discordId: string;
  displayName: string;
  hiddenMmr: number | null; // the secret league MMR
  mmr: number | null;       // BMP ranked MMR (reference)
}

export function MmrSeedingTable({ players }: { players: SeedPlayer[] }) {
  const ordered = [...players].sort((a, b) => {
    if ((a.hiddenMmr == null) !== (b.hiddenMmr == null)) return a.hiddenMmr == null ? 1 : -1;
    if (a.hiddenMmr != null && b.hiddenMmr != null && a.hiddenMmr !== b.hiddenMmr) return b.hiddenMmr - a.hiddenMmr;
    return a.displayName.localeCompare(b.displayName);
  });
  const unset = ordered.filter((p) => p.hiddenMmr == null).length;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong>Secret MMR</strong>
        <span className="muted" style={{ fontSize: 12 }}>
          stored per player · set on <a href="/admin/mmr">/admin/mmr</a>
        </span>
        {unset > 0 && (
          <span style={{ color: "#f1c40f", fontSize: 12, marginLeft: "auto" }}>
            ⚠ {unset} unset — seed them for an accurate preview
          </span>
        )}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10, fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th style={{ padding: "4px 8px", width: 40 }}>#</th>
            <th style={{ padding: "4px 8px" }}>Player</th>
            <th style={{ padding: "4px 8px", textAlign: "right" }}>Secret MMR</th>
            <th style={{ padding: "4px 8px", textAlign: "right" }} className="muted">BMP MMR</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((p, i) => (
            <tr key={p.discordId} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              <td style={{ padding: "3px 8px" }} className="muted">{i + 1}</td>
              <td style={{ padding: "3px 8px" }}>{p.displayName}</td>
              <td
                style={{ padding: "3px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600, color: p.hiddenMmr == null ? "#f1c40f" : undefined }}
              >
                {p.hiddenMmr ?? "unset"}
              </td>
              <td style={{ padding: "3px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }} className="muted">
                {p.mmr ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

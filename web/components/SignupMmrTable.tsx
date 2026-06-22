"use client";

// Sortable roster for the signup MMR page. Click any column header to sort by
// it (toggles asc/desc); no-data rows always sink to the bottom regardless of
// direction. Default sort is MMR desc. Client component just for the sort
// interaction — the data is computed server-side and passed in.

import { useState } from "react";
import type { SignupMmrRow } from "@/lib/loaders/admin";

type SortKey = "name" | "mmr" | "peak" | "tier" | "season" | "games" | "winrate";

function bmpSeasonLabel(tag: string | null): string {
  if (!tag) return "—";
  const m = /^season(\d+)$/.exec(tag);
  return m ? `S${m[1]}` : tag;
}
function seasonNum(tag: string | null): number | null {
  if (!tag) return null;
  const m = /^season(\d+)$/.exec(tag);
  return m ? parseInt(m[1]!, 10) : null;
}

export function SignupMmrTable({
  rows,
  bmpCurrentSeason,
}: {
  rows: SignupMmrRow[];
  bmpCurrentSeason: string | null;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("mmr");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const cmpNum = (a: number | null, b: number | null) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1; // nulls last, both directions
    if (b == null) return -1;
    return dir === "asc" ? a - b : b - a;
  };
  const cmpStr = (a: string | null, b: string | null) => {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return dir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
  };

  const sorted = [...rows].sort((a, b) => {
    switch (sortKey) {
      case "name": return cmpStr((a.globalName ?? a.username).toLowerCase(), (b.globalName ?? b.username).toLowerCase());
      case "mmr": return cmpNum(a.mmr, b.mmr);
      case "peak": return cmpNum(a.peakMmr, b.peakMmr);
      case "tier": return cmpStr(a.tier, b.tier);
      case "season": return cmpNum(seasonNum(a.bmpSeason), seasonNum(b.bmpSeason));
      case "games": return cmpNum(a.totalGames, b.totalGames);
      case "winrate": return cmpNum(a.winRatePct, b.winRatePct);
    }
  });

  function toggle(k: SortKey) {
    if (k === sortKey) {
      setDir(dir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      // Text columns default A→Z; numeric columns default high→low.
      setDir(k === "name" || k === "tier" ? "asc" : "desc");
    }
  }

  const th = (k: SortKey, label: string, title?: string) => (
    <th
      key={k}
      onClick={() => toggle(k)}
      title={title ? `${title} — click to sort` : "Click to sort"}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
    >
      {label}
      <span style={{ opacity: sortKey === k ? 1 : 0.25 }}> {sortKey === k ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
    </th>
  );

  return (
    <div className="table-scroll" style={{ marginTop: 8 }}>
      <table className="table-dense">
        <thead>
          <tr>
            <th>#</th>
            {th("name", "Player")}
            {th("mmr", "MMR")}
            {th("peak", "Peak", "Peak ranked MMR")}
            {th("tier", "Tier")}
            {th("season", "Season", "BMP season these numbers are from")}
            {th("games", "Games")}
            {th("winrate", "Win%")}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr><td colSpan={8} className="muted">No signups.</td></tr>
          ) : (
            sorted.map((r, i) => {
              const isPrev = r.bmpSeason != null && bmpCurrentSeason != null && r.bmpSeason !== bmpCurrentSeason;
              return (
                <tr key={r.discordId}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <strong>{r.globalName ?? `@${r.username}`}</strong>
                    {r.globalName && <span className="muted"> @{r.username}</span>}
                    <div className="muted" style={{ fontSize: 11 }}>
                      <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.discordId}</span>
                      {" · "}
                      <a href={`https://balatromp.com/players/${r.discordId}`} target="_blank" rel="noopener">balatromp ↗</a>
                      {r.inGuild === false && <span> · not in server</span>}
                    </div>
                  </td>
                  <td>{r.mmr != null ? <strong>{r.mmr}</strong> : <span className="muted">—</span>}</td>
                  <td>{r.peakMmr != null ? r.peakMmr : <span className="muted">—</span>}</td>
                  <td>{r.tier ?? <span className="muted">—</span>}</td>
                  <td>
                    {r.bmpSeason == null ? (
                      <span className="muted">—</span>
                    ) : isPrev ? (
                      <span style={{ color: "var(--accent)" }} title="Hasn't played the current BMP season — showing their most recent one">
                        {bmpSeasonLabel(r.bmpSeason)} · prev
                      </span>
                    ) : (
                      bmpSeasonLabel(r.bmpSeason)
                    )}
                  </td>
                  <td>{r.totalGames ?? <span className="muted">—</span>}</td>
                  <td>{r.winRatePct != null ? `${r.winRatePct}%` : <span className="muted">—</span>}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

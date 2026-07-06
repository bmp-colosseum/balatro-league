"use client";

// Sortable roster for the signup MMR page. Click any column header to sort by
// it (toggles asc/desc); no-data rows always sink to the bottom regardless of
// direction. Default sort is MMR desc. Client component just for the sort
// interaction — the data is computed server-side and passed in.

import { useState } from "react";
import type { SignupMmrRow } from "@/lib/loaders/admin";
import { ConfirmButton } from "@/components/ConfirmButton";

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
  roundId,
  removeAction,
  banAction,
}: {
  rows: SignupMmrRow[];
  bmpCurrentSeason: string | null;
  // When both are provided, each row gets a Remove (withdraw) button.
  roundId?: string;
  removeAction?: (formData: FormData) => void | Promise<void>;
  // When provided (alongside roundId), each row also gets a Remove + ban button.
  banAction?: (formData: FormData) => void | Promise<void>;
}) {
  const canRemove = !!roundId && !!removeAction;
  const canBan = !!roundId && !!banAction;
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
            <th title="Scheduled sets played / scheduled, in the CURRENT season. — = wasn't in this season.">Sets played</th>
            {canRemove && <th></th>}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr><td colSpan={canRemove ? 10 : 9} className="muted">No signups.</td></tr>
          ) : (
            sorted.map((r, i) => {
              const isPrev = r.bmpSeason != null && bmpCurrentSeason != null && r.bmpSeason !== bmpCurrentSeason;
              return (
                <tr key={r.discordId}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <strong>{r.globalName ?? `@${r.username}`}</strong>
                    {r.globalName && <span className="muted"> @{r.username}</span>}
                    {r.banned && (
                      <span className="pill" style={{ fontSize: 10, marginLeft: 6, background: "rgba(231,76,60,0.2)", color: "var(--danger)" }}>banned</span>
                    )}
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
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>
                    {r.setsThisSeason === null ? (
                      <span className="muted" title="Wasn't in the current season">—</span>
                    ) : r.setsThisSeason.scheduled === 0 ? (
                      <span className="muted" title="No scheduled sets this season">0/0</span>
                    ) : r.setsThisSeason.played === 0 ? (
                      <span style={{ color: "var(--danger)" }} title="Signed up / in the season but hasn't played any of their scheduled sets">
                        0/{r.setsThisSeason.scheduled}
                      </span>
                    ) : r.setsThisSeason.played < r.setsThisSeason.scheduled ? (
                      <span style={{ color: "var(--accent)" }} title="Some scheduled sets still unplayed">
                        {r.setsThisSeason.played}/{r.setsThisSeason.scheduled}
                      </span>
                    ) : (
                      <span style={{ color: "var(--success)" }} title="Played all scheduled sets">
                        {r.setsThisSeason.played}/{r.setsThisSeason.scheduled}
                      </span>
                    )}
                  </td>
                  {canRemove && (
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <div style={{ display: "inline-flex", gap: 6, justifyContent: "flex-end" }}>
                        <form action={removeAction} style={{ display: "inline" }}>
                          <input type="hidden" name="roundId" value={roundId} />
                          <input type="hidden" name="discordId" value={r.discordId} />
                          <ConfirmButton
                            variant="secondary"
                            message={`Remove ${r.globalName ?? r.username} from this signup round? They'll drop off the roster and won't be built into the season. (They can sign up again unless you ban them.)`}
                            style={{ fontSize: 11, padding: "2px 8px" }}
                          >
                            Remove
                          </ConfirmButton>
                        </form>
                        {canBan && (
                          <form action={banAction} style={{ display: "inline" }}>
                            <input type="hidden" name="roundId" value={roundId} />
                            <input type="hidden" name="discordId" value={r.discordId} />
                            <input type="hidden" name="displayName" value={r.globalName ?? r.username} />
                            <ConfirmButton
                              variant="destructive"
                              message={`Remove ${r.globalName ?? r.username} from this round AND ban them for one season? They'll be blocked from signing up until the ban auto-lifts one season from now. (You can adjust or lift it from /admin/bans.)`}
                              style={{ fontSize: 11, padding: "2px 8px" }}
                            >
                              Remove + ban 1 szn
                            </ConfirmButton>
                          </form>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

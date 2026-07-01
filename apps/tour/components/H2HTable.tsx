"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { H2HLine, H2HSetLine } from "@/lib/stats";
import { DiscordIdTag } from "@/components/DiscordIdTag";

const pctStr = (w: number, l: number) => (w + l ? `${((100 * w) / (w + l)).toFixed(1)}%` : "—");
const rate = (w: number, l: number) => (w + l ? w / (w + l) : 0);

// ── Aggregate view (per opponent, ignoring team + season) ──────────────────
type AggKey = "name" | "sets" | "setPct" | "games" | "gamePct";
const aggValue = (h: H2HLine, k: AggKey): number | string => {
  switch (k) {
    case "name": return h.name.toLowerCase();
    case "sets": return h.setW + h.setL;
    case "setPct": return rate(h.setW, h.setL);
    case "games": return h.gameW + h.gameL;
    case "gamePct": return rate(h.gameW, h.gameL);
  }
};

function AggregateTable({ rows, q, showIds }: { rows: H2HLine[]; q: string; showIds: boolean }) {
  const [sortKey, setSortKey] = useState<AggKey>("sets");
  const [asc, setAsc] = useState(false);
  const sorted = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle ? rows.filter((h) => h.name.toLowerCase().includes(needle)) : rows;
    return [...filtered].sort((a, b) => {
      const av = aggValue(a, sortKey), bv = aggValue(b, sortKey);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return asc ? cmp : -cmp;
    });
  }, [rows, q, sortKey, asc]);
  const sortBy = (k: AggKey) => { if (k === sortKey) setAsc((v) => !v); else { setSortKey(k); setAsc(k === "name"); } };
  const arrow = (k: AggKey) => (k === sortKey ? (asc ? " ▲" : " ▼") : "");
  const H = ({ k, label, num }: { k: AggKey; label: string; num?: boolean }) => (
    <th className={`sortable${num ? " num" : ""}`} onClick={() => sortBy(k)}>{label}{arrow(k)}</th>
  );
  return (
    <div className="card">
      <table>
        <thead>
          <tr><H k="name" label="Opponent" /><H k="sets" label="Sets" num /><H k="setPct" label="Set %" num /><H k="games" label="Games" num /><H k="gamePct" label="Game %" num /></tr>
        </thead>
        <tbody>
          {sorted.map((h) => (
            <tr key={h.opponentId}>
              <td><Link href={`/players/${h.opponentId}`}>{h.name}</Link><DiscordIdTag discordId={h.discordId} show={showIds} /></td>
              <td className="num">{h.setW}–{h.setL}</td>
              <td className="num">{pctStr(h.setW, h.setL)}</td>
              <td className="num">{h.gameW}–{h.gameL}</td>
              <td className="num">{pctStr(h.gameW, h.gameL)}</td>
            </tr>
          ))}
          {sorted.length === 0 && <tr><td colSpan={5} className="sub">No opponents match “{q}”.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ── Detailed view (one row per set: season · opponent team · seeds) ─────────
const Seed = ({ n }: { n: number | null }) => (n == null ? <span className="muted">—</span> : <span className="num muted">{n}</span>);

function DetailTable({ sets, q, showIds }: { sets: H2HSetLine[]; q: string; showIds: boolean }) {
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? sets.filter((s) => s.name.toLowerCase().includes(needle) || (s.opponentTeamName ?? "").toLowerCase().includes(needle) || s.seasonName.toLowerCase().includes(needle)) : sets;
  }, [sets, q]);
  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Season</th>
            <th className="num">Seed</th>
            <th>Opponent</th>
            <th className="num">Result</th>
            <th>Their team</th>
            <th className="num">Seed</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((s, i) => (
            <tr key={i}>
              <td>
                <Link href={`/seasons/${encodeURIComponent(s.seasonName)}`}>{s.seasonShort}</Link>
                {s.bracket === "PLAYOFF" && <span className="badge" style={{ marginLeft: 4 }}>PO</span>}
              </td>
              <td className="num"><Seed n={s.selfSeed} /></td>
              <td><Link href={`/players/${s.opponentId}`}>{s.name}</Link><DiscordIdTag discordId={s.discordId} show={showIds} /></td>
              <td className="num" style={{ color: s.won ? "var(--success)" : s.won === false ? "var(--accent-2)" : undefined, fontWeight: 600 }}>{s.gamesFor}–{s.gamesAgainst}</td>
              <td>{s.opponentTeamSeasonId ? <Link href={`/teams/${s.opponentTeamSeasonId}`}>{s.opponentTeamName}</Link> : <span className="muted">{s.opponentTeamName ?? "—"}</span>}</td>
              <td className="num"><Seed n={s.opponentSeed} /></td>
            </tr>
          ))}
          {filtered.length === 0 && <tr><td colSpan={6} className="sub">No sets match “{q}”.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function H2HTable({ rows, sets, showIds = false }: { rows: H2HLine[]; sets: H2HSetLine[]; showIds?: boolean }) {
  const [mode, setMode] = useState<"detail" | "aggregate">("detail");
  const [q, setQ] = useState("");
  const hasDetail = sets.length > 0;
  const showMode = hasDetail ? mode : "aggregate";
  const count = showMode === "detail" ? sets.length : rows.length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {hasDetail && (
          <div className="inline-flex rounded overflow-hidden" style={{ border: "1px solid var(--border)" }}>
            {(["detail", "aggregate"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="px-2.5 py-1 text-sm"
                style={{ background: showMode === m ? "var(--surface-2)" : "transparent", color: showMode === m ? "var(--text)" : "var(--muted)" }}
              >
                {m === "detail" ? "By set" : "By opponent"}
              </button>
            ))}
          </div>
        )}
        <span className="sub">{count} {showMode === "detail" ? "sets" : "opponents"}</span>
        {(showMode === "aggregate" ? rows.length > 8 : sets.length > 12) && (
          <input className="search" type="search" placeholder={showMode === "detail" ? "Filter by opponent / team / season…" : "Filter opponents…"} value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto" }} />
        )}
      </div>
      {showMode === "detail" ? <DetailTable sets={sets} q={q} showIds={showIds} /> : <AggregateTable rows={rows} q={q} showIds={showIds} />}
    </>
  );
}

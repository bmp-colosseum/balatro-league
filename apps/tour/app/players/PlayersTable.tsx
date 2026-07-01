"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Trophy } from "lucide-react";
import type { PlayerCareer } from "@/lib/stats";
import { DiscordIdTag } from "@/components/DiscordIdTag";

const pctStr = (w: number, l: number) => (w + l ? `${((100 * w) / (w + l)).toFixed(1)}%` : "—");
const rate = (w: number, l: number) => (w + l ? w / (w + l) : 0);

type Key = "name" | "seasons" | "rings" | "sets" | "setPct" | "games" | "gamePct";

const valueOf = (p: PlayerCareer, k: Key): number | string => {
  switch (k) {
    case "name": return p.name.toLowerCase();
    case "seasons": return p.seasons;
    case "rings": return p.rings;
    case "sets": return p.setW;
    case "setPct": return rate(p.setW, p.setL);
    case "games": return p.gameW;
    case "gamePct": return rate(p.gameW, p.gameL);
  }
};

export function PlayersTable({ players, showIds = false }: { players: PlayerCareer[]; showIds?: boolean }) {
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<Key>("setPct");
  const [asc, setAsc] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle ? players.filter((p) => p.name.toLowerCase().includes(needle)) : players;
    const sorted = [...filtered].sort((a, b) => {
      const av = valueOf(a, sortKey);
      const bv = valueOf(b, sortKey);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return asc ? cmp : -cmp;
    });
    return sorted;
  }, [players, q, sortKey, asc]);

  const sortBy = (k: Key) => {
    if (k === sortKey) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(k === "name"); // names default A→Z, numbers default high→low
    }
  };

  const arrow = (k: Key) => (k === sortKey ? (asc ? " ▲" : " ▼") : "");
  const H = ({ k, label, num }: { k: Key; label: ReactNode; num?: boolean }) => (
    <th className={`sortable${num ? " num" : ""}`} onClick={() => sortBy(k)}>
      {label}
      {arrow(k)}
    </th>
  );

  return (
    <>
      <input className="search" type="search" placeholder="Search players…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card">
        <table>
          <thead>
            <tr>
              <th className="rank">#</th>
              <H k="name" label="Player" />
              <H k="seasons" label="Sns" num />
              <H k="rings" label={<Trophy className="inline size-3.5 align-text-bottom" aria-label="Rings" />} num />
              <H k="sets" label="Sets" num />
              <H k="setPct" label="Set %" num />
              <H k="games" label="Games" num />
              <H k="gamePct" label="Game %" num />
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={p.playerId}>
                <td className="rank">{i + 1}</td>
                <td>
                  <Link href={`/players/${p.playerId}`}>{p.name}</Link>
                  <DiscordIdTag discordId={p.discordId} show={showIds} />
                </td>
                <td className="num">{p.seasons}</td>
                <td className="num">{p.rings || ""}</td>
                <td className="num">
                  {p.setW}–{p.setL}
                </td>
                <td className="num">{pctStr(p.setW, p.setL)}</td>
                <td className="num">
                  {p.gameW}–{p.gameL}
                </td>
                <td className="num">{pctStr(p.gameW, p.gameL)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="sub">
                  No players match “{q}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Link2, GitMerge, X, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { linkPlayerAction, mergePlayerAction, deletePlayerAction } from "@/app/admin/identity/actions";

type Result = { value: string; label: string; detail: string };
export type IdPlayer = { id: string; name: string; discordId: string; linked: boolean; sets: number; seasons: number; suggestions?: { discordId: string; name: string }[]; signupHandle?: string; mergeCandidate?: { id: string; name: string; sets: number } };

export function IdentityRow({ player }: { player: IdPlayer }) {
  const [mode, setMode] = useState<null | "link" | "merge">(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function search(value: string) {
    setQ(value);
    if (value.trim().length < 1) return setResults([]);
    const type = mode === "link" ? "league" : "tour";
    const r = await fetch(`/api/admin/identity/search?type=${type}&q=${encodeURIComponent(value)}`);
    const d = await r.json();
    setResults((d.results ?? []).filter((x: Result) => x.value !== player.id));
  }
  function open(m: "link" | "merge") {
    setMode(m);
    setQ("");
    setResults([]);
  }
  function close() {
    setMode(null);
    setQ("");
    setResults([]);
  }
  async function pick(r: Result) {
    if (mode === "merge" && !confirm(`Merge "${r.label}" INTO "${player.name}"?\n\nAll history (sets, picks, awards) ends up on one player. A real Discord link from EITHER side is always kept, so this won't unlink anyone. Cannot be undone.`)) return;
    setBusy(true);
    const res = mode === "link" ? await linkPlayerAction(player.id, r.value) : await mergePlayerAction(player.id, r.value);
    setBusy(false);
    if (res?.ok) {
      close();
      router.refresh();
    } else {
      alert(res?.message ?? "Failed.");
    }
  }
  async function mergeCandidateIn() {
    const c = player.mergeCandidate!;
    if (!confirm(`This linked account has no data. Merge in "${c.name}" (${c.sets} sets) — its history moves onto this account. Cannot be undone.`)) return;
    setBusy(true);
    const res = await mergePlayerAction(player.id, c.id); // keep the linked player, drop the legacy one
    setBusy(false);
    if (res?.ok) router.refresh();
    else alert(res?.message ?? "Failed.");
  }
  async function del() {
    if (!confirm(`Delete "${player.name}"? This removes the player and ${player.sets} set(s), their roster spots, picks, awards and stats. Cannot be undone.`)) return;
    setBusy(true);
    const res = await deletePlayerAction(player.id);
    setBusy(false);
    if (res?.ok) router.refresh();
    else alert(res?.message ?? "Failed.");
  }
  // One-click link to a suggested league match.
  async function linkSuggested(discordId: string) {
    setBusy(true);
    const res = await linkPlayerAction(player.id, discordId);
    setBusy(false);
    if (res?.ok) router.refresh();
    else alert(res?.message ?? "Failed.");
  }

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link href={`/players/${player.id}`} className="font-semibold">{player.name}</Link>
        <span className="sub">{player.seasons} sns · {player.sets} sets</span>
        {!player.linked && player.signupHandle && (
          <span className="sub" title="Discord handle from this player's signup — search/link by it">signup: <strong>@{player.signupHandle}</strong></span>
        )}
        {player.mergeCandidate && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={mergeCandidateIn} title={`Merge in ${player.mergeCandidate.name} (${player.mergeCandidate.sets} sets) — this linked account is empty`}>
            <GitMerge className="size-3.5" /> Claim {player.mergeCandidate.name} ({player.mergeCandidate.sets})
          </Button>
        )}
        <span className="ml-auto">
          {player.linked ? (
            <span className="badge" style={{ color: "var(--success)", borderColor: "var(--success)" }}>linked · {player.discordId}</span>
          ) : (
            <span className="badge">unlinked</span>
          )}
        </span>
        <Button size="sm" variant={mode === "link" ? "default" : "secondary"} onClick={() => (mode === "link" ? close() : open("link"))}>
          <Link2 className="size-3.5" /> Link
        </Button>
        <Button size="sm" variant={mode === "merge" ? "default" : "secondary"} onClick={() => (mode === "merge" ? close() : open("merge"))}>
          <GitMerge className="size-3.5" /> Merge in
        </Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={del} title="Delete this player and all their data">
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {/* Auto-suggested league matches — one click to link (unlinked players only) */}
      {!player.linked && !mode && player.suggestions && player.suggestions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="sub">Likely:</span>
          {player.suggestions.map((s) => (
            <Button key={s.discordId} size="sm" variant="secondary" disabled={busy} onClick={() => linkSuggested(s.discordId)} title={`Link to ${s.name} (${s.discordId})`}>
              <Link2 className="size-3.5" /> {s.name}
            </Button>
          ))}
        </div>
      )}

      {mode && (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={q}
              onChange={(e) => search(e.target.value)}
              placeholder={mode === "link" ? "Search league players, or paste a Discord ID…" : "Search a duplicate Tour player to fold in…"}
              className="max-w-sm"
            />
            <Button size="sm" variant="secondary" onClick={close}><X className="size-3.5" /></Button>
          </div>
          {/* Typed a raw Discord snowflake → link it directly (no league match needed) */}
          {mode === "link" && /^\d{16,20}$/.test(q.trim()) && (
            <div className="mt-2">
              <Button size="sm" disabled={busy} onClick={() => pick({ value: q.trim(), label: q.trim(), detail: "manual Discord ID" })}>
                <Link2 className="size-3.5" /> Link Discord ID {q.trim()}
              </Button>
            </div>
          )}
          {results.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {results.map((r) => (
                <button
                  key={r.value}
                  disabled={busy}
                  onClick={() => pick(r)}
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", textAlign: "left", color: "var(--text)", cursor: "pointer" }}
                >
                  <span className="font-semibold">{r.label}</span> <span className="sub">· {r.detail}</span>
                </button>
              ))}
            </div>
          )}
          {q.trim().length >= 1 && results.length === 0 && !/^\d{16,20}$/.test(q.trim()) && (
            <p className="sub mt-1">No matches{mode === "link" ? " — or paste their Discord ID to link it directly." : "."}</p>
          )}
        </div>
      )}
    </div>
  );
}

import Link from "next/link";
import { ArrowLeft, Search, Wrench, Wand2 } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { listTourPlayers, identityCounts } from "@/lib/services/identity";
import { Callout } from "@/components/Callout";
import { IdentityRow } from "@/components/IdentityRow";
import { PrunePhantomsButton } from "@/components/PrunePhantomsButton";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "unlinked", label: "Unlinked" },
  { key: "linked", label: "Linked" },
  { key: "all", label: "All" },
] as const;

export default async function Identity({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string }> }) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only — you don&apos;t have access.</Callout>
      </main>
    );
  }

  const { q, filter: rawFilter } = await searchParams;
  const filter = (FILTERS.find((f) => f.key === rawFilter)?.key ?? "unlinked") as "unlinked" | "linked" | "all";
  const [players, counts] = await Promise.all([listTourPlayers(q ?? "", 1000, filter), identityCounts()]);
  const filterCount = { unlinked: counts.unlinked, linked: counts.linked, all: counts.total };

  return (
    <main>
      <p>
        <Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link>
      </p>
      <h1>Identity manager</h1>
      <p className="sub">
        <strong style={{ color: "var(--success)" }}>{counts.linked}</strong> linked · {counts.unlinked} still on{" "}
        <code>legacy:</code> ids · {counts.total} total. Link a player to their Discord identity (pick from the league
        list), or fold a duplicate into the right person.
      </p>

      <Callout type="info" className="mb-3">
        <strong>Don&apos;t link 300 by hand.</strong>{" "}
        <Link href="/admin/identity/auto-link" className="inline-flex items-center gap-1"><Wand2 className="size-3.5" /> Auto-link from signups</Link> matches everyone it can
        confidently resolve (signup @username -&gt; real id, via the league DB + shared-guild roster) for one-click bulk
        approval. Then mop up stragglers below. Duplicates from a re-import?{" "}
        <Link href="/admin/identity/recover" className="inline-flex items-center gap-1"><Wrench className="size-3.5" /> Recover duplicates</Link>.
      </Callout>

      <div className="mb-3"><PrunePhantomsButton /></div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/admin/identity?filter=${f.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className="pill hover:no-underline"
            style={{
              background: f.key === filter ? "var(--accent-2)" : "var(--surface-2)",
              color: f.key === filter ? "#fff" : "var(--muted)",
              border: "1px solid var(--border)",
            }}
          >
            {f.label} ({filterCount[f.key]})
          </Link>
        ))}
        <form className="ml-auto flex items-center gap-2" action="/admin/identity">
          <input type="hidden" name="filter" value={filter} />
          <input name="q" defaultValue={q ?? ""} placeholder="Search players…" className="search" style={{ marginBottom: 0 }} />
          <button type="submit" className="inline-flex items-center gap-1"><Search className="size-3.5" /> Search</button>
        </form>
      </div>

      {players.map((p) => (
        <IdentityRow key={p.id} player={p} />
      ))}
      {players.length === 0 && <p className="sub">{filter === "unlinked" ? "No unlinked players — everyone's mapped 🎉" : "No players match."}</p>}
      {players.length >= 1000 && <p className="sub mt-2">Showing the first 1000 — narrow with search.</p>}
    </main>
  );
}

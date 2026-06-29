import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { listTourPlayers, identityCounts } from "@/lib/services/identity";
import { Callout } from "@/components/Callout";
import { IdentityRow } from "@/components/IdentityRow";

export const dynamic = "force-dynamic";

export default async function Identity({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only — you don&apos;t have access.</Callout>
      </main>
    );
  }

  const { q } = await searchParams;
  const [players, counts] = await Promise.all([listTourPlayers(q ?? "", 80), identityCounts()]);

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
        Linking sets a player&apos;s real Discord id (which lights up cross-site profile links). Merging is for the same
        person appearing twice — it moves all their history onto one player and deletes the dupe.
      </Callout>

      <form className="mb-3 flex items-center gap-2" action="/admin/identity">
        <input name="q" defaultValue={q ?? ""} placeholder="Search players…" className="search" style={{ marginBottom: 0 }} />
        <button type="submit" className="inline-flex items-center gap-1"><Search className="size-3.5" /> Search</button>
      </form>

      {players.map((p) => (
        <IdentityRow key={p.id} player={p} />
      ))}
      {players.length === 0 && <p className="sub">No players match.</p>}
      {!q && <p className="sub mt-2">Showing the 80 most active players — search to find anyone.</p>}
    </main>
  );
}

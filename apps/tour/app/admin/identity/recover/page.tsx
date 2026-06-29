import Link from "next/link";
import { ArrowLeft, ArrowRight, AlertTriangle } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { planIdentityRecovery } from "@/lib/services/identity";
import { Callout } from "@/components/Callout";
import { RecoverApply } from "@/components/RecoverApply";

export const dynamic = "force-dynamic";

export default async function RecoverDuplicates() {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only — you don&apos;t have access.</Callout>
      </main>
    );
  }

  const { merges, ambiguous } = await planIdentityRecovery();
  const pairs = merges.map((m) => ({ keepId: m.keepId, dropId: m.dropId }));

  return (
    <main>
      <p>
        <Link href="/admin/identity" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> identity</Link>
      </p>
      <h1>Recover duplicates</h1>
      <p className="sub">
        A re-import before the importer knew about linked players created duplicate <code>legacy:</code> rows and moved the
        rebuilt data onto them. Each row below folds a duplicate <strong>into</strong> the linked player it belongs to —
        nothing happens until you press apply. <strong>Matched by exact display name</strong> unless marked otherwise; eyeball
        the set counts before applying.
      </p>

      {merges.length === 0 && ambiguous.length === 0 && (
        <Callout type="info" className="mt-3">No duplicates to recover — everything&apos;s consolidated 🎉</Callout>
      )}

      {merges.length > 0 && (
        <div className="card mt-3">
          <div className="bracket-title">
            {merges.length} duplicate{merges.length === 1 ? "" : "s"} to fold in
          </div>
          <table>
            <thead>
              <tr>
                <th>Duplicate (drop)</th>
                <th className="num">its sets</th>
                <th></th>
                <th>Keep (linked)</th>
                <th className="num">its sets</th>
                <th>Match</th>
              </tr>
            </thead>
            <tbody>
              {merges.map((m) => (
                <tr key={m.dropId}>
                  <td>{m.dropName} <span className="sub">· legacy</span></td>
                  <td className="num">{m.dropSets}</td>
                  <td className="sub"><ArrowRight className="size-3.5" /></td>
                  <td>{m.keepName} <span className="sub">· {m.keepDiscordId.slice(0, 10)}…</span></td>
                  <td className="num">{m.keepSets}</td>
                  <td className="sub">{m.via === "alias" ? "remembered" : "name"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-0.5 py-2"><RecoverApply pairs={pairs} /></div>
        </div>
      )}

      {ambiguous.length > 0 && (
        <div className="card mt-3">
          <div className="bracket-title flex items-center gap-1.5">
            <AlertTriangle className="size-4" style={{ color: "var(--warning)" }} /> {ambiguous.length} need a manual decision
          </div>
          <p className="sub px-0.5">
            These duplicates match more than one linked player by name — I won&apos;t guess. Merge them by hand in the{" "}
            <Link href="/admin/identity">identity manager</Link>.
          </p>
          <table>
            <thead>
              <tr><th>Duplicate</th><th>Possible matches</th></tr>
            </thead>
            <tbody>
              {ambiguous.map((a) => (
                <tr key={a.dropId}>
                  <td>{a.name}</td>
                  <td className="sub">{a.candidates.map((c) => c.name).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

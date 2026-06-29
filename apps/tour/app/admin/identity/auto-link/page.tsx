import Link from "next/link";
import { ArrowLeft, ArrowRight, AlertTriangle, Wand2 } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { planAutoLink } from "@/lib/services/identity";
import { applyAutoLinkAction } from "@/app/admin/identity/actions";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

export default async function AutoLink() {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only — you don&apos;t have access.</Callout>
      </main>
    );
  }

  const { links, merges, ambiguous } = await planAutoLink();
  const total = links.length + merges.length;

  return (
    <main>
      <p>
        <Link href="/admin/identity" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> identity</Link>
      </p>
      <h1>Auto-link from signups</h1>
      <p className="sub">
        Every unlinked player whose name resolves to <strong>exactly one</strong> Discord id — chained from the signup
        @username through the league reference and a live, in-memory read of the Tour Discord roster (that roster is never
        stored; only the ids you approve are saved). Checked rows below get applied; <strong>uncheck</strong> any you
        don&apos;t trust, then approve. Names that map to several different people are listed separately for manual handling.
      </p>

      {total === 0 && ambiguous.length === 0 && (
        <Callout type="info" className="mt-3">No confident matches to apply — link the rest by hand in the identity manager.</Callout>
      )}

      {total > 0 && (
        <ActionFlashForm action={applyAutoLinkAction}>
          {links.length > 0 && (
            <div className="card mt-3">
              <div className="bracket-title">{links.length} to link</div>
              <table>
                <thead>
                  <tr><th style={{ width: 32 }}></th><th>Player</th><th className="num">sets</th><th></th><th>Discord identity</th></tr>
                </thead>
                <tbody>
                  {links.map((p) => (
                    <tr key={p.playerId}>
                      <td><input type="checkbox" name="pick" value={`${p.playerId}|${p.discordId}`} defaultChecked /></td>
                      <td>{p.playerName}</td>
                      <td className="num">{p.sets}</td>
                      <td className="sub"><ArrowRight className="size-3.5" /></td>
                      <td>{p.refName} <span className="sub">· {p.discordId}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {merges.length > 0 && (
            <div className="card mt-3">
              <div className="bracket-title">{merges.length} duplicate{merges.length === 1 ? "" : "s"} to merge (already linked elsewhere)</div>
              <p className="sub px-0.5">These resolve to a Discord id another player already holds — same person twice. Approving folds the duplicate into the linked one.</p>
              <table>
                <thead>
                  <tr><th style={{ width: 32 }}></th><th>Duplicate</th><th className="num">sets</th><th></th><th>Folds into</th></tr>
                </thead>
                <tbody>
                  {merges.map((p) => (
                    <tr key={p.playerId}>
                      <td><input type="checkbox" name="pick" value={`${p.playerId}|${p.discordId}`} defaultChecked /></td>
                      <td>{p.playerName}</td>
                      <td className="num">{p.sets}</td>
                      <td className="sub"><ArrowRight className="size-3.5" /></td>
                      <td>{p.mergeIntoName} <span className="sub">· {p.discordId}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="px-0.5 py-2">
            <SubmitButton pendingText="Applying…"><Wand2 className="size-4" /> Approve checked ({total})</SubmitButton>
          </div>
        </ActionFlashForm>
      )}

      {ambiguous.length > 0 && (
        <div className="card mt-3">
          <div className="bracket-title flex items-center gap-1.5">
            <AlertTriangle className="size-4" style={{ color: "var(--warning)" }} /> {ambiguous.length} ambiguous — pick by hand
          </div>
          <p className="sub px-0.5">These names match more than one Discord identity, so I won&apos;t guess. Resolve them in the <Link href="/admin/identity">identity manager</Link>.</p>
          <table>
            <thead><tr><th>Player</th><th>Possible identities</th></tr></thead>
            <tbody>
              {ambiguous.map((a) => (
                <tr key={a.playerId}>
                  <td>{a.playerName}</td>
                  <td className="sub">{a.candidates.map((c) => `${c.name} (${c.discordId.slice(0, 8)}…)`).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

import Link from "next/link";
import { ArrowLeft, GitMerge } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { NoAccess } from "@/components/NoAccess";
import { getClaimPairs } from "@/lib/services/identity";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { applyAllClaimsAction } from "./actions";

export const dynamic = "force-dynamic";

// Identity is TO-only (the shell only checks "has any access").
export default async function ClaimHistory() {
  if (!(await isAdmin())) return <NoAccess what="manage identities" />;
  const pairs = await getClaimPairs();

  return (
    <main>
      <p><Link href="/admin/identity" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> identity</Link></p>
      <h1>Claim history</h1>
      <p className="sub">
        Accounts that are <strong>linked to a Discord id but hold no data</strong> — their real history sits on a
        same-name legacy player that was never merged in (common when someone signed up but played under a slightly
        different in-game name). Claiming merges that history onto the linked account.
      </p>

      {pairs.length === 0 ? (
        <Callout type="success">No un-claimed accounts — every linked player already has its history.</Callout>
      ) : (
        <>
          <div className="flex items-center gap-3 my-3">
            <ActionFlashForm action={applyAllClaimsAction}>
              <ConfirmButton message={`Claim all ${pairs.length} accounts? Each merges its same-name legacy history onto the linked account. Cannot be undone.`} variant="default" size="sm">
                <GitMerge className="size-3.5" /> Claim all {pairs.length}
              </ConfirmButton>
            </ActionFlashForm>
            <span className="sub">Review below first — matching is by name, so double-check any that look wrong.</span>
          </div>

          <div className="card" style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Linked account (empty)</th>
                  <th>Discord id</th>
                  <th>Will claim</th>
                  <th className="num">Sets</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((p) => (
                  <tr key={p.linkedId}>
                    <td><Link href={`/players/${p.linkedId}`}>{p.linkedName}</Link></td>
                    <td className="sub">{p.discordId}</td>
                    <td><Link href={`/players/${p.candidateId}`}>{p.candidateName}</Link></td>
                    <td className="num">{p.sets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

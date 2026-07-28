// "Never pair these two players" blocklist. Applied at schedule-build time
// (elsewhere -- this page is management UI only, not the scheduler itself).

import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Input } from "@/components/ui/input";
import { PlayerSearch } from "@/components/PlayerSearch";
import { loadAvoidedPairs, loadPlayersForPicker } from "@/lib/loaders/avoided-pairs";
import { addAvoidedPair, removeAvoidedPair } from "./actions";

export const dynamic = "force-dynamic";

export default async function AvoidedPairsPage() {
  await requireAdmin();
  const [pairs, players] = await Promise.all([loadAvoidedPairs(), loadPlayersForPicker()]);

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/avoided-pairs" />
      <main>
        <h2 style={{ margin: 0 }}>Avoided pairs</h2>
        <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
          These two players will never be scheduled against each other. The rule is applied
          when a season&apos;s schedule is built -- a division small enough that a full
          round-robin can&apos;t honor it will surface a warning at build time instead of
          silently ignoring it.
        </p>

        <div className="card">
          <strong>Block a pairing</strong>
          <ActionFlashForm action={addAvoidedPair}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start", marginTop: 8 }}>
              <PlayerSearch players={players} name="playerAId" placeholder="First player…" />
              <PlayerSearch players={players} name="playerBId" placeholder="Second player…" />
              <Input
                type="text"
                name="note"
                placeholder="Note (optional)"
                style={{ flex: "2 1 220px" }}
              />
              <SubmitButton>Block pairing</SubmitButton>
            </div>
          </ActionFlashForm>
        </div>

        <div className="card">
          <strong>Blocked pairings ({pairs.length})</strong>
          {pairs.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>No blocked pairings yet.</p>
          ) : (
            <div className="table-scroll" style={{ marginTop: 8 }}>
              <table className="table-dense">
                <thead>
                  <tr>
                    <th>Pairing</th>
                    <th>Note</th>
                    <th>Added</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {p.aName} <span className="muted">{"<->"}</span> {p.bName}
                      </td>
                      <td className="muted">{p.note ?? "-"}</td>
                      <td className="muted">{p.createdAt.toISOString().slice(0, 10)}</td>
                      <td style={{ textAlign: "right" }}>
                        <ActionFlashForm action={removeAvoidedPair} style={{ display: "inline" }}>
                          <input type="hidden" name="id" value={p.id} />
                          <ConfirmButton
                            variant="secondary"
                            size="sm"
                            message={`Unblock ${p.aName} <-> ${p.bName}? They can be scheduled against each other again.`}
                          >
                            Remove
                          </ConfirmButton>
                        </ActionFlashForm>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  );
}

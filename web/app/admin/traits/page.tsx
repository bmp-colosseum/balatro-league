import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { loadTraitsAdmin } from "@/lib/loaders/traits-admin";
import { SiteNav } from "@/components/SiteNav";
import { DiscordId } from "@/components/DiscordId";
import { AdminNav } from "@/components/AdminNav";
import { TraitEditorRow } from "./TraitEditorRow";
import { saveTrait, resetTrait } from "./actions";

export const dynamic = "force-dynamic";

export default async function TraitsAdminPage() {
  await requireAdmin();
  const rows = await loadTraitsAdmin();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/traits" />
      <main>
        <h2>Player traits</h2>
        <p className="muted">
          Cosmetic flavour shown on player profiles, earned automatically from ban/pick behaviour.
          Edit each trait&apos;s label, description, or emoji here, or upload a custom icon (resized to
          48px and stored in the database). Leave a field blank to fall back to the built-in default.
          The <strong>who has it</strong> list shows everyone currently earning each trait.
        </p>

        <div style={{ display: "grid", gap: 16 }}>
          {rows.map((row) => (
            <div
              key={row.key}
              style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 240px", gap: 16, alignItems: "start" }}
            >
              <TraitEditorRow row={row} saveAction={saveTrait} resetAction={resetTrait} />

              <div className="card" style={{ alignSelf: "start" }}>
                <strong style={{ fontSize: 13 }}>
                  Who has it{" "}
                  <span className="muted" style={{ fontWeight: 400 }}>({row.holders.length})</span>
                </strong>
                {row.holders.length === 0 ? (
                  <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>No one currently.</p>
                ) : (
                  <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", fontSize: 12, display: "grid", gap: 3, maxHeight: 220, overflowY: "auto" }}>
                    {row.holders.map((h) => (
                      <li key={h.id}>
                        <Link href={`/profile/${h.id}`}>{h.name}</Link>
                        <DiscordId value={h.discordId} username={h.username} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}

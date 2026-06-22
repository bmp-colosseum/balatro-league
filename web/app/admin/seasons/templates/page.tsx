import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { loadAdminTemplates } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { TierEditor } from "@/components/TierEditor";
import { saveTemplate, deleteTemplate } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

const SEED = [
  { name: "Legendary", divisionCount: 1 },
  { name: "Rare", divisionCount: 6 },
  { name: "Uncommon", divisionCount: 6 },
  { name: "Common", divisionCount: 6 },
];

export default async function AdminTemplatesPage() {
  await requireAdmin();
  const templates = await loadAdminTemplates();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <h2>Tier templates</h2>
        <p className="muted">
          Saved tier layouts for the Create Season form. The ★ Last used one updates automatically
          each time you create a season.
        </p>

        <div className="card">
          <strong>Create a new template</strong>
          <form action={saveTemplate}>
            <label style={{ flex: "1 1 100%" }}>
              Name
              <Input name="templateName" placeholder="e.g. Compact Pyramid" required />
            </label>
            <TierEditor initial={SEED} showTemplateLoader={false} />
            <Button type="submit" className="mt-3">Save template</Button>
          </form>
        </div>

        <div className="card">
          <strong>Saved templates</strong>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Layout</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr><td colSpan={4} className="muted">No templates saved yet.</td></tr>
              ) : templates.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.isLastUsed && (
                      <span className="pill" style={{ background: "rgba(241,196,15,0.2)", color: "var(--accent)", marginRight: 6 }}>
                        LAST USED
                      </span>
                    )}
                    <strong>{t.name}</strong>
                  </td>
                  <td><span className="muted">{t.config.map((c) => `${c.name}×${c.divisionCount}`).join(" · ")}</span></td>
                  <td>{t.updatedAt.toISOString().slice(0, 10)}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <details>
                      <summary style={{ cursor: "pointer" }}>
                        <span className="secondary" style={{ display: "inline-block", padding: "4px 8px" }}>Edit</span>
                      </summary>
                      {/* Inline edit form. saveTemplate sees the `id`
                          field and updates in place (rename + relayout
                          atomic). TierEditor renders this template's
                          current config and emits JSON in the hidden
                          `config` field on submit. */}
                      <form action={saveTemplate} style={{ marginTop: 8, padding: 12, border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-2)", minWidth: 380 }}>
                        <input type="hidden" name="id" value={t.id} />
                        <label style={{ display: "block", marginBottom: 8 }}>
                          Name <Input name="templateName" defaultValue={t.name} required />
                        </label>
                        <TierEditor initial={t.config} showTemplateLoader={false} />
                        <Button type="submit" className="mt-2">Save changes</Button>
                      </form>
                    </details>
                    <form action={deleteTemplate}>
                      <input type="hidden" name="id" value={t.id} />
                      <Button type="submit" variant="destructive">Delete</Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ marginTop: 12 }}>
            <Link href="/admin/seasons">← Back to Seasons</Link>
          </p>
        </div>
      </main>
    </>
  );
}

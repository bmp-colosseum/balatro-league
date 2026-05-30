import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { TierEditor } from "@/components/TierEditor";
import { saveTemplate, deleteTemplate } from "../actions";

export const dynamic = "force-dynamic";

const SEED = [
  { name: "Legendary", divisionCount: 1 },
  { name: "Rare", divisionCount: 4 },
  { name: "Uncommon", divisionCount: 6 },
  { name: "Common", divisionCount: 6 },
];

function parseTemplateConfig(json: string) {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.map((e) => ({
      name: String(e?.name ?? ""),
      divisionCount: Number(e?.divisionCount) || 1,
    }));
  } catch {
    return [];
  }
}

export default async function AdminTemplatesPage() {
  await requireAdmin();
  const templates = await prisma.tierTemplate.findMany({
    orderBy: [{ isLastUsed: "desc" }, { name: "asc" }],
  });

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <h2>Tier templates</h2>
        <p className="muted">
          Saved layouts for the Create Season form. The ★ Last used template is auto-updated after
          every season create.
        </p>

        <div className="card">
          <strong>Create a new template</strong>
          <form action={saveTemplate}>
            <label style={{ flex: "1 1 100%" }}>
              Name
              <input name="templateName" placeholder="e.g. Compact Pyramid" required />
            </label>
            <TierEditor initial={SEED} showTemplateLoader={false} />
            <button type="submit" style={{ marginTop: 12 }}>Save template</button>
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
              ) : templates.map((t) => {
                const config = parseTemplateConfig(t.config);
                return (
                  <tr key={t.id}>
                    <td>
                      {t.isLastUsed && (
                        <span className="pill" style={{ background: "rgba(241,196,15,0.2)", color: "#f1c40f", marginRight: 6 }}>
                          LAST USED
                        </span>
                      )}
                      <strong>{t.name}</strong>
                    </td>
                    <td><span className="muted">{config.map((c) => `${c.name}×${c.divisionCount}`).join(" · ")}</span></td>
                    <td>{t.updatedAt.toISOString().slice(0, 10)}</td>
                    <td>
                      <form action={deleteTemplate}>
                        <input type="hidden" name="id" value={t.id} />
                        <button type="submit" className="danger">Delete</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
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

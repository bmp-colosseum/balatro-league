import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { TierEditor } from "@/components/TierEditor";
import { activateSeason, createSeason, endSeason, setSeasonPreset } from "./actions";

export const dynamic = "force-dynamic";

const DEFAULT_TIERS = [
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

export default async function AdminSeasonsPage() {
  await requireAdmin();

  const [seasons, templatesRaw, lastUsed, presets] = await Promise.all([
    prisma.season.findMany({
      include: {
        _count: { select: { divisions: true } },
        tiers: { orderBy: { position: "asc" }, include: { _count: { select: { divisions: true } } } },
        divisions: { include: { _count: { select: { members: true, pairings: true } } } },
        matchConfigPreset: true,
      },
      orderBy: [{ isActive: "desc" }, { startedAt: "desc" }],
    }),
    prisma.tierTemplate.findMany({ orderBy: [{ isLastUsed: "desc" }, { name: "asc" }] }),
    prisma.tierTemplate.findUnique({ where: { name: "Last used" } }),
    prisma.matchConfigPreset.findMany({ orderBy: { name: "asc" } }),
  ]);

  const templates = templatesRaw.map((t) => ({
    id: t.id,
    name: t.name,
    config: parseTemplateConfig(t.config),
    isLastUsed: t.isLastUsed,
  }));

  const initial = lastUsed ? parseTemplateConfig(lastUsed.config) : DEFAULT_TIERS;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <h2>Seasons</h2>

        <div className="card">
          <strong>Create new season</strong>
          <p className="muted">
            Configure tiers, then submit. Pre-filled with your last-used layout (★). Created as{" "}
            <strong>inactive</strong> — your current active season is untouched.
          </p>
          <form action={createSeason}>
            <label>Name <input name="name" required placeholder="Season 2" /></label>
            <label>Deadline (UTC) <input name="deadline" type="datetime-local" /></label>
            <label>Group size <input name="targetGroupSize" type="number" min={2} max={20} defaultValue={5} /></label>
            <label>Min group <input name="minGroupSize" type="number" min={2} max={20} defaultValue={3} /></label>
            <label>
              Visibility
              <select name="visibility" defaultValue="PUBLIC">
                <option value="PUBLIC">PUBLIC (visible to players)</option>
                <option value="INTERNAL">INTERNAL (admin-only test)</option>
              </select>
            </label>

            <div style={{ flex: "1 1 100%", marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <strong>Tiers</strong>
                <span style={{ marginLeft: "auto" }}>
                  <Link href="/admin/seasons/templates">
                    <button type="button" className="secondary">Manage templates</button>
                  </Link>
                </span>
              </div>
              <TierEditor initial={initial} templates={templates} />
            </div>

            <button type="submit" style={{ marginTop: 12 }}>Create season</button>
          </form>
        </div>

        <div className="grid grid-2">
          {seasons.length === 0 ? (
            <div className="muted">No seasons yet.</div>
          ) : seasons.map((s) => {
            const players = s.divisions.reduce((sum, d) => sum + d._count.members, 0);
            const sets = s.divisions.reduce((sum, d) => sum + d._count.pairings, 0);
            const tierLine = s.tiers
              .map((t) => `${t.name}: ${t._count.divisions}`)
              .join(" · ");
            return (
              <div key={s.id} className="card">
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 16 }}>{s.name}</strong>
                  {s.isActive ? (
                    <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "#2ecc71" }}>ACTIVE</span>
                  ) : (
                    <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "#c0c8cb" }}>Inactive</span>
                  )}
                  {s.visibility === "INTERNAL" ? (
                    <span className="pill" style={{ background: "rgba(241,196,15,0.2)", color: "#f1c40f" }}>INTERNAL</span>
                  ) : (
                    <span className="pill" style={{ background: "rgba(52,152,219,0.2)", color: "#76c7ff" }}>PUBLIC</span>
                  )}
                </div>
                <div className="muted" style={{ marginTop: 4 }}>{tierLine}</div>
                <div className="muted">
                  {players} player(s) · {sets} set(s) · group size {s.targetGroupSize} (min {s.minGroupSize})
                </div>
                <form
                  action={setSeasonPreset}
                  style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center" }}
                >
                  <input type="hidden" name="id" value={s.id} />
                  <label className="muted" style={{ fontSize: 12 }}>Match preset:</label>
                  <select name="presetId" defaultValue={s.matchConfigPresetId ?? ""} style={{ flex: 1 }}>
                    <option value="">— Use Default —</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <button type="submit" className="secondary">Save</button>
                </form>
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  {!s.isActive && (
                    <form action={activateSeason}>
                      <input type="hidden" name="id" value={s.id} />
                      <button type="submit" className="secondary">Activate</button>
                    </form>
                  )}
                  {s.isActive && (
                    <Link href={`/admin/seasons/${s.id}/end`}>
                      <button type="button">End season →</button>
                    </Link>
                  )}
                  {s.endedAt && (
                    <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
                      ended {s.endedAt.toISOString().slice(0, 10)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </>
  );
}

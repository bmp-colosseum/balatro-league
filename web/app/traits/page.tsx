// Public traits guide — what every trait is, how it's earned, and who
// currently has it. Traits are cosmetic badges earned automatically from how
// people play; this page lets anyone browse the catalog (the per-person view
// lives on each player's profile). Custom labels/descriptions/icons set on
// /admin/traits flow through here too.

import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import { loadTraitsAdmin } from "@/lib/loaders/traits-admin";

export const dynamic = "force-dynamic";

export default async function TraitsGuidePage() {
  // Reuses the same merged catalog + holder buckets as the admin editor — all
  // public-safe (trait copy + player display names). No reason/private data.
  const rows = await loadTraitsAdmin();

  return (
    <>
      <SiteNav activePath="/traits" />
      <main>
        <h2>🎭 Traits</h2>
        <p className="muted">
          Traits are just-for-fun badges earned automatically from how you play — no effect on
          standings. They start showing up after you&apos;ve played at least 10 games, so they build
          up over a few seasons. Visit any player&apos;s profile to see the ones they&apos;ve earned.
        </p>

        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          {rows.map((t) => (
            <div key={t.key} className="card" style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 26,
                  borderRadius: 8,
                  background: "rgba(155,89,182,0.12)",
                  border: "1px solid rgba(155,89,182,0.35)",
                  overflow: "hidden",
                }}
              >
                {t.iconDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={t.iconDataUrl} alt="" width={40} height={40} style={{ objectFit: "contain" }} />
                ) : (
                  <span>{t.emoji}</span>
                )}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: 15 }}>{t.label}</strong>
                <div style={{ fontSize: 13, marginTop: 2 }}>{t.description}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  🏅 <strong>How to earn:</strong> {t.criteria}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  {t.holders.length === 0 ? (
                    <em>No one has this yet — be the first.</em>
                  ) : (
                    <>
                      <strong>{t.holders.length}</strong> {t.holders.length === 1 ? "player has" : "players have"} it:{" "}
                      {t.holders.map((h, i) => (
                        <span key={h.id}>
                          {i > 0 && ", "}
                          <Link href={`/profile/${h.id}`}>{h.name}</Link>
                        </span>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}

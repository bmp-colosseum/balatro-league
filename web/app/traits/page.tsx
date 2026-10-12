// Public traits guide — what every trait is, how it's earned, and who
// currently has it. Traits are cosmetic badges earned automatically from how
// people play; this page lets anyone browse the catalog (the per-person view
// lives on each player's profile). Custom labels/descriptions/icons set on
// /admin/traits flow through here too.

import Link from "next/link";
import { Crown, GraduationCap, Ghost, Dices, type LucideIcon } from "lucide-react";
import { SiteNav } from "@/components/SiteNav";
import { DiscordId } from "@/components/DiscordId";
import { loadTraitsAdmin } from "@/lib/loaders/traits-admin";
import { criteriaForGuide } from "@/lib/trait-rules";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Traits - Balatro League",
};

// Inline SVG glyph per trait, used whenever an admin hasn't set a custom
// icon -- MASTER.md says no emoji as icons, and the registry's default
// presentation was all emoji (finding 4). Lucide is already the site's icon
// library (SiteNav's login glyph, the 404 button), so these count as "the
// site's SVG glyphs" rather than a one-off addition.
const TRAIT_ICONS: Record<string, LucideIcon> = {
  "white-warrior": Crown,
  "dr-spectred": GraduationCap,
  "ghostbuster": Ghost,
  "super-balatro-genius": Dices,
};

export default async function TraitsGuidePage() {
  // Reuses the same merged catalog + holder buckets as the admin editor — all
  // public-safe (trait copy + player display names). No reason/private data.
  const rows = await loadTraitsAdmin();

  return (
    <>
      <SiteNav activePath="/traits" />
      <main>
        <h1>Traits</h1>
        <p className="muted">
          Fun badges you earn from how you play. No effect on standings. Start showing up after 10 games.
        </p>

        <div className="grid grid-2" style={{ marginTop: 12 }}>
          {rows.map((t) => (
            <div key={t.key} className="card" style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 0 }}>
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
                ) : TRAIT_ICONS[t.key] ? (
                  (() => {
                    const Icon = TRAIT_ICONS[t.key]!;
                    return <Icon size={24} aria-hidden="true" style={{ color: "#9b59b6" }} />;
                  })()
                ) : (
                  <span>{t.emoji}</span>
                )}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: 15 }}>{t.label}</strong>
                <div style={{ fontSize: 13, marginTop: 2 }}>{t.description}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  <strong>How to earn:</strong> {criteriaForGuide(t.criteria)}
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
                          <Link href={`/profile/${h.id}`} prefetch={false}>{h.name}</Link>
                          <DiscordId value={h.discordId} username={h.username} />
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

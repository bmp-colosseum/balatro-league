import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { loadDeckBansPage } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminNav } from "@/components/AdminNav";
import { CANONICAL_DECKS, CANONICAL_STAKES, deckDescription, stakeDescription } from "@/lib/balatro-info";
import defaults from "@/lib/match-defaults.json";
import {
  addDeck,
  addStake,
  createPreset,
  deletePreset,
  removeDeck,
  removeStake,
  renamePreset,
  seedStockPreset,
  setPresetRole,
} from "./actions";

export const dynamic = "force-dynamic";

const SEASON_DEFAULT_PRESET_ID_KEY = "season_default_preset_id";
const CASUAL_PRESET_ID_KEY = "casual_preset_id";
const CUSTOM_COMBO_PRESET_ID_KEY = "custom_combo_preset_id";

export default async function DeckSelectionPage({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string }>;
}) {
  await requireAdmin();
  const { preset: presetIdParam } = await searchParams;
  const { presets, selected, seasonDefaultPresetId, casualPresetId, customComboPresetId } =
    await loadDeckBansPage(presetIdParam);

  const seasonDefaultName = presets.find((p) => p.id === seasonDefaultPresetId)?.name ?? null;
  const casualName = presets.find((p) => p.id === casualPresetId)?.name ?? null;
  const customComboName = presets.find((p) => p.id === customComboPresetId)?.name ?? null;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/deck-bans" />
      <main>
        <h2>Deck/stake presets</h2>
        <p className="muted">
          A preset is a named set of decks + stakes the ban/pick flow samples combos from.
          Names are arbitrary — what matters is which preset each <strong>role</strong> points at:
        </p>
        <ul className="muted" style={{ marginTop: -4, fontSize: 13 }}>
          <li>
            <strong>Standard</strong>{" "}
            {seasonDefaultName ? (
              <>→ <code>{seasonDefaultName}</code></>
            ) : (
              <em>(unset — falls back to whichever preset exists)</em>
            )}{" "}
            — the bans/picks pool for league matches (<code>/start-match</code>), unless a season picks its own.
          </li>
          <li>
            <strong>Challenge</strong>{" "}
            {casualName ? (
              <>→ <code>{casualName}</code></>
            ) : (
              <em>(unset — falls back to whichever preset exists)</em>
            )}{" "}
            — used by <code>/challenge</code>. Edit independently of the season default.
          </li>
          <li>
            <strong>Custom</strong>{" "}
            {customComboName ? (
              <>→ <code>{customComboName}</code></>
            ) : (
              <em>(unset — falls back to the Challenge preset)</em>
            )}{" "}
            — allowed stakes for the in-match &ldquo;agree on a specific deck/stake&rdquo; picker.
            Point it at a preset that includes Planet/Spectral/Spectral+ to offer them there without
            touching the <code>/challenge</code> pool.
          </li>
        </ul>
        <p className="muted" style={{ fontSize: 13 }}>
          A stock &apos;Stock&apos; preset is auto-seeded on first use and both pointers are set to it. Repoint either pointer below by editing a preset.
        </p>
        <div className="card" style={{ fontSize: 12 }}>
          <strong>Stock seed</strong>
          <p style={{ marginTop: 4 }}>
            <strong>Decks ({defaults.decks.length}):</strong> {defaults.decks.join(", ")}
          </p>
          <p>
            <strong>Stakes ({defaults.stakes.length}):</strong> {defaults.stakes.join(", ")}
          </p>
          <p className="muted">
            {defaults.decks.length * defaults.stakes.length} combos available to the bot&apos;s 9-pick sampler.
          </p>
        </div>

        {presets.length === 0 ? (
          <div className="card">
            <strong>No presets yet</strong>
            <p className="muted">Create one with Balatro&apos;s stock decks/stakes, or start from scratch.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <form action={seedStockPreset}>
                <Button type="submit">
                  Seed a &apos;Stock&apos; preset ({defaults.decks.length} decks, {defaults.stakes.length} stakes)
                </Button>
              </form>
              <CreatePresetForm seedAvailable={false} />
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16 }}>
            <PresetSidebar
              presets={presets}
              selectedId={selected?.id ?? null}
              seasonDefaultPresetId={seasonDefaultPresetId}
              casualPresetId={casualPresetId}
              customComboPresetId={customComboPresetId}
            />
            {selected ? (
              <PresetEditor
                preset={selected}
                isSeasonDefault={selected.id === seasonDefaultPresetId}
                isCasual={selected.id === casualPresetId}
                isCustomCombo={selected.id === customComboPresetId}
              />
            ) : (
              <div className="card muted">Pick a preset from the left, or create a new one.</div>
            )}
          </div>
        )}
      </main>
    </>
  );
}

function PresetSidebar({
  presets,
  selectedId,
  seasonDefaultPresetId,
  casualPresetId,
  customComboPresetId,
}: {
  presets: Array<{ id: string; name: string; seasonCount: number }>;
  selectedId: string | null;
  seasonDefaultPresetId: string | null;
  casualPresetId: string | null;
  customComboPresetId: string | null;
}) {
  return (
    <div className="card" style={{ alignSelf: "start" }}>
      <strong>Presets</strong>
      <ul style={{ marginTop: 8, padding: 0, listStyle: "none" }}>
        {presets.map((p) => {
          const isActive = p.id === selectedId;
          const tags: string[] = [];
          if (p.id === seasonDefaultPresetId) tags.push("standard");
          if (p.id === casualPresetId) tags.push("challenge");
          if (p.id === customComboPresetId) tags.push("custom");
          return (
            <li key={p.id} style={{ marginBottom: 4 }}>
              <Link
                href={`/admin/deck-bans?preset=${p.id}`}
                style={{
                  display: "block",
                  padding: "6px 8px",
                  borderRadius: 4,
                  background: isActive ? "var(--bg-accent, rgba(88,101,242,0.15))" : "transparent",
                  color: isActive ? "var(--text)" : undefined,
                  textDecoration: "none",
                }}
              >
                <div>
                  {p.name}
                  {tags.length > 0 && (
                    <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>
                      ({tags.join(", ")})
                    </span>
                  )}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {p.seasonCount} season{p.seasonCount === 1 ? "" : "s"} using this
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      <hr style={{ margin: "12px 0", border: "none", borderTop: "1px solid var(--border)" }} />
      <CreatePresetForm seedAvailable={true} />
    </div>
  );
}

function CreatePresetForm({ seedAvailable }: { seedAvailable: boolean }) {
  return (
    <form action={createPreset} style={{ display: "grid", gap: 6 }}>
      <Input type="text" name="name" placeholder="New preset name" required />
      {seedAvailable && (
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" name="seedDefaults" defaultChecked />
          Pre-fill with Balatro defaults
        </label>
      )}
      <Button type="submit">Create preset</Button>
    </form>
  );
}

function PresetEditor({
  preset,
  isSeasonDefault,
  isCasual,
  isCustomCombo,
}: {
  preset: { id: string; name: string; decks: string[]; stakes: string[] };
  isSeasonDefault: boolean;
  isCasual: boolean;
  isCustomCombo: boolean;
}) {
  const totalCombos = preset.decks.length * preset.stakes.length;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <form action={renamePreset} style={{ display: "flex", gap: 6, alignItems: "center", flex: 1 }}>
            <input type="hidden" name="id" value={preset.id} />
            <strong style={{ marginRight: 4 }}>Name:</strong>
            <Input type="text" name="name" defaultValue={preset.name} required style={{ flex: 1 }} />
            <Button type="submit">Save name</Button>
          </form>
          <form action={deletePreset}>
            <input type="hidden" name="id" value={preset.id} />
            <Button type="submit" variant="secondary" className="text-[#e74c3c]">
              Delete preset
            </Button>
          </form>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {preset.decks.length} decks × {preset.stakes.length} stakes ={" "}
          <strong>{totalCombos} possible combos</strong>.
          {totalCombos < 9 && (
            <span style={{ color: "#e74c3c" }}> ⚠ need at least 9 for a normal match.</span>
          )}
        </p>
        <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <form action={setPresetRole}>
            <input type="hidden" name="id" value={preset.id} />
            <input type="hidden" name="role" value={SEASON_DEFAULT_PRESET_ID_KEY} />
            <Button type="submit" disabled={isSeasonDefault}>
              {isSeasonDefault ? "✓ Used as Standard (league bans/picks)" : "Use as Standard (league bans/picks)"}
            </Button>
          </form>
          <form action={setPresetRole}>
            <input type="hidden" name="id" value={preset.id} />
            <input type="hidden" name="role" value={CASUAL_PRESET_ID_KEY} />
            <Button type="submit" disabled={isCasual}>
              {isCasual ? "✓ Used for /challenge" : "Use for /challenge"}
            </Button>
          </form>
          <form action={setPresetRole}>
            <input type="hidden" name="id" value={preset.id} />
            <input type="hidden" name="role" value={CUSTOM_COMBO_PRESET_ID_KEY} />
            <Button type="submit" disabled={isCustomCombo}>
              {isCustomCombo ? "✓ Used as Custom (custom-combo picker)" : "Use as Custom (custom-combo picker)"}
            </Button>
          </form>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ListEditor
          title="Decks"
          items={preset.decks}
          canonical={CANONICAL_DECKS}
          describe={deckDescription}
          presetId={preset.id}
          addAction={addDeck}
          removeAction={removeDeck}
          kind="decks"
        />
        <ListEditor
          title="Stakes"
          items={preset.stakes}
          canonical={CANONICAL_STAKES}
          describe={stakeDescription}
          presetId={preset.id}
          addAction={addStake}
          removeAction={removeStake}
          kind="stakes"
        />
      </div>
    </div>
  );
}

function ListEditor({
  title,
  items,
  canonical,
  describe,
  presetId,
  addAction,
  removeAction,
  kind,
}: {
  title: string;
  items: string[];
  canonical: ReadonlyArray<{ name: string; description: string }>;
  describe: (name: string) => string | undefined;
  presetId: string;
  addAction: (fd: FormData) => Promise<void>;
  removeAction: (fd: FormData) => Promise<void>;
  kind: "decks" | "stakes";
}) {
  // Only show options the preset doesn't already have, so admin can't add
  // duplicates and the dropdown shrinks as they fill the preset.
  const available = canonical.filter((c) => !items.includes(c.name));
  // Decks are 142×190 cards, stakes are 58×58 chips — render at small
  // inline sizes so the list stays scannable. Both PNGs are served as
  // static assets from web/public/balatro/ (synced from the bot's
  // src/assets/balatro/ at install time).
  const slug = (n: string) => n.toLowerCase().replace(/\+/g, "_plus").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const imgSize = kind === "decks" ? { w: 28, h: 38 } : { w: 24, h: 24 };
  const imgFor = (name: string) => `/balatro/${kind}/${slug(name)}.png`;
  return (
    <div className="card">
      <strong>{title} ({items.length})</strong>
      <form action={addAction} style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <input type="hidden" name="id" value={presetId} />
        <select name="name" required defaultValue="" style={{ flex: 1 }}>
          <option value="" disabled>
            {available.length === 0 ? `All ${title.toLowerCase()} added` : `Add a ${title.toLowerCase().replace(/s$/, "")}…`}
          </option>
          {available.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} — {c.description}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={available.length === 0}>Add</Button>
      </form>
      <ul style={{ marginTop: 12, padding: 0, listStyle: "none" }}>
        {items.map((name) => (
          <li
            key={name}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "4px 0",
              borderBottom: "1px solid var(--border)",
              gap: 8,
            }}
            title={describe(name) ?? ""}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imgFor(name)}
                alt=""
                width={imgSize.w}
                height={imgSize.h}
                style={{
                  display: "inline-block",
                  imageRendering: "pixelated",
                  flexShrink: 0,
                }}
                onError={undefined}
              />
              <span>
                <strong>{name}</strong>
                {describe(name) && (
                  <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                    {describe(name)}
                  </span>
                )}
              </span>
            </span>
            <form action={removeAction}>
              <input type="hidden" name="id" value={presetId} />
              <input type="hidden" name="name" value={name} />
              <Button type="submit" variant="ghost" size="sm" className="text-[#e74c3c]">
                remove
              </Button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}

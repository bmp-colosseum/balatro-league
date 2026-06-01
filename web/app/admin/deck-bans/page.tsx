import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { loadDeckBansPage } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { CANONICAL_DECKS, CANONICAL_STAKES, deckDescription, stakeDescription } from "@/lib/balatro-info";
import {
  addDeck,
  addStake,
  createPreset,
  deletePreset,
  removeDeck,
  removeStake,
  renamePreset,
  seedDefaultPreset,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function DeckSelectionPage({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string }>;
}) {
  await requireAdmin();
  const { preset: presetIdParam } = await searchParams;
  const { presets, selected } = await loadDeckBansPage(presetIdParam);

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/deck-bans" />
      <main>
        <h2>Deck Bans presets</h2>
        <p className="muted">
          A preset is a named set of decks + stakes that <code>/start-match</code> samples
          combos from for the ban/pick flow. Seasons pick which preset to use (set on each
          season's card); seasons without a preset fall back to <strong>Default</strong>.
        </p>

        {presets.length === 0 ? (
          <div className="card">
            <strong>No presets yet</strong>
            <p className="muted">Create one with Balatro's stock decks/stakes, or start from scratch.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <form action={seedDefaultPreset}>
                <button type="submit">Seed a Default preset (15 decks, 8 stakes)</button>
              </form>
              <CreatePresetForm seedAvailable={false} />
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16 }}>
            <PresetSidebar presets={presets} selectedId={selected?.id ?? null} />
            {selected ? (
              <PresetEditor preset={selected} />
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
}: {
  presets: Array<{ id: string; name: string; seasonCount: number }>;
  selectedId: string | null;
}) {
  return (
    <div className="card" style={{ alignSelf: "start" }}>
      <strong>Presets</strong>
      <ul style={{ marginTop: 8, padding: 0, listStyle: "none" }}>
        {presets.map((p) => {
          const isActive = p.id === selectedId;
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
                <div>{p.name}</div>
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
      <input type="text" name="name" placeholder="New preset name" required />
      {seedAvailable && (
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" name="seedDefaults" defaultChecked />
          Pre-fill with Balatro defaults
        </label>
      )}
      <button type="submit">Create preset</button>
    </form>
  );
}

function PresetEditor({
  preset,
}: {
  preset: { id: string; name: string; decks: string[]; stakes: string[] };
}) {
  const totalCombos = preset.decks.length * preset.stakes.length;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <form action={renamePreset} style={{ display: "flex", gap: 6, alignItems: "center", flex: 1 }}>
            <input type="hidden" name="id" value={preset.id} />
            <strong style={{ marginRight: 4 }}>Name:</strong>
            <input type="text" name="name" defaultValue={preset.name} required style={{ flex: 1 }} />
            <button type="submit">Save name</button>
          </form>
          <form action={deletePreset}>
            <input type="hidden" name="id" value={preset.id} />
            <button type="submit" className="secondary" style={{ color: "#e74c3c" }}>
              Delete preset
            </button>
          </form>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {preset.decks.length} decks Ã— {preset.stakes.length} stakes ={" "}
          <strong>{totalCombos} possible combos</strong>.
          {totalCombos < 9 && (
            <span style={{ color: "#e74c3c" }}> âš  need at least 9 for a normal match.</span>
          )}
        </p>
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
        />
        <ListEditor
          title="Stakes"
          items={preset.stakes}
          canonical={CANONICAL_STAKES}
          describe={stakeDescription}
          presetId={preset.id}
          addAction={addStake}
          removeAction={removeStake}
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
}: {
  title: string;
  items: string[];
  canonical: ReadonlyArray<{ name: string; description: string }>;
  describe: (name: string) => string | undefined;
  presetId: string;
  addAction: (fd: FormData) => Promise<void>;
  removeAction: (fd: FormData) => Promise<void>;
}) {
  // Only show options the preset doesn't already have, so admin can't add
  // duplicates and the dropdown shrinks as they fill the preset.
  const available = canonical.filter((c) => !items.includes(c.name));
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
        <button type="submit" disabled={available.length === 0}>Add</button>
      </form>
      <ul style={{ marginTop: 12, padding: 0, listStyle: "none" }}>
        {items.map((name) => (
          <li
            key={name}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "4px 0",
              borderBottom: "1px solid var(--border)",
              gap: 8,
            }}
            title={describe(name) ?? ""}
          >
            <span>
              <strong>{name}</strong>
              {describe(name) && (
                <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                  {describe(name)}
                </span>
              )}
            </span>
            <form action={removeAction}>
              <input type="hidden" name="id" value={presetId} />
              <input type="hidden" name="name" value={name} />
              <button
                type="submit"
                className="muted"
                style={{
                  background: "none",
                  border: "none",
                  color: "#e74c3c",
                  cursor: "pointer",
                }}
              >
                remove
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}

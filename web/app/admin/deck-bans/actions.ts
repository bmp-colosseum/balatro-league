"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { isCanonicalDeck, isCanonicalStake } from "@/lib/balatro-info";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import defaults from "@/lib/match-defaults.json";
import type { ActionResult } from "@/lib/action-result";
import {
  DEFAULT_POOL_SIZE,
  validatePoolConfig,
  type DeckWeight,
  type GuaranteedStake,
  type StakeWeight,
} from "@/lib/deck-pool-config-core";

// Mirrors src/league-config.ts — kept inline to avoid a cross-package
// import. These are arbitrary strings; whatever the bot writes is what
// the bot reads.
const SEASON_DEFAULT_PRESET_ID_KEY = "season_default_preset_id";
const CASUAL_PRESET_ID_KEY = "casual_preset_id";
const CUSTOM_COMBO_PRESET_ID_KEY = "custom_combo_preset_id";

// Any change to MatchConfigPreset (create, rename, delete, edit
// decks/stakes) needs to bust the cached preset list on every
// surface that renders it. Without this, an admin who creates a
// preset on /admin/deck-bans wouldn't see it in /admin/seasons or
// the per-season picker until the page's revalidate window expires.
function revalidatePresetSurfaces() {
  revalidatePath("/admin/deck-bans");
  revalidatePath("/admin/seasons");
  // The per-season picker lives on every season detail page.
  // Layout-level revalidation invalidates all of them.
  revalidatePath("/admin/seasons", "layout");
}

export async function createPreset(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const seedDefaults = String(formData.get("seedDefaults") ?? "") === "on";
  if (!name) return;
  const preset = await prisma.matchConfigPreset.create({
    data: {
      name,
      decks: seedDefaults ? defaults.decks : [],
      stakes: seedDefaults ? defaults.stakes : [],
    },
  });
  revalidatePresetSurfaces();
  redirect(`/admin/deck-bans?preset=${preset.id}`);
}

export async function renamePreset(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  await prisma.matchConfigPreset.update({ where: { id }, data: { name } });
  revalidatePresetSurfaces();
}

export async function deletePreset(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  // Season.matchConfigPresetId is ON DELETE SET NULL — any season pointing
  // at this preset will fall back to whatever the season-default pointer
  // resolves to at match time. If this preset is itself the pointer
  // target, clearing the row means the resolver falls through to the
  // first existing preset (least-surprise) — admin can re-point on
  // /admin/deck-bans afterwards.
  await prisma.matchConfigPreset.delete({ where: { id } });
  await prisma.leagueConfig.deleteMany({
    where: {
      key: { in: [SEASON_DEFAULT_PRESET_ID_KEY, CASUAL_PRESET_ID_KEY, CUSTOM_COMBO_PRESET_ID_KEY] },
      value: id,
    },
  });
  revalidatePresetSurfaces();
  redirect("/admin/deck-bans");
}

export async function addDeck(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  // Only canonical decks (defined in src/data/balatro-info.json) are valid —
  // prevents typos from creating phantom decks the ban menu can't describe.
  if (!isCanonicalDeck(name)) return;
  const preset = await prisma.matchConfigPreset.findUniqueOrThrow({ where: { id } });
  if (preset.decks.includes(name)) return;
  await prisma.matchConfigPreset.update({
    where: { id },
    data: { decks: [...preset.decks, name] },
  });
  revalidatePresetSurfaces();
}

export async function removeDeck(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "");
  if (!id || !name) return;
  const preset = await prisma.matchConfigPreset.findUniqueOrThrow({ where: { id } });
  await prisma.matchConfigPreset.update({
    where: { id },
    data: { decks: preset.decks.filter((d) => d !== name) },
  });
  revalidatePresetSurfaces();
}

export async function addStake(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  if (!isCanonicalStake(name)) return;
  const preset = await prisma.matchConfigPreset.findUniqueOrThrow({ where: { id } });
  if (preset.stakes.includes(name)) return;
  await prisma.matchConfigPreset.update({
    where: { id },
    data: { stakes: [...preset.stakes, name] },
  });
  revalidatePresetSurfaces();
}

export async function removeStake(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "");
  if (!id || !name) return;
  const preset = await prisma.matchConfigPreset.findUniqueOrThrow({ where: { id } });
  await prisma.matchConfigPreset.update({
    where: { id },
    data: { stakes: preset.stakes.filter((s) => s !== name) },
  });
  revalidatePresetSurfaces();
}

// One-shot bootstrap action — if no presets exist at all, create a
// single 'Stock' preset filled with the canonical Balatro decks/stakes
// and point both LeagueConfig pointers at it. Admin can rename, edit,
// or move the pointers freely afterwards. Idempotent: safe to call
// when presets already exist (does nothing in that case).
export async function seedStockPreset() {
  const { user } = await requireAdmin();
  const existing = await prisma.matchConfigPreset.findFirst({ orderBy: { createdAt: "asc" } });
  let anchor = existing;
  if (!anchor) {
    anchor = await prisma.matchConfigPreset.create({
      data: { name: "Stock", decks: defaults.decks, stakes: defaults.stakes },
    });
    recordAudit({
      actor: actorFromAdminUser(user),
      action: "preset.seed-stock",
      targetType: "MatchConfigPreset",
      targetId: anchor.id,
      summary: "Seeded stock Balatro preset",
    });
  }
  for (const key of [SEASON_DEFAULT_PRESET_ID_KEY, CASUAL_PRESET_ID_KEY]) {
    const existingRow = await prisma.leagueConfig.findUnique({ where: { key } });
    if (!existingRow) {
      await prisma.leagueConfig.create({ data: { key, value: anchor.id, updatedBy: user.discordId } });
    }
  }
  revalidatePresetSurfaces();
  redirect(`/admin/deck-bans?preset=${anchor.id}`);
}

// Re-point either LeagueConfig pointer at the given preset. The
// `role` form field is the LeagueConfig KEY (so the page can render
// one form per role without an enum mapping).
export async function setPresetRole(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!id) return;
  if (
    role !== SEASON_DEFAULT_PRESET_ID_KEY &&
    role !== CASUAL_PRESET_ID_KEY &&
    role !== CUSTOM_COMBO_PRESET_ID_KEY
  )
    return;
  // Verify the preset still exists — guards against a race where the
  // admin clicked Delete in another tab.
  const preset = await prisma.matchConfigPreset.findUnique({ where: { id } });
  if (!preset) return;
  await prisma.leagueConfig.upsert({
    where: { key: role },
    create: { key: role, value: id, updatedBy: user.discordId },
    update: { value: id, updatedBy: user.discordId },
  });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "config.set",
    targetType: "LeagueConfig",
    targetId: role,
    summary: `Pointed ${role} at preset "${preset.name}"`,
    metadata: { presetId: id, presetName: preset.name },
  });
  revalidatePresetSurfaces();
}

// Save a preset's per-deck/per-stake weights + pool policy (caps, guaranteed
// minimums) -- the pieces src/match-pool.ts's generatePool already supports
// but that, before this action, no admin surface ever wrote. Every deck in
// the preset always posts a weight_<deck> field (PoolPolicyEditor renders
// one row per current preset.decks/stakes entry, never a subset), so this
// reads straight off the preset's OWN decks/stakes -- never a client-
// submitted list -- both to match how addDeck/removeDeck already treat
// membership as server-side truth and so a stale form can't resurrect a
// deck/stake the admin removed in another tab.
//
// Validates via the SAME pure core (validatePoolConfig) the editor's client-
// side feasibility line approximates, so a config that can't fill its own
// pool is refused here with the specific reason -- never silently saved and
// discovered as a runtime throw the next time generatePool runs it.
export async function savePoolConfig(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, message: "Missing preset id." };
  const preset = await prisma.matchConfigPreset.findUnique({ where: { id } });
  if (!preset) return { ok: false, message: "That preset no longer exists — reload the page." };

  // A weight of exactly 1 (uniform, the default) is dropped rather than
  // stored -- keeps the JSON column to just the real overrides, and matches
  // parseDeckWeights/parseStakeWeights's own "unlisted = weight 1" contract.
  const deckWeights: DeckWeight[] = [];
  for (const deck of preset.decks) {
    const raw = formData.get(`weight_${deck}`);
    if (raw == null || raw === "") continue;
    const weight = Number(raw);
    if (Number.isFinite(weight) && weight !== 1) deckWeights.push({ deck, weight });
  }

  const stakeWeights: StakeWeight[] = [];
  const guaranteedStakes: GuaranteedStake[] = [];
  for (const stake of preset.stakes) {
    const rawWeight = formData.get(`stakeWeight_${stake}`);
    if (rawWeight != null && rawWeight !== "") {
      const weight = Number(rawWeight);
      if (Number.isFinite(weight) && weight !== 1) stakeWeights.push({ stake, weight });
    }
    const rawMin = formData.get(`guarantee_${stake}`);
    if (rawMin != null && rawMin !== "") {
      const min = Number(rawMin);
      if (Number.isFinite(min) && min > 0) guaranteedStakes.push({ stake, min });
    }
  }

  const maxPerDeckRaw = String(formData.get("maxPerDeck") ?? "").trim();
  const maxPerStakeRaw = String(formData.get("maxPerStake") ?? "").trim();
  const maxPerDeck = maxPerDeckRaw === "" ? undefined : Number(maxPerDeckRaw);
  const maxPerStake = maxPerStakeRaw === "" ? undefined : Number(maxPerStakeRaw);

  // The league's match pool size is a fixed league-wide constant (see
  // web/lib/league-settings.ts's DEFAULTS.matchPolicy.poolSize -- not
  // per-preset, not currently editable from the UI), so that's what a
  // saved config is actually validated against.
  const validation = validatePoolConfig({
    decks: preset.decks,
    stakes: preset.stakes,
    poolSize: DEFAULT_POOL_SIZE,
    deckWeights,
    maxPerDeck,
    maxPerStake,
    guaranteedStakes,
    stakeWeights,
  });
  if (!validation.ok) {
    return { ok: false, message: validation.errors.join(" ") };
  }

  const deckWeightsJson = deckWeights.length > 0 ? JSON.stringify(deckWeights) : null;
  const poolPolicy = {
    ...(maxPerDeck !== undefined ? { maxPerDeck } : {}),
    ...(maxPerStake !== undefined ? { maxPerStake } : {}),
    ...(guaranteedStakes.length > 0 ? { guaranteedStakes } : {}),
    ...(stakeWeights.length > 0 ? { stakeWeights } : {}),
  };
  const poolPolicyJson = Object.keys(poolPolicy).length > 0 ? JSON.stringify(poolPolicy) : null;

  await prisma.matchConfigPreset.update({
    where: { id },
    data: { deckWeights: deckWeightsJson, poolPolicy: poolPolicyJson },
  });

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "preset.pool-policy",
    targetType: "MatchConfigPreset",
    targetId: id,
    summary: `Updated pool weights/policy for preset "${preset.name}"`,
    metadata: { deckWeights: deckWeightsJson, poolPolicy: poolPolicyJson },
  });
  revalidatePresetSurfaces();
  return { ok: true, message: "Pool weights + policy saved." };
}

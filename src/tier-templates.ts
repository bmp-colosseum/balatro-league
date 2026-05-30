// CRUD helpers for tier templates (saved layouts admins reuse when creating seasons).
// Config is stored as JSON-encoded TierConfig[].

import { prisma } from "./db.js";
import { DEFAULT_TIERS, type TierConfig } from "./pyramid.js";

export const LAST_USED_NAME = "Last used";

export interface TemplateEntry {
  id: string;
  name: string;
  config: TierConfig[];
  isLastUsed: boolean;
  updatedAt: Date;
}

export function parseConfig(json: string): TierConfig[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return DEFAULT_TIERS;
    const out: TierConfig[] = [];
    for (const entry of parsed) {
      const name = String(entry?.name ?? "").trim();
      const count = Number(entry?.divisionCount);
      if (!name || !Number.isFinite(count) || count < 1) continue;
      out.push({ name, divisionCount: Math.max(1, Math.min(50, Math.floor(count))) });
    }
    return out.length > 0 ? out : DEFAULT_TIERS;
  } catch {
    return DEFAULT_TIERS;
  }
}

export async function listTemplates(): Promise<TemplateEntry[]> {
  const rows = await prisma.tierTemplate.findMany({
    orderBy: [{ isLastUsed: "desc" }, { name: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    config: parseConfig(r.config),
    isLastUsed: r.isLastUsed,
    updatedAt: r.updatedAt,
  }));
}

export async function getTemplate(id: string): Promise<TemplateEntry | null> {
  const row = await prisma.tierTemplate.findUnique({ where: { id } });
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    config: parseConfig(row.config),
    isLastUsed: row.isLastUsed,
    updatedAt: row.updatedAt,
  };
}

export async function saveTemplate(name: string, config: TierConfig[]): Promise<TemplateEntry> {
  const trimmed = name.trim() || "Untitled";
  const row = await prisma.tierTemplate.upsert({
    where: { name: trimmed },
    create: { name: trimmed, config: JSON.stringify(config), isLastUsed: false },
    update: { config: JSON.stringify(config) },
  });
  return {
    id: row.id,
    name: row.name,
    config: parseConfig(row.config),
    isLastUsed: row.isLastUsed,
    updatedAt: row.updatedAt,
  };
}

export async function deleteTemplate(id: string): Promise<void> {
  await prisma.tierTemplate.delete({ where: { id } });
}

// Update or create the "Last used" template after every successful season create.
export async function recordLastUsed(config: TierConfig[]): Promise<void> {
  await prisma.tierTemplate.upsert({
    where: { name: LAST_USED_NAME },
    create: { name: LAST_USED_NAME, config: JSON.stringify(config), isLastUsed: true },
    update: { config: JSON.stringify(config), isLastUsed: true },
  });
}

// Best template to pre-fill the create-season form with: Last used if it exists, otherwise default.
export async function preferredDefault(): Promise<TierConfig[]> {
  const lastUsed = await prisma.tierTemplate.findUnique({ where: { name: LAST_USED_NAME } });
  if (lastUsed) return parseConfig(lastUsed.config);
  return DEFAULT_TIERS;
}

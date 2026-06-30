// Import from an uploaded zip of the per-season xlsx workbooks. Production (where the
// files aren't on disk) is populated by an admin uploading the zip. Extracts to a temp
// dir and runs the all-xlsx import against it. Thin orchestration — the parsing/writing
// lives in import.ts. The zip just needs the `TT*.xlsx` workbooks (+ TT*Signups.xlsx)
// and optionally `league-players.csv`; no HTML sheets anymore.
import AdmZip from "adm-zip";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAllFromXlsx, previewImport, applySignupRefsFromDir } from "./import";
import { loadLeagueRefFromCsv } from "./identity";

// DRY-RUN: extract the zip and report what an import would produce, writing nothing.
export async function previewFromZip(zipBuffer: Buffer): Promise<Awaited<ReturnType<typeof previewImport>>> {
  const tmp = await mkdtemp(join(tmpdir(), "tt-preview-"));
  try {
    new AdmZip(zipBuffer).extractAllTo(tmp, true);
    return await previewImport(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Find a file by name anywhere under `dir` (the zip may nest its contents).
async function findFile(dir: string, name: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (!e.isDirectory() && e.name === name) return join(dir, e.name);
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findFile(join(dir, e.name), name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export interface UploadImportResult {
  imported?: Awaited<ReturnType<typeof importAllFromXlsx>>;
  leagueRef?: number; // league name→discordId rows loaded (for identity linking)
  signups?: { stored: number }; // raw xlsx signup handles stored (resolve live later)
  ran: string[];
  errors: { which: string; message: string }[];
}

export async function importFromZip(zipBuffer: Buffer): Promise<UploadImportResult> {
  const tmp = await mkdtemp(join(tmpdir(), "tt-import-"));
  const ran: string[] = [];
  const errors: { which: string; message: string }[] = [];
  let imported: UploadImportResult["imported"];

  try {
    new AdmZip(zipBuffer).extractAllTo(tmp, true);

    // The whole import: seasons, conferences/seeds, rosters/draft/seeds, regular +
    // playoff results, bracket/champion, career stats — all from the TT*.xlsx workbooks.
    try {
      imported = await importAllFromXlsx(tmp);
      if (imported.seasons > 0) ran.push(`seasons(${imported.seasons})`);
      else throw new Error("No TT<n>.xlsx workbooks found in the zip.");
    } catch (e) {
      errors.push({ which: "import", message: e instanceof Error ? e.message : String(e) });
    }

    // Optional: a `league-players.csv` (name,discordId) → populate the LeagueRef table so
    // identity-linking works in prod (not just from a local file).
    let leagueRef: number | undefined;
    const csvPath = await findFile(tmp, "league-players.csv");
    const csv = csvPath ? await readFile(csvPath, "utf8").catch(() => null) : null;
    if (csv) {
      try {
        leagueRef = (await loadLeagueRefFromCsv(csv)).count;
        if (leagueRef > 0) ran.push("league-ref");
      } catch (e) {
        errors.push({ which: "league-ref", message: e instanceof Error ? e.message : String(e) });
      }
    }

    // Store the xlsx signups (preferred name ↔ @username) so identity resolution can
    // chain them to real Discord ids.
    let signups: { stored: number } | undefined;
    try {
      signups = await applySignupRefsFromDir(tmp);
      if (signups.stored > 0) ran.push("signups");
    } catch (e) {
      errors.push({ which: "signups", message: e instanceof Error ? e.message : String(e) });
    }

    if (ran.length === 0) throw new Error(errors.map((x) => `${x.which}: ${x.message}`).join(" · ") || "Nothing imported.");
    return { imported, leagueRef, signups, ran, errors };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

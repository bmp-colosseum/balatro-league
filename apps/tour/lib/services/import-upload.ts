// Import from an uploaded zip of the Google-Sheets exports — so production (where
// the sheets aren't on disk) can be populated by an admin uploading the data,
// instead of relying on a local TOUR_SHEETS_DIR. Extracts to a temp dir, locates
// the sheets root, runs the same importHistorical + importConferenceSeason services against it,
// and cleans up. Thin orchestration — the parsing/writing lives in import.ts.
import AdmZip from "adm-zip";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importHistorical, importConferenceSeason } from "./import";
import { loadLeagueRefFromCsv } from "./identity";

// Walk the extracted tree to find the directory that looks like the sheets root:
// one that contains an `alltime/` subfolder (historical) or `Standings.html` (the
// conference season). Handles a zip with or without a wrapping top-level folder.
async function findSheetsRoot(dir: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = new Set(entries.map((e) => e.name));
  if (names.has("alltime") || names.has("Standings.html")) return dir;
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findSheetsRoot(join(dir, e.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export interface UploadImportResult {
  historical?: Awaited<ReturnType<typeof importHistorical>>;
  conference?: Awaited<ReturnType<typeof importConferenceSeason>>;
  leagueRef?: number; // league name→discordId rows loaded (for identity linking)
  ran: string[];
  errors: { which: string; message: string }[];
}

export async function importFromZip(zipBuffer: Buffer): Promise<UploadImportResult> {
  const tmp = await mkdtemp(join(tmpdir(), "tt-import-"));
  const ran: string[] = [];
  const errors: { which: string; message: string }[] = [];
  let historical: UploadImportResult["historical"];
  let conference: UploadImportResult["conference"];

  try {
    new AdmZip(zipBuffer).extractAllTo(tmp, true);
    const root = await findSheetsRoot(tmp);
    if (!root) throw new Error("Couldn't find the sheets in the zip — expected an `alltime/` folder and/or `Standings.html` inside it.");

    // Run each import independently so a partial upload still lands what it can.
    try {
      historical = await importHistorical(root);
      ran.push("historical");
    } catch (e) {
      errors.push({ which: "historical", message: e instanceof Error ? e.message : String(e) });
    }
    try {
      conference = await importConferenceSeason(root);
      ran.push("conference");
    } catch (e) {
      errors.push({ which: "conference", message: e instanceof Error ? e.message : String(e) });
    }

    // Optional: a `league-players.csv` (name,discordId) in the zip → populate the
    // LeagueRef table so identity-linking works in prod (not just from a local file).
    let leagueRef: number | undefined;
    const csvPath = join(root, "league-players.csv");
    const csv = await readFile(csvPath, "utf8").catch(() => null);
    if (csv) {
      try {
        leagueRef = (await loadLeagueRefFromCsv(csv)).count;
        if (leagueRef > 0) ran.push("league-ref");
      } catch (e) {
        errors.push({ which: "league-ref", message: e instanceof Error ? e.message : String(e) });
      }
    }

    if (ran.length === 0) throw new Error(errors.map((x) => `${x.which}: ${x.message}`).join(" · ") || "Nothing imported.");
    return { historical, conference, leagueRef, ran, errors };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

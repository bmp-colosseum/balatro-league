"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { addGuildMemberRole, fetchGuildMember } from "@/lib/discord";

// Minimal CSV parser supporting quoted fields (handles commas/newlines/quotes inside).
function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (field !== "" || row.length > 0) { row.push(field); rows.push(row); row = []; field = ""; }
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return { headers: [], rows: [] };

  const first = rows[0]!.map((h) => h.trim().toLowerCase());
  // Heuristic: treat first row as headers iff it doesn't contain a 17-20 digit Discord ID
  const looksLikeHeader = !first.some((c) => /\d{17,20}/.test(c));
  const headers = looksLikeHeader ? first : first.map((_, i) => `col${i}`);
  const dataRows = (looksLikeHeader ? rows.slice(1) : rows).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? "").trim(); });
    return obj;
  });
  return { headers, rows: dataRows };
}

function norm(s: string): string {
  return String(s ?? "").trim().toLowerCase();
}

export async function bulkImportSeason(formData: FormData) {
  await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "");
  const membersText = String(formData.get("members") ?? "");
  const matchesText = String(formData.get("matches") ?? "");

  if (!seasonId) redirect("/admin/seasons?err=missing-season");

  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    include: { divisions: { include: { tier: true } } },
  });
  if (!season) redirect("/admin/seasons?err=season-not-found");

  // division (lowercased+trimmed name) → Division row
  const divByName = new Map(season!.divisions.map((d) => [norm(d.name), d]));
  const guildId = process.env.DISCORD_GUILD_ID;

  // ====== Pass 1: members ======
  // Each row: division, challonge_name (or display_name), discord_id
  // Column order is the CSV's column order (script output uses these names).
  let membersAdded = 0;
  let membersSkipped = 0;
  const unknownDivisions = new Set<string>();
  const membersErrors: string[] = [];
  // (divisionNameLower) → Map(challongeNameLower → Player)
  const nameToPlayerByDiv = new Map<string, Map<string, { id: string; discordId: string }>>();
  // (discordId) → Player
  const playerByDiscordId = new Map<string, { id: string; discordId: string }>();

  if (membersText.trim()) {
    const { rows } = parseCsv(membersText);
    for (const r of rows) {
      const divisionName = r.division ?? r.col0 ?? "";
      const challongeName = r.challonge_name ?? r.name ?? r.col1 ?? "";
      const discordId = (r.discord_id ?? r.col2 ?? "").trim();
      if (!divisionName) { membersSkipped++; continue; }
      if (!discordId || !/^\d{17,20}$/.test(discordId)) {
        membersSkipped++;
        membersErrors.push(`${divisionName} / ${challongeName}: missing or malformed discord_id`);
        continue;
      }
      const div = divByName.get(norm(divisionName));
      if (!div) {
        unknownDivisions.add(divisionName);
        membersSkipped++;
        continue;
      }
      // Resolve a display name — prefer Discord guild nick → CSV name → "Unknown"
      let displayName = challongeName.trim();
      if (guildId && (!displayName)) {
        const m = await fetchGuildMember(guildId, discordId);
        if (m) displayName = m.nick || m.user?.username || displayName;
      }
      if (!displayName) displayName = `Player ${discordId.slice(-4)}`;

      const player = await prisma.player.upsert({
        where: { discordId },
        create: { discordId, displayName },
        update: { displayName },
      });
      await prisma.divisionMember.upsert({
        where: { divisionId_playerId: { divisionId: div.id, playerId: player.id } },
        create: { divisionId: div.id, playerId: player.id, status: "ACTIVE" },
        update: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
      });
      if (guildId && div.discordRoleId) {
        await addGuildMemberRole(guildId, discordId, div.discordRoleId);
      }
      playerByDiscordId.set(discordId, { id: player.id, discordId });
      const divKey = norm(divisionName);
      if (!nameToPlayerByDiv.has(divKey)) nameToPlayerByDiv.set(divKey, new Map());
      if (challongeName) nameToPlayerByDiv.get(divKey)!.set(norm(challongeName), { id: player.id, discordId });
      membersAdded++;
    }
  }

  // ====== Pass 2: matches ======
  // Each row: division, player1, player2, result, state
  // player1/player2 can be a Discord ID (preferred) OR a challonge_name
  // (looked up via the members pass we just did).
  let pairingsRecorded = 0;
  let pairingsSkipped = 0;
  const matchErrors: string[] = [];

  if (matchesText.trim()) {
    const { rows } = parseCsv(matchesText);
    for (const r of rows) {
      const divisionName = r.division ?? r.col0 ?? "";
      const p1Raw = (r.player1 ?? r.col1 ?? "").trim();
      const p2Raw = (r.player2 ?? r.col2 ?? "").trim();
      const result = (r.result ?? r.col3 ?? "").trim();
      const state = norm(r.state ?? r.col4 ?? "complete"); // default to complete if missing
      if (state && state !== "complete") { pairingsSkipped++; continue; }
      if (!divisionName || !p1Raw || !p2Raw) { pairingsSkipped++; continue; }
      const div = divByName.get(norm(divisionName));
      if (!div) {
        unknownDivisions.add(divisionName);
        pairingsSkipped++;
        continue;
      }
      if (!["2-0", "1-1", "0-2"].includes(result)) {
        matchErrors.push(`${divisionName} / ${p1Raw} vs ${p2Raw}: result "${result}" isn't 2-0 / 1-1 / 0-2`);
        pairingsSkipped++;
        continue;
      }

      const resolve = (raw: string) => {
        if (/^\d{17,20}$/.test(raw)) return playerByDiscordId.get(raw);
        return nameToPlayerByDiv.get(norm(divisionName))?.get(norm(raw));
      };
      const aPlayer = resolve(p1Raw);
      const bPlayer = resolve(p2Raw);
      if (!aPlayer || !bPlayer) {
        matchErrors.push(`${divisionName} / ${p1Raw} vs ${p2Raw}: can't resolve ${!aPlayer ? p1Raw : p2Raw} — not in members import`);
        pairingsSkipped++;
        continue;
      }

      const games = result === "2-0" ? { a: 2, b: 0 } : result === "0-2" ? { a: 0, b: 2 } : { a: 1, b: 1 };
      const [canonA, canonB] = aPlayer.id < bPlayer.id ? [aPlayer.id, bPlayer.id] : [bPlayer.id, aPlayer.id];
      const aIsCanonA = aPlayer.id === canonA;
      const gamesWonA = aIsCanonA ? games.a : games.b;
      const gamesWonB = aIsCanonA ? games.b : games.a;

      await prisma.pairing.upsert({
        where: { divisionId_playerAId_playerBId: { divisionId: div.id, playerAId: canonA, playerBId: canonB } },
        create: {
          divisionId: div.id,
          playerAId: canonA,
          playerBId: canonB,
          gamesWonA,
          gamesWonB,
          status: "CONFIRMED",
          reportedAt: new Date(),
          confirmedAt: new Date(),
        },
        update: {
          gamesWonA,
          gamesWonB,
          status: "CONFIRMED",
          confirmedAt: new Date(),
        },
      });
      pairingsRecorded++;
    }
  }

  revalidatePath("/admin/seasons");
  revalidatePath(`/admin/seasons/${seasonId}/bulk-import`);

  const summary = new URLSearchParams({
    membersAdded: String(membersAdded),
    membersSkipped: String(membersSkipped),
    pairingsRecorded: String(pairingsRecorded),
    pairingsSkipped: String(pairingsSkipped),
    unknownDivisions: [...unknownDivisions].slice(0, 10).join(" | "),
    membersErrors: membersErrors.slice(0, 8).join(" | "),
    matchErrors: matchErrors.slice(0, 8).join(" | "),
  }).toString();
  redirect(`/admin/seasons/${seasonId}/bulk-import?result=${encodeURIComponent(summary)}`);
}

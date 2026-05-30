import { Router, type Request, type Response } from "express";
import { prisma } from "../db.js";
import { clearMockData, isMockPlayer, makeRng, MOCK_PREFIX, simulateDivisionPairings } from "../mock.js";
import { parseTierConfig, PLAYERS_PER_DIVISION, tiersToText, DEFAULT_TIERS, type TierConfig } from "../pyramid.js";
import { deleteTemplate, listTemplates, preferredDefault, recordLastUsed, saveTemplate } from "../tier-templates.js";
import { gamesFromResult, parsePairingResult } from "../scoring.js";
import { announceResult } from "../announce.js";
import { tryGetDiscordClient } from "../discord.js";
import { computeStandings } from "../standings.js";
import { createTiersAndDivisions, tierColors } from "../tiers.js";
import { csvDocument } from "./csv.js";
import { html, raw, type RawHtml } from "./html.js";
import { layout } from "./layout.js";
import { sessionContext } from "./session-context.js";

export const router = Router();

// Render a pill for a tier given its position + display name.
// Uses tierColors() so any tier (including admin-customized names) gets a matching pill.
function pillForTier(position: number, name: string): RawHtml {
  const c = tierColors(position);
  return html`<span class="pill" style="background:${c.bg}; color:${c.fg}">${name}</span>`;
}

function send(res: Response, body: RawHtml) {
  res.set("Content-Type", "text/html; charset=utf-8").send(body.value);
}

// Parse a flash message from the query string (set after POSTs via redirect).
function readFlash(req: Request): { kind: "success" | "error"; message: string } | undefined {
  if (req.query.ok) return { kind: "success", message: String(req.query.ok) };
  if (req.query.err) return { kind: "error", message: String(req.query.err) };
  return undefined;
}

function redirectWith(res: Response, path: string, flash: { ok?: string; err?: string }) {
  const params = new URLSearchParams();
  if (flash.ok) params.set("ok", flash.ok);
  if (flash.err) params.set("err", flash.err);
  res.redirect(`${path}${params.toString() ? `?${params}` : ""}`);
}

// =============================================================================
// Dashboard
// =============================================================================

router.get("/", async (req, res) => {
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    include: { _count: { select: { divisions: true } } },
  });
  const [totalPlayers, fakePlayerCount, confirmed, disputed] = await Promise.all([
    prisma.player.count(),
    prisma.player.count({ where: { discordId: { startsWith: MOCK_PREFIX } } }),
    season ? prisma.pairing.count({ where: { division: { seasonId: season.id }, status: "CONFIRMED" } }) : Promise.resolve(0),
    season ? prisma.pairing.count({ where: { division: { seasonId: season.id }, status: "DISPUTED" } }) : Promise.resolve(0),
  ]);

  const body = html`
    <h2>Overview</h2>
    ${season
      ? html`<div class="grid grid-3">
          <div class="stat"><div class="label">Active season</div><div class="value">${season.name}</div></div>
          <div class="stat"><div class="label">Divisions</div><div class="value">${season._count.divisions}</div></div>
          <div class="stat"><div class="label">Sets confirmed</div><div class="value">${confirmed}</div></div>
        </div>
        <div class="grid grid-3" style="margin-top:16px">
          <div class="stat"><div class="label">Players (total)</div><div class="value">${totalPlayers}</div></div>
          <div class="stat"><div class="label">Fake players</div><div class="value">${fakePlayerCount}</div></div>
          <div class="stat"><div class="label">Disputed sets</div><div class="value">${disputed}</div></div>
        </div>
        <div class="card" style="margin-top:24px">
          <strong>Quick actions</strong>
          <p class="muted">Most common admin tasks.</p>
          <div style="display:flex; gap:8px; flex-wrap:wrap">
            <a href="/admin/players"><button class="secondary">Manage players</button></a>
            <a href="/admin/seasons"><button class="secondary">Seasons & pyramid</button></a>
            <a href="/admin/export/players.csv" download><button class="secondary" type="button">Download all players CSV</button></a>
            <form method="post" action="/admin/players/clear-fakes" onsubmit="return confirm('Delete every fake player + their sets?')" style="display:inline">
              <button class="danger" type="submit">Clear all fakes</button>
            </form>
          </div>
        </div>`
      : html`<div class="card">
          <strong>No active season.</strong>
          <p class="muted">Head to <a href="/admin/seasons">Seasons</a> to start one.</p>
        </div>`}
  `;

  send(res, layout({ title: "Dashboard", activePath: "/admin", flash: readFlash(req), body, ...(await sessionContext(req)) }));
});

// =============================================================================
// Players
// =============================================================================

router.get("/players", async (req, res) => {
  const filter = (req.query.filter as string) ?? "all";
  const where =
    filter === "real" ? { discordId: { not: { startsWith: MOCK_PREFIX } } }
    : filter === "fake" ? { discordId: { startsWith: MOCK_PREFIX } }
    : {};

  const players = await prisma.player.findMany({
    where: {
      ...where,
      ...(filter === "unassigned"
        ? { memberships: { none: { division: { season: { isActive: true } } } } }
        : {}),
      ...(filter === "dropped"
        ? { memberships: { some: { division: { season: { isActive: true } }, status: "DROPPED" } } }
        : {}),
    },
    include: {
      memberships: {
        where: { division: { season: { isActive: true } } },
        include: { division: true },
      },
    },
    orderBy: { displayName: "asc" },
  });

  const activeSeason = await prisma.season.findFirst({
    where: { isActive: true },
    include: {
      tiers: {
        orderBy: { position: "asc" },
        include: { divisions: { orderBy: { groupNumber: "asc" } } },
      },
    },
  });
  // Flat list of divisions across all tiers (top → bottom), used by the move-select.
  // Map each division id → its tier so we can render the right pill color per row.
  const divisionOptions = activeSeason?.tiers.flatMap((t) => t.divisions) ?? [];
  const tierByDivisionId = new Map<string, { position: number; name: string }>();
  if (activeSeason) {
    for (const tier of activeSeason.tiers) {
      for (const d of tier.divisions) {
        tierByDivisionId.set(d.id, { position: tier.position, name: tier.name });
      }
    }
  }

  const rows = players.map((p) => {
    const isFake = p.discordId.startsWith(MOCK_PREFIX);
    const membership = p.memberships[0];
    const currentDiv = membership?.division;
    const isDropped = membership?.status === "DROPPED";

    const moveSelect = activeSeason
      ? html`<form method="post" action="/admin/players/${p.id}/move" style="display:flex; gap:4px">
          <select name="divisionName">
            <option value="">— remove —</option>
            ${divisionOptions.map((d) =>
              html`<option value="${d.name}" ${currentDiv?.id === d.id ? "selected" : ""}>${d.name}</option>`,
            )}
          </select>
          <button type="submit">Apply</button>
        </form>`
      : raw('<span class="muted">no active season</span>');

    const currentTier = currentDiv ? tierByDivisionId.get(currentDiv.id) : undefined;
    const divLabel = currentDiv
      ? html`${currentTier ? pillForTier(currentTier.position, currentTier.name) : raw("")} ${currentDiv.name}${isDropped ? raw(' <span class="pill" style="background:rgba(231,76,60,0.2); color:#e74c3c">DROPPED</span>') : raw("")}`
      : raw('<span class="muted">—</span>');

    const dropAction = currentDiv
      ? isDropped
        ? html`<form method="post" action="/admin/players/${p.id}/reinstate"><button class="secondary" type="submit">Reinstate</button></form>`
        : html`<form method="post" action="/admin/players/${p.id}/drop" onsubmit="return confirm('Mark as dropped from this season? Played sets stay; unplayed ones get voided.')" style="display:flex; gap:4px">
            <input type="hidden" name="voidUnplayed" value="yes" />
            <button class="secondary" type="submit">Drop</button>
          </form>`
      : raw("");

    return html`<tr>
      <td><strong>${p.displayName}</strong></td>
      <td>${isFake ? raw('<span class="pill fake">FAKE</span>') : raw('<span class="pill real">REAL</span>')}</td>
      <td><span class="muted">${p.discordId}</span></td>
      <td>${divLabel}</td>
      <td>${moveSelect}</td>
      <td>${dropAction}</td>
      <td><form method="post" action="/admin/players/${p.id}/delete" onsubmit="return confirm('Delete this player permanently?')"><button class="danger" type="submit">Delete</button></form></td>
    </tr>`;
  });

  const body = html`
    <h2>Players</h2>
    <div class="card">
      <div style="display:flex; align-items:center; gap:8px">
        <strong>Add fake player</strong>
        <a href="/admin/players/bulk" style="margin-left:auto">→ Bulk add / auto-distribute</a>
      </div>
      <p class="muted">For testing without real Discord accounts. For many players at once, use the bulk page.</p>
      <form method="post" action="/admin/players/add-fake">
        <label>Name <input name="name" required placeholder="Alice" /></label>
        <label>Division (optional)
          <select name="divisionName">
            <option value="">— unassigned —</option>
            ${divisionOptions.map((d) => html`<option value="${d.name}">${d.name}</option>`)}
          </select>
        </label>
        <button type="submit">Add fake player</button>
      </form>
    </div>

    <div class="card">
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px">
        <strong>${players.length} player(s)</strong>
        <span style="margin-left:auto">
          <a href="/admin/players?filter=all">All</a> ·
          <a href="/admin/players?filter=real">Real</a> ·
          <a href="/admin/players?filter=fake">Fake</a> ·
          <a href="/admin/players?filter=unassigned">Unassigned</a> ·
          <a href="/admin/players?filter=dropped">Dropped</a>
        </span>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Discord ID</th><th>Current division</th><th>Move to</th><th>Drop / Reinstate</th><th></th></tr></thead>
        <tbody>${rows.length ? rows : html`<tr><td colspan="7" class="muted">No players match.</td></tr>`}</tbody>
      </table>
    </div>
  `;
  send(res, layout({ title: "Players", activePath: "/admin/players", flash: readFlash(req), body, ...(await sessionContext(req)) }));
});

// =============================================================================
// Bulk add + auto-distribute
// =============================================================================

router.get("/players/bulk", async (req, res) => {
  const activeSeason = await prisma.season.findFirst({
    where: { isActive: true },
    include: {
      tiers: {
        orderBy: { position: "asc" },
        include: { divisions: { orderBy: { groupNumber: "asc" } } },
      },
    },
  });
  const divisionOptions = activeSeason?.tiers.flatMap((t) => t.divisions) ?? [];

  const body = html`
    <h2>Bulk add players</h2>
    <p class="muted">Paste one player per line. Optional <code>-> Division</code> suffix places them immediately.</p>

    <div class="card">
      <strong>Paste</strong>
      <form method="post" action="/admin/players/bulk">
        <label style="flex:1 1 100%">
          Player list
          <textarea name="lines" rows="14" style="width:100%; font-family:ui-monospace, monospace; background:var(--surface-2); border:1px solid var(--border); color:var(--text); padding:8px; border-radius:4px" placeholder="Alice
Bob -> Common 1
Carol Smith -> Uncommon 2
Dave"></textarea>
        </label>
        <label>Default division (used when no <code>-></code> is given)
          <select name="defaultDivision">
            <option value="">— leave unassigned —</option>
            ${divisionOptions.map((d) => html`<option value="${d.name}">${d.name}</option>`)}
          </select>
        </label>
        <button type="submit">Add players</button>
        <a href="/admin/players"><button class="secondary" type="button">Cancel</button></a>
      </form>
    </div>

    <div class="card">
      <strong>Bulk add real players (by Discord ID)</strong>
      <p class="muted">Paste one Discord ID per line. Optional <code>-> Division</code> places them. Bot looks up each user's name from Discord.</p>
      <form method="post" action="/admin/players/bulk-real">
        <label style="flex:1 1 100%">
          Discord IDs
          <textarea name="lines" rows="8" style="width:100%; font-family:ui-monospace, monospace; background:var(--surface-2); border:1px solid var(--border); color:var(--text); padding:8px; border-radius:4px" placeholder="111111111111111111
222222222222222222 -> Common 1
333333333333333333 -> Rare 2"></textarea>
        </label>
        <label>Default division
          <select name="defaultDivision">
            <option value="">— leave unassigned —</option>
            ${divisionOptions.map((d) => html`<option value="${d.name}">${d.name}</option>`)}
          </select>
        </label>
        <button type="submit">Add real players</button>
      </form>
    </div>

    <div class="card">
      <strong>Auto-seed by rating</strong>
      <p class="muted">Place players top-down by their rating: highest ratings into Legendary, next batch into Rare, etc. Set ratings first on the <a href="/admin/rankings">Rankings page</a>. Unrated players go last.</p>
      <form method="post" action="/admin/players/auto-seed-by-rating">
        <label>Mode
          <select name="mode">
            <option value="unassigned">Seed unassigned players only</option>
            <option value="reseed">Reseed everyone (clears all current placements)</option>
          </select>
        </label>
        <button type="submit" onclick="return this.form.mode.value!=='reseed' || confirm('Reseed everyone? All current division memberships will be cleared and players redistributed by rating.')">Seed by rating</button>
      </form>
    </div>

    <div class="card">
      <strong>Auto-distribute unassigned players (random within a tier)</strong>
      <p class="muted">Takes every player not currently in a division and packs them round-robin across the selected tier's divisions. Useful when ratings aren't set.</p>
      <form method="post" action="/admin/players/auto-distribute">
        <label>Target tier
          <select name="tierName">
            ${(activeSeason?.tiers ?? []).map((t) => html`<option value="${t.name}">${t.name}</option>`)}
          </select>
        </label>
        <label>Source
          <select name="source">
            <option value="all">All unassigned players</option>
            <option value="fake">Fake players only</option>
            <option value="real">Real players only</option>
          </select>
        </label>
        <button type="submit">Distribute</button>
      </form>
    </div>
  `;
  send(res, layout({ title: "Bulk add", activePath: "/admin/players", flash: readFlash(req), body, ...(await sessionContext(req)) }));
});

interface ParsedLine {
  name: string;
  divisionName: string | null;
  raw: string;
}

function parseBulkLines(raw: string, defaultDivision: string | null): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const arrowIdx = trimmed.indexOf("->");
    if (arrowIdx === -1) {
      out.push({ name: trimmed, divisionName: defaultDivision, raw: trimmed });
    } else {
      const name = trimmed.slice(0, arrowIdx).trim();
      const divisionName = trimmed.slice(arrowIdx + 2).trim() || defaultDivision;
      if (name) out.push({ name, divisionName, raw: trimmed });
    }
  }
  return out;
}

router.post("/players/bulk", async (req, res) => {
  const lines = String(req.body.lines ?? "");
  const defaultDivision = String(req.body.defaultDivision ?? "").trim() || null;
  const parsed = parseBulkLines(lines, defaultDivision);

  if (parsed.length === 0) {
    return redirectWith(res, "/admin/players/bulk", { err: "No valid lines found." });
  }

  const season = await prisma.season.findFirst({ where: { isActive: true } });
  const divisionsByName = season
    ? new Map(
        (await prisma.division.findMany({ where: { seasonId: season.id } })).map((d) => [d.name, d]),
      )
    : new Map<string, { id: string }>();

  let added = 0;
  let assigned = 0;
  const errors: string[] = [];

  for (const line of parsed) {
    const discordId = `${MOCK_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const player = await prisma.player.create({
      data: { discordId, displayName: line.name },
    });
    added++;

    if (line.divisionName) {
      const division = divisionsByName.get(line.divisionName);
      if (!division) {
        errors.push(`${line.name}: no division "${line.divisionName}"`);
        continue;
      }
      const cap = season?.targetGroupSize ?? PLAYERS_PER_DIVISION;
      const count = await prisma.divisionMember.count({ where: { divisionId: division.id } });
      if (count >= cap) {
        errors.push(`${line.name}: ${line.divisionName} is full (${cap})`);
        continue;
      }
      await prisma.divisionMember.create({
        data: { divisionId: division.id, playerId: player.id },
      });
      assigned++;
    }
  }

  const msg = `Added ${added} player(s), placed ${assigned}. ${errors.length ? `${errors.length} issue(s): ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? "..." : ""}` : ""}`;
  redirectWith(res, "/admin/players", errors.length ? { err: msg } : { ok: msg });
});

router.post("/players/bulk-real", async (req, res) => {
  const lines = String(req.body.lines ?? "");
  const defaultDivision = String(req.body.defaultDivision ?? "").trim() || null;
  const parsed = parseBulkLines(lines, defaultDivision);

  if (parsed.length === 0) {
    return redirectWith(res, "/admin/players/bulk", { err: "No valid IDs found." });
  }

  const client = tryGetDiscordClient();
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  const divisionsByName = season
    ? new Map(
        (await prisma.division.findMany({ where: { seasonId: season.id } })).map((d) => [d.name, d]),
      )
    : new Map<string, { id: string }>();

  let added = 0;
  let updated = 0;
  let assigned = 0;
  const errors: string[] = [];

  for (const line of parsed) {
    const discordId = line.name; // the "name" slot holds the Discord ID for this form
    if (!/^\d{17,20}$/.test(discordId)) {
      errors.push(`${discordId}: not a valid Discord ID`);
      continue;
    }

    // Look up username from Discord; fall back to the ID if the lookup fails.
    let displayName = discordId;
    if (client) {
      try {
        const user = await client.users.fetch(discordId);
        displayName = user.username;
      } catch (err) {
        errors.push(`${discordId}: Discord lookup failed (${(err as Error).message.slice(0, 60)})`);
      }
    }

    const existing = await prisma.player.findUnique({ where: { discordId } });
    const player = existing
      ? await prisma.player.update({ where: { id: existing.id }, data: { displayName } })
      : await prisma.player.create({ data: { discordId, displayName } });
    if (existing) updated++; else added++;

    if (line.divisionName) {
      const division = divisionsByName.get(line.divisionName);
      if (!division) {
        errors.push(`${displayName}: no division "${line.divisionName}"`);
        continue;
      }
      const existingMembership = await prisma.divisionMember.findFirst({
        where: { playerId: player.id, division: { seasonId: season!.id } },
      });
      if (existingMembership) {
        // already placed; skip
        continue;
      }
      const cap = season?.targetGroupSize ?? PLAYERS_PER_DIVISION;
      const count = await prisma.divisionMember.count({ where: { divisionId: division.id } });
      if (count >= cap) {
        errors.push(`${displayName}: ${line.divisionName} is full (${cap})`);
        continue;
      }
      await prisma.divisionMember.create({ data: { divisionId: division.id, playerId: player.id } });
      assigned++;
    }
  }

  const msg = `Added ${added}, updated ${updated}, placed ${assigned}. ${errors.length ? `${errors.length} issue(s): ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? "..." : ""}` : ""}`;
  redirectWith(res, "/admin/players", errors.length ? { err: msg } : { ok: msg });
});

router.post("/players/auto-distribute", async (req, res) => {
  const tierName = String(req.body.tierName ?? "").trim();
  const source = String(req.body.source ?? "all");
  if (!tierName) {
    return redirectWith(res, "/admin/players/bulk", { err: "Pick a target tier." });
  }

  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    return redirectWith(res, "/admin/players/bulk", { err: "No active season." });
  }

  // Look up the tier within the active season; supports any custom name.
  const tier = await prisma.tier.findFirst({ where: { seasonId: season.id, name: tierName } });
  if (!tier) {
    return redirectWith(res, "/admin/players/bulk", { err: `No tier named "${tierName}" in active season.` });
  }

  const targetDivisions = await prisma.division.findMany({
    where: { seasonId: season.id, tierId: tier.id },
    orderBy: { groupNumber: "asc" },
    include: { _count: { select: { members: true } } },
  });
  if (targetDivisions.length === 0) {
    return redirectWith(res, "/admin/players/bulk", { err: `No divisions in tier "${tierName}".` });
  }

  // Unassigned players: those with no DivisionMember in the active season.
  const unassigned = await prisma.player.findMany({
    where: {
      ...(source === "fake" ? { discordId: { startsWith: MOCK_PREFIX } } : {}),
      ...(source === "real" ? { discordId: { not: { startsWith: MOCK_PREFIX } } } : {}),
      memberships: { none: { division: { seasonId: season.id } } },
    },
  });

  if (unassigned.length === 0) {
    return redirectWith(res, "/admin/players/bulk", { ok: "No unassigned players to distribute." });
  }

  // Fill open seats first; cycle through divisions least-full to most-full.
  let cursor = 0;
  const cap = season.targetGroupSize;
  const capacities = targetDivisions.map((d) => cap - d._count.members);
  let placed = 0;
  let skippedFull = 0;

  for (const player of unassigned) {
    // find next division with open seat
    let attempts = 0;
    while (attempts < targetDivisions.length && capacities[cursor % targetDivisions.length]! <= 0) {
      cursor++;
      attempts++;
    }
    const idx = cursor % targetDivisions.length;
    if ((capacities[idx] ?? 0) <= 0) {
      skippedFull++;
      continue;
    }
    await prisma.divisionMember.create({
      data: { divisionId: targetDivisions[idx]!.id, playerId: player.id },
    });
    capacities[idx] = (capacities[idx] ?? 0) - 1;
    placed++;
    cursor++;
  }

  const msg = `Placed ${placed} player(s) across ${targetDivisions.length} ${tierName} division(s). ${skippedFull ? `${skippedFull} couldn't fit (full).` : ""}`;
  redirectWith(res, "/admin/players", { ok: msg });
});

router.post("/players/add-fake", async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const divisionName = String(req.body.divisionName ?? "").trim();
  if (!name) return redirectWith(res, "/admin/players", { err: "Name is required." });

  const discordId = `${MOCK_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const player = await prisma.player.create({ data: { discordId, displayName: name } });

  if (divisionName) {
    const season = await prisma.season.findFirst({ where: { isActive: true } });
    if (season) {
      const div = await prisma.division.findFirst({ where: { seasonId: season.id, name: divisionName } });
      if (div) {
        const count = await prisma.divisionMember.count({ where: { divisionId: div.id } });
        if (count >= season.targetGroupSize) {
          return redirectWith(res, "/admin/players", { err: `${divisionName} is full (${season.targetGroupSize}) — added ${name} as unassigned.` });
        }
        await prisma.divisionMember.create({ data: { divisionId: div.id, playerId: player.id } });
      }
    }
  }
  redirectWith(res, "/admin/players", { ok: `Added ${name}.` });
});

router.post("/players/:id/move", async (req, res) => {
  const playerId = req.params.id!;
  const divisionName = String(req.body.divisionName ?? "").trim();
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) return redirectWith(res, "/admin/players", { err: "No active season." });

  await prisma.divisionMember.deleteMany({
    where: { playerId, division: { seasonId: season.id } },
  });

  if (divisionName) {
    const div = await prisma.division.findFirst({ where: { seasonId: season.id, name: divisionName } });
    if (!div) return redirectWith(res, "/admin/players", { err: `No division ${divisionName}.` });
    const count = await prisma.divisionMember.count({ where: { divisionId: div.id } });
    if (count >= season.targetGroupSize) {
      return redirectWith(res, "/admin/players", { err: `${divisionName} is full (${season.targetGroupSize}).` });
    }
    await prisma.divisionMember.create({ data: { divisionId: div.id, playerId } });
  }
  redirectWith(res, "/admin/players", { ok: divisionName ? `Moved to ${divisionName}.` : "Removed from season." });
});

router.post("/players/:id/delete", async (req, res) => {
  const id = req.params.id!;
  // Drop pairings involving this player first (no cascade configured).
  await prisma.pairing.deleteMany({
    where: { OR: [{ playerAId: id }, { playerBId: id }] },
  });
  await prisma.player.delete({ where: { id } });
  redirectWith(res, "/admin/players", { ok: "Player deleted." });
});

// Mark a player's active-season membership as DROPPED (keeps their played pairings, voids unplayed).
router.post("/players/:id/drop", async (req, res) => {
  const playerId = req.params.id!;
  const reason = String(req.body.reason ?? "").trim() || null;
  const voidUnplayed = req.body.voidUnplayed === "yes";

  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) return redirectWith(res, "/admin/players", { err: "No active season." });

  const membership = await prisma.divisionMember.findFirst({
    where: { playerId, division: { seasonId: season.id }, status: "ACTIVE" },
  });
  if (!membership) return redirectWith(res, "/admin/players", { err: "Player isn't active in this season." });

  await prisma.divisionMember.update({
    where: { id: membership.id },
    data: { status: "DROPPED", droppedAt: new Date(), dropoutReason: reason },
  });

  if (voidUnplayed) {
    await prisma.pairing.deleteMany({
      where: {
        divisionId: membership.divisionId,
        status: "PENDING",
        OR: [{ playerAId: playerId }, { playerBId: playerId }],
      },
    });
  }

  redirectWith(res, "/admin/players", { ok: "Player dropped from season." });
});

// Reinstate a dropped player (sets status back to ACTIVE).
router.post("/players/:id/reinstate", async (req, res) => {
  const playerId = req.params.id!;
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) return redirectWith(res, "/admin/players", { err: "No active season." });

  const membership = await prisma.divisionMember.findFirst({
    where: { playerId, division: { seasonId: season.id }, status: "DROPPED" },
  });
  if (!membership) return redirectWith(res, "/admin/players", { err: "Player isn't dropped this season." });

  await prisma.divisionMember.update({
    where: { id: membership.id },
    data: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
  });
  redirectWith(res, "/admin/players", { ok: "Player reinstated." });
});

// =============================================================================
// Rankings (player ratings — used by auto-seed-by-rating)
// =============================================================================

router.get("/rankings", async (req, res) => {
  const players = await prisma.player.findMany({
    include: {
      memberships: {
        where: { division: { season: { isActive: true } } },
        include: { division: { include: { tier: true } } },
      },
    },
    orderBy: [{ rating: { sort: "desc", nulls: "last" } }, { displayName: "asc" }],
  });

  const rows = players.map((p) => {
    const isFake = isMockPlayer(p);
    const currentDiv = p.memberships[0]?.division;
    return html`<tr>
      <td><strong>${p.displayName}</strong> ${isFake ? raw('<span class="pill fake">FAKE</span>') : raw("")}</td>
      <td><span class="muted">${p.discordId}</span></td>
      <td>${currentDiv ? html`${pillForTier(currentDiv.tier.position, currentDiv.tier.name)} ${currentDiv.name}` : raw('<span class="muted">—</span>')}</td>
      <td>
        <form method="post" action="/admin/rankings/${p.id}/set" style="display:flex; gap:6px">
          <input type="number" name="rating" value="${p.rating ?? ""}" placeholder="unrated" style="width:90px" />
          <input type="text" name="ratingNote" value="${p.ratingNote ?? ""}" placeholder="note (optional)" style="width:240px" />
          <button type="submit">Save</button>
        </form>
      </td>
    </tr>`;
  });

  const body = html`
    <h2>Rankings</h2>
    <p class="muted">Set a rating per player (higher = better). Used by <strong>Auto-seed by rating</strong> to place top players in top divisions.</p>

    <div class="card">
      <strong>Bulk paste ratings</strong>
      <p class="muted">One per line: <code>discord_id,rating[,note]</code> or <code>display_name,rating[,note]</code> (uses exact display-name match).</p>
      <form method="post" action="/admin/rankings/bulk">
        <label style="flex:1 1 100%">
          <textarea name="lines" rows="6" style="width:100%; font-family:ui-monospace, monospace; background:var(--surface-2); border:1px solid var(--border); color:var(--text); padding:8px; border-radius:4px" placeholder="Alice,540,Glass tier
Bob,210
111111111111111111,720,Polychrome"></textarea>
        </label>
        <button type="submit">Apply</button>
      </form>
    </div>

    <div class="card">
      <strong>All players (${players.length})</strong>
      <table>
        <thead><tr><th>Player</th><th>Discord ID</th><th>Current division</th><th>Rating (note)</th></tr></thead>
        <tbody>${rows.length ? rows : html`<tr><td colspan="4" class="muted">No players yet.</td></tr>`}</tbody>
      </table>
    </div>
  `;
  send(res, layout({ title: "Rankings", activePath: "/admin/rankings", flash: readFlash(req), body, ...(await sessionContext(req)) }));
});

router.post("/rankings/:id/set", async (req, res) => {
  const id = req.params.id!;
  const ratingStr = String(req.body.rating ?? "").trim();
  const note = String(req.body.ratingNote ?? "").trim() || null;
  const rating = ratingStr === "" ? null : parseInt(ratingStr, 10);
  if (rating !== null && Number.isNaN(rating)) {
    return redirectWith(res, "/admin/rankings", { err: "Rating must be a number." });
  }
  await prisma.player.update({ where: { id }, data: { rating, ratingNote: note } });
  redirectWith(res, "/admin/rankings", { ok: "Rating saved." });
});

router.post("/rankings/bulk", async (req, res) => {
  const lines = String(req.body.lines ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  let updated = 0;
  const errors: string[] = [];
  for (const line of lines) {
    const parts = line.split(",").map((p) => p.trim());
    const id = parts[0] ?? "";
    const ratingStr = parts[1] ?? "";
    const note = parts.slice(2).join(",").trim() || null;
    const rating = parseInt(ratingStr, 10);
    if (Number.isNaN(rating)) {
      errors.push(`"${line}": rating not a number`);
      continue;
    }
    // Try by discord ID first, fall back to display name
    const player = /^\d{17,20}$/.test(id)
      ? await prisma.player.findUnique({ where: { discordId: id } })
      : await prisma.player.findFirst({ where: { displayName: id } });
    if (!player) {
      errors.push(`"${line}": no matching player`);
      continue;
    }
    await prisma.player.update({ where: { id: player.id }, data: { rating, ratingNote: note } });
    updated++;
  }
  const msg = `Updated ${updated} player(s)${errors.length ? `. ${errors.length} issue(s): ${errors.slice(0, 3).join("; ")}` : "."}`;
  redirectWith(res, "/admin/rankings", errors.length ? { err: msg } : { ok: msg });
});

// Auto-seed-by-rating: takes all unassigned players (or all players if mode=reseed),
// sorts by rating desc, pours top-down into divisions (best → Legendary first).
router.post("/players/auto-seed-by-rating", async (req, res) => {
  const mode = String(req.body.mode ?? "unassigned");
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) return redirectWith(res, "/admin/players/bulk", { err: "No active season." });

  // Order divisions top-down by tier position (1 = top), then by groupNumber within each tier.
  const orderedDivs = await prisma.division.findMany({
    where: { seasonId: season.id },
    orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
  });
  if (orderedDivs.length === 0) {
    return redirectWith(res, "/admin/players/bulk", { err: "No divisions to seed." });
  }

  if (mode === "reseed") {
    // Clear all current memberships (no confirmed-pairing protection — admin opted in)
    await prisma.divisionMember.deleteMany({ where: { division: { seasonId: season.id } } });
  }

  const eligible = await prisma.player.findMany({
    where:
      mode === "reseed"
        ? {} // everyone
        : { memberships: { none: { division: { seasonId: season.id } } } },
    orderBy: [{ rating: { sort: "desc", nulls: "last" } }, { displayName: "asc" }],
  });

  let placed = 0;
  let cursor = 0;
  // Pour: fill division 0 to targetGroupSize, then division 1, etc.
  for (const player of eligible) {
    while (cursor < orderedDivs.length) {
      const div = orderedDivs[cursor]!;
      const count = await prisma.divisionMember.count({ where: { divisionId: div.id } });
      if (count >= season.targetGroupSize) {
        cursor++;
        continue;
      }
      await prisma.divisionMember.create({ data: { divisionId: div.id, playerId: player.id } });
      placed++;
      break;
    }
    if (cursor >= orderedDivs.length) break;
  }

  const overflow = eligible.length - placed;
  const msg = `Placed ${placed} player(s) by rating${overflow > 0 ? `, ${overflow} couldn't fit (no open seats).` : "."}`;
  redirectWith(res, "/admin/players", { ok: msg });
});

router.post("/players/clear-fakes", async (_req, res) => {
  const count = await clearMockData();
  redirectWith(res, "/admin", { ok: `Cleared ${count} fake player(s).` });
});

// =============================================================================
// Divisions
// =============================================================================

router.get("/divisions", async (req, res) => {
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    const body = html`<h2>Divisions</h2><div class="card muted">No active season — create one on <a href="/admin/seasons">Seasons</a> first.</div>`;
    return send(res, layout({ title: "Divisions", activePath: "/admin/divisions", flash: readFlash(req), body, ...(await sessionContext(req)) }));
  }

  // Load tiers in top→bottom order with their divisions nested.
  const tiers = await prisma.tier.findMany({
    where: { seasonId: season.id },
    orderBy: { position: "asc" },
    include: {
      divisions: {
        orderBy: { groupNumber: "asc" },
        include: {
          _count: { select: { members: true, pairings: true } },
          pairings: { where: { status: "CONFIRMED" }, select: { id: true } },
        },
      },
    },
  });

  // Expected pairings for a full round-robin: n choose 2
  function expectedPairings(memberCount: number): number {
    return memberCount < 2 ? 0 : (memberCount * (memberCount - 1)) / 2;
  }

  const sections = tiers
    .filter((t) => t.divisions.length > 0)
    .map((tier) => {
      const cards = tier.divisions.map((d) => {
        const expected = expectedPairings(d._count.members);
        const confirmed = d.pairings.length;
        const pct = expected === 0 ? 0 : Math.round((confirmed / expected) * 100);
        return html`<a href="/admin/divisions/${d.id}" class="division-card">
          <strong>${d.name}</strong>
          ${pillForTier(tier.position, tier.name)}
          <div class="muted" style="margin-top:8px">${d._count.members}/${season.targetGroupSize} players · ${confirmed}/${expected} sets</div>
          <div class="progress"><div style="width:${pct}%"></div></div>
        </a>`;
      });
      return html`<h3 style="margin-top:24px">${tier.name} (${tier.divisions.length})</h3>
        <div class="grid grid-3">${cards}</div>`;
    });

  const body = html`
    <h2>Divisions <span class="muted" style="font-weight:normal; font-size:14px">· ${season.name}</span></h2>
    ${sections.length ? sections : html`<div class="muted">No divisions in this season.</div>`}
  `;
  send(res, layout({ title: "Divisions", activePath: "/admin/divisions", flash: readFlash(req), body, ...(await sessionContext(req)) }));
});

router.get("/divisions/:id", async (req, res) => {
  const id = req.params.id!;
  const division = await prisma.division.findUnique({
    where: { id },
    include: {
      season: true,
      tier: true,
      members: { include: { player: true }, orderBy: { joinedAt: "asc" } },
      pairings: {
        include: { playerA: true, playerB: true },
        orderBy: [{ status: "asc" }, { reportedAt: "desc" }],
      },
    },
  });
  if (!division) {
    return redirectWith(res, "/admin/divisions", { err: "Division not found." });
  }

  // Standings
  const droppedIds = new Set(division.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId));
  const confirmedPairings = division.pairings.filter((p) => p.status === "CONFIRMED");
  const rows = computeStandings(
    division.members.map((m) => m.player),
    confirmedPairings.map((p) => ({
      playerAId: p.playerAId,
      playerBId: p.playerBId,
      gamesWonA: p.gamesWonA,
      gamesWonB: p.gamesWonB,
    })),
  ).map((r) => ({ ...r, dropped: droppedIds.has(r.player.id) }));

  // Player picker for add-member form: players not currently in this season at all
  const candidates = await prisma.player.findMany({
    where: {
      memberships: { none: { division: { seasonId: division.season.id } } },
    },
    orderBy: { displayName: "asc" },
  });

  // All members in this season for the per-pairing player picker on "add a result"
  const allSeasonPlayers = await prisma.player.findMany({
    where: { memberships: { some: { division: { seasonId: division.season.id } } } },
    orderBy: { displayName: "asc" },
  });

  // Generate unplayed matchups: pairs of active members with no Pairing row yet
  const activeMembers = division.members.filter((m) => m.status === "ACTIVE");
  const playedKey = (a: string, b: string) => {
    const [x, y] = a < b ? [a, b] : [b, a];
    return `${x}-${y}`;
  };
  const playedSet = new Set(division.pairings.map((p) => playedKey(p.playerAId, p.playerBId)));
  const unplayed: Array<{ a: typeof activeMembers[number]["player"]; b: typeof activeMembers[number]["player"] }> = [];
  for (let i = 0; i < activeMembers.length; i++) {
    for (let j = i + 1; j < activeMembers.length; j++) {
      const a = activeMembers[i]!.player;
      const b = activeMembers[j]!.player;
      if (!playedSet.has(playedKey(a.id, b.id))) unplayed.push({ a, b });
    }
  }

  const membersTable = division.members.map((m) => {
    const isDropped = m.status === "DROPPED";
    const isFake = m.player.discordId.startsWith(MOCK_PREFIX);
    return html`<tr>
      <td>
        <strong>${m.player.displayName}</strong>
        ${isFake ? raw(' <span class="pill fake">FAKE</span>') : raw(' <span class="pill real">REAL</span>')}
        ${isDropped ? raw(' <span class="pill" style="background:rgba(231,76,60,0.2); color:#e74c3c">DROPPED</span>') : raw("")}
      </td>
      <td><span class="muted">${m.player.discordId}</span></td>
      <td>${m.joinedAt.toISOString().slice(0, 10)}</td>
      <td style="display:flex; gap:6px">
        ${isDropped
          ? html`<form method="post" action="/admin/players/${m.player.id}/reinstate"><button class="secondary" type="submit">Reinstate</button></form>`
          : html`<form method="post" action="/admin/players/${m.player.id}/drop" onsubmit="return confirm('Drop ${m.player.displayName}? Played sets stay.')"><input type="hidden" name="voidUnplayed" value="yes" /><button class="secondary" type="submit">Drop</button></form>`}
        <form method="post" action="/admin/divisions/${division.id}/members/${m.player.id}/remove" onsubmit="return confirm('Remove ${m.player.displayName} from this division entirely?')">
          <button class="danger" type="submit">Remove</button>
        </form>
      </td>
    </tr>`;
  });

  const pairingRows = division.pairings.map((p) => {
    const statusClass = p.status.toLowerCase();
    const aIsDropped = droppedIds.has(p.playerAId);
    const bIsDropped = droppedIds.has(p.playerBId);
    const aName = aIsDropped ? html`<s>${p.playerA.displayName}</s>` : p.playerA.displayName;
    const bName = bIsDropped ? html`<s>${p.playerB.displayName}</s>` : p.playerB.displayName;
    return html`<tr>
      <td>${aName} <span class="muted">vs</span> ${bName}</td>
      <td><strong>${p.gamesWonA}-${p.gamesWonB}</strong></td>
      <td><span class="pill ${statusClass}">${p.status}</span></td>
      <td>
        <form method="post" action="/admin/pairings/${p.id}/override" style="display:flex; gap:4px">
          <select name="result">
            <option value="2-0" ${p.gamesWonA === 2 && p.gamesWonB === 0 ? "selected" : ""}>${p.playerA.displayName} 2-0</option>
            <option value="1-1" ${p.gamesWonA === 1 ? "selected" : ""}>1-1 draw</option>
            <option value="0-2" ${p.gamesWonA === 0 && p.gamesWonB === 2 ? "selected" : ""}>${p.playerB.displayName} 2-0</option>
          </select>
          <button type="submit">Override</button>
        </form>
      </td>
      <td>
        <form method="post" action="/admin/pairings/${p.id}/delete" onsubmit="return confirm('Delete this set? It will need to be re-reported.')">
          <button class="danger" type="submit">Delete</button>
        </form>
      </td>
    </tr>`;
  });

  const unplayedRows = unplayed.map(({ a, b }) => html`<tr>
    <td>${a.displayName} <span class="muted">vs</span> ${b.displayName}</td>
    <td>
      <form method="post" action="/admin/divisions/${division.id}/pairings/record" style="display:flex; gap:4px">
        <input type="hidden" name="playerAId" value="${a.id}" />
        <input type="hidden" name="playerBId" value="${b.id}" />
        <select name="result">
          <option value="">— pick result —</option>
          <option value="2-0">${a.displayName} 2-0</option>
          <option value="1-1">1-1 draw</option>
          <option value="0-2">${b.displayName} 2-0</option>
        </select>
        <button type="submit">Record</button>
      </form>
    </td>
  </tr>`);

  const standingsRows = rows.length
    ? rows.map((r, i) => {
        const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
        return html`<tr>
          <td>${medal}</td>
          <td>${r.dropped ? html`<s>${r.player.displayName}</s> <span class="muted">(dropped)</span>` : r.player.displayName}</td>
          <td><strong>${r.points}</strong></td>
          <td>${r.wins}-${r.draws}-${r.losses}</td>
          <td>${r.gamesWon}-${r.gamesLost}</td>
          <td>${r.played}</td>
        </tr>`;
      })
    : [html`<tr><td colspan="6" class="muted">No confirmed sets yet.</td></tr>`];

  const body = html`
    <div style="display:flex; align-items:baseline; gap:12px; margin-bottom:8px">
      <h2 style="margin:0">${division.name}</h2>
      ${pillForTier(division.tier.position, division.tier.name)}
      <span class="muted">· ${division.season.name}</span>
      <a href="/admin/divisions" style="margin-left:auto">← All divisions</a>
    </div>
    <div class="muted" style="margin-bottom:16px">Format: Round-robin best-of-2 · 3 pts for a 2-0 win, 1 pt each for 1-1, 0 for 0-2</div>

    <div class="card">
      <strong>Standings (${rows.length})</strong>
      <table>
        <thead><tr><th></th><th>Player</th><th>Pts</th><th>W-D-L</th><th>Games</th><th>Played</th></tr></thead>
        <tbody>${standingsRows}</tbody>
      </table>
    </div>

    <div class="card">
      <div style="display:flex; align-items:center; gap:8px">
        <strong>Members (${division.members.length}/${division.season.targetGroupSize})</strong>
      </div>
      <table>
        <thead><tr><th>Player</th><th>Discord ID</th><th>Joined</th><th>Actions</th></tr></thead>
        <tbody>${membersTable.length ? membersTable : html`<tr><td colspan="4" class="muted">No members.</td></tr>`}</tbody>
      </table>
      ${division.members.length < division.season.targetGroupSize
        ? html`<form method="post" action="/admin/divisions/${division.id}/members/add" style="margin-top:12px">
            <label>Add player
              <select name="playerId">
                <option value="">— pick a player not in this season —</option>
                ${candidates.map((c) => html`<option value="${c.id}">${c.displayName}</option>`)}
              </select>
            </label>
            <button type="submit">Add</button>
          </form>`
        : raw('<p class="muted">Division is at capacity.</p>')}
      ${void allSeasonPlayers}
    </div>

    <div class="card">
      <strong>Sets — recorded (${division.pairings.length})</strong>
      <table>
        <thead><tr><th>Matchup</th><th>Result</th><th>Status</th><th>Override</th><th></th></tr></thead>
        <tbody>${pairingRows.length ? pairingRows : html`<tr><td colspan="5" class="muted">None yet.</td></tr>`}</tbody>
      </table>
    </div>

    <div class="card">
      <strong>Sets — unplayed (${unplayed.length})</strong>
      <table>
        <thead><tr><th>Matchup</th><th>Record</th></tr></thead>
        <tbody>${unplayedRows.length ? unplayedRows : html`<tr><td colspan="2" class="muted">All round-robin sets recorded.</td></tr>`}</tbody>
      </table>
      ${unplayed.length > 0
        ? html`<form method="post" action="/admin/divisions/${division.id}/simulate" style="margin-top:12px" onsubmit="return confirm('Auto-play all ${unplayed.length} unplayed set(s) with random results?')">
            <button class="secondary" type="submit">Simulate all unplayed</button>
          </form>`
        : raw("")}
    </div>
  `;
  send(res, layout({ title: division.name, activePath: "/admin/divisions", flash: readFlash(req), body, ...(await sessionContext(req)) }));
});

// --- division actions ---

router.post("/divisions/:id/members/add", async (req, res) => {
  const divisionId = req.params.id!;
  const playerId = String(req.body.playerId ?? "").trim();
  if (!playerId) return redirectWith(res, `/admin/divisions/${divisionId}`, { err: "Pick a player." });

  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    include: { _count: { select: { members: true } }, season: { select: { targetGroupSize: true } } },
  });
  if (!division) return redirectWith(res, "/admin/divisions", { err: "Division gone." });
  if (division._count.members >= division.season.targetGroupSize) {
    return redirectWith(res, `/admin/divisions/${divisionId}`, { err: `Division is full (${division.season.targetGroupSize}).` });
  }

  // Player must not already be in any division this season
  const existing = await prisma.divisionMember.findFirst({
    where: { playerId, division: { seasonId: division.seasonId } },
  });
  if (existing) {
    return redirectWith(res, `/admin/divisions/${divisionId}`, { err: "Player is already in this season." });
  }

  await prisma.divisionMember.create({ data: { divisionId, playerId } });
  redirectWith(res, `/admin/divisions/${divisionId}`, { ok: "Player added." });
});

router.post("/divisions/:id/members/:playerId/remove", async (req, res) => {
  const divisionId = req.params.id!;
  const playerId = req.params.playerId!;
  const member = await prisma.divisionMember.findFirst({ where: { divisionId, playerId } });
  if (!member) return redirectWith(res, `/admin/divisions/${divisionId}`, { err: "Member not found." });

  const pairingCount = await prisma.pairing.count({
    where: {
      divisionId,
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
  });
  if (pairingCount > 0) {
    return redirectWith(res, `/admin/divisions/${divisionId}`, {
      err: `Player has ${pairingCount} set(s) here. Drop them instead so results stay intact.`,
    });
  }
  await prisma.divisionMember.delete({ where: { id: member.id } });
  redirectWith(res, `/admin/divisions/${divisionId}`, { ok: "Member removed." });
});

router.post("/divisions/:id/pairings/record", async (req, res) => {
  const divisionId = req.params.id!;
  const playerAId = String(req.body.playerAId ?? "").trim();
  const playerBId = String(req.body.playerBId ?? "").trim();
  const result = String(req.body.result ?? "").trim();
  if (!playerAId || !playerBId || !result) {
    return redirectWith(res, `/admin/divisions/${divisionId}`, { err: "Missing fields." });
  }
  const parsed = parsePairingResult(result);
  if (!parsed) return redirectWith(res, `/admin/divisions/${divisionId}`, { err: "Bad result." });

  // canonical ordering
  const [canonA, canonB] = playerAId < playerBId ? [playerAId, playerBId] : [playerBId, playerAId];
  const reporterIsA = playerAId === canonA;
  const games = gamesFromResult(parsed);
  const gamesWonA = reporterIsA ? games.a : games.b;
  const gamesWonB = reporterIsA ? games.b : games.a;

  const recorded = await prisma.pairing.upsert({
    where: { divisionId_playerAId_playerBId: { divisionId, playerAId: canonA, playerBId: canonB } },
    create: {
      divisionId,
      playerAId: canonA,
      playerBId: canonB,
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      reportedAt: new Date(),
      confirmedAt: new Date(),
      adminOverrideBy: "admin-dashboard",
      adminOverrideReason: "recorded via dashboard",
    },
    update: {
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: "admin-dashboard",
      adminOverrideReason: "recorded via dashboard (overwrite)",
    },
  });
  announceResult(recorded.id).catch(() => {});
  redirectWith(res, `/admin/divisions/${divisionId}`, { ok: "Result recorded." });
});

router.post("/divisions/:id/simulate", async (req, res) => {
  const divisionId = req.params.id!;
  const rand = makeRng(Date.now());
  const played = await simulateDivisionPairings(divisionId, rand);
  redirectWith(res, `/admin/divisions/${divisionId}`, { ok: `Played ${played} new set(s).` });
});

router.post("/pairings/:id/override", async (req, res) => {
  const pairingId = req.params.id!;
  const result = String(req.body.result ?? "").trim();
  const parsed = parsePairingResult(result);
  if (!parsed) {
    const p = await prisma.pairing.findUnique({ where: { id: pairingId } });
    return redirectWith(res, p ? `/admin/divisions/${p.divisionId}` : "/admin/divisions", { err: "Bad result." });
  }
  const games = gamesFromResult(parsed);
  const updated = await prisma.pairing.update({
    where: { id: pairingId },
    data: {
      gamesWonA: games.a,
      gamesWonB: games.b,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: "admin-dashboard",
      adminOverrideReason: "override via dashboard",
    },
  });
  announceResult(updated.id).catch(() => {});
  redirectWith(res, `/admin/divisions/${updated.divisionId}`, { ok: "Set overridden." });
});

router.post("/pairings/:id/delete", async (req, res) => {
  const pairingId = req.params.id!;
  const p = await prisma.pairing.findUnique({ where: { id: pairingId } });
  if (!p) return redirectWith(res, "/admin/divisions", { err: "Gone." });
  await prisma.pairing.delete({ where: { id: pairingId } });
  redirectWith(res, `/admin/divisions/${p.divisionId}`, { ok: "Set deleted." });
});

// =============================================================================
// Signups
// =============================================================================

router.get("/signups", async (req, res) => {
  const rounds = await prisma.signupRound.findMany({
    include: {
      signups: { orderBy: { signedUpAt: "asc" } },
      _count: { select: { signups: true } },
    },
    orderBy: [{ status: "asc" }, { openedAt: "desc" }],
  });

  const cards = rounds.map((round) => {
    const active = round.signups.filter((s) => !s.withdrawn);
    const withdrawn = round.signups.filter((s) => s.withdrawn);
    const statusPill =
      round.status === "OPEN"
        ? raw('<span class="pill" style="background:rgba(46,204,113,0.2); color:#2ecc71">OPEN</span>')
        : round.status === "CLOSED"
          ? raw('<span class="pill" style="background:rgba(241,196,15,0.2); color:#f1c40f">CLOSED</span>')
          : raw('<span class="pill" style="background:rgba(149,165,166,0.2); color:#c0c8cb">BUILT</span>');

    const rows = active.length
      ? active.map(
          (s) => html`<tr>
            <td><strong>${s.displayName}</strong> <span class="muted">${s.discordId}</span></td>
            <td>${s.signedUpAt.toISOString().slice(0, 16).replace("T", " ")} UTC</td>
          </tr>`,
        )
      : [html`<tr><td colspan="2" class="muted">No active signups in this round.</td></tr>`];

    return html`<div class="card">
      <div style="display:flex; align-items:center; gap:8px">
        <strong style="font-size:16px">${round.name}</strong>
        ${statusPill}
        <span style="margin-left:auto" class="muted">
          ${active.length} active · ${withdrawn.length} withdrawn
        </span>
      </div>
      <div class="muted" style="margin-top:4px">
        Round id: <code>${round.id}</code>
        ${round.status === "OPEN" ? raw("") : html` · closed ${round.closedAt?.toISOString().slice(0, 16).replace("T", " ") ?? "?"} UTC`}
      </div>
      <table style="margin-top:12px">
        <thead><tr><th>Player</th><th>Signed up</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${round.status === "OPEN"
        ? html`<form method="post" action="/admin/signups/${round.id}/close" style="margin-top:8px">
            <button class="secondary" type="submit">Finalize signups</button>
          </form>`
        : raw("")}
    </div>`;
  });

  const body = html`
    <h2>Signups</h2>
    <p class="muted">Signup rounds let players opt in for an upcoming season. Use the Discord command <code>/league post-signup</code> to open one.</p>
    ${cards.length ? cards : html`<div class="card muted">No signup rounds yet. Run <code>/league post-signup name:"Season 2 Signups"</code> in your league's Discord.</div>`}
  `;
  send(res, layout({ title: "Signups", activePath: "/admin/signups", flash: readFlash(req), body, ...(await sessionContext(req)) }));
});

router.post("/signups/:id/close", async (req, res) => {
  const id = req.params.id!;
  const round = await prisma.signupRound.findUnique({ where: { id } });
  if (!round) return redirectWith(res, "/admin/signups", { err: "Round not found." });
  if (round.status !== "OPEN") return redirectWith(res, "/admin/signups", { err: `Already ${round.status.toLowerCase()}.` });
  await prisma.signupRound.update({
    where: { id },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  redirectWith(res, "/admin/signups", { ok: `Closed ${round.name}.` });
});

// =============================================================================
// Seasons
// =============================================================================

router.get("/seasons", async (req, res) => {
  const seasons = await prisma.season.findMany({
    include: {
      _count: { select: { divisions: true } },
      tiers: {
        orderBy: { position: "asc" },
        include: {
          divisions: {
            include: { _count: { select: { members: true, pairings: true } } },
          },
        },
      },
    },
    orderBy: [{ isActive: "desc" }, { startedAt: "desc" }],
  });

  const seasonCards = seasons.map((s) => {
    // Pyramid summary lists each tier (in position order) with its division count.
    const pyramidLine = s.tiers.map((t) => `${t.name}: ${t.divisions.length}`).join(" · ") || "(no tiers)";
    const players = s.tiers.reduce(
      (sum, t) => sum + t.divisions.reduce((s2, d) => s2 + d._count.members, 0),
      0,
    );
    const pairings = s.tiers.reduce(
      (sum, t) => sum + t.divisions.reduce((s2, d) => s2 + d._count.pairings, 0),
      0,
    );

    return html`<div class="card">
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
        <strong style="font-size:16px">${s.name}</strong>
        ${s.isActive ? raw('<span class="pill" style="background:rgba(46,204,113,0.2); color:#2ecc71">ACTIVE</span>') : raw('<span class="pill" style="background:rgba(149,165,166,0.2); color:#c0c8cb">Inactive</span>')}
        ${s.visibility === "INTERNAL"
          ? raw('<span class="pill" style="background:rgba(241,196,15,0.2); color:#f1c40f">INTERNAL — admin only</span>')
          : raw('<span class="pill" style="background:rgba(52,152,219,0.2); color:#76c7ff">PUBLIC</span>')}
        ${s.deadline ? html`<span class="muted" style="margin-left:auto">Deadline: ${s.deadline.toISOString().slice(0, 16).replace("T", " ")} UTC</span>` : raw("")}
      </div>
      <div class="muted" style="margin-top:4px">${pyramidLine}</div>
      <div class="muted">${players} player(s) · ${pairings} set(s) · group size ${s.targetGroupSize} (min ${s.minGroupSize})</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px">
        ${!s.isActive ? html`<form method="post" action="/admin/seasons/${s.id}/activate" onsubmit="return confirm('Activate this season? If another is currently active, it will be demoted to inactive.')"><button class="secondary" type="submit">Activate</button></form>` : raw("")}
        <a href="/admin/seasons/${s.id}/export/standings.csv" download><button class="secondary" type="button">Standings CSV</button></a>
        <a href="/admin/seasons/${s.id}/export/pairings.csv" download><button class="secondary" type="button">Sets CSV</button></a>
      </div>
    </div>`;
  });

  const templates = await listTemplates();
  const initialTiers = await preferredDefault();
  // Embed all templates as JSON for the client-side switcher
  const templatesJson = JSON.stringify(
    templates.map((t) => ({ id: t.id, name: t.name, config: t.config })),
  );

  const tierRowsHtml = initialTiers.map(
    (t, i) => html`<div class="tier-row" data-row-index="${i}">
      <span class="tier-pos">${i + 1}.</span>
      <input type="text" name="tier_name[]" value="${t.name}" placeholder="Tier name" required />
      <input type="number" name="tier_count[]" value="${t.divisionCount}" min="1" max="50" required />
      <button type="button" class="secondary tier-up" title="Move up">▲</button>
      <button type="button" class="secondary tier-down" title="Move down">▼</button>
      <button type="button" class="danger tier-remove" title="Remove">✕</button>
    </div>`,
  );

  const templateOptions = templates.map(
    (t) => html`<option value="${t.id}">${t.isLastUsed ? "★ " : ""}${t.name}</option>`,
  );

  const editorStyles = raw(`
    .tier-row { display: flex; gap: 8px; align-items: center; padding: 6px 8px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; margin-bottom: 6px; }
    .tier-row .tier-pos { color: var(--muted); width: 22px; font-variant-numeric: tabular-nums; }
    .tier-row input[type="text"] { flex: 1 1 auto; }
    .tier-row input[type="number"] { width: 80px; }
    .tier-row button { padding: 4px 8px; font-size: 12px; }
  `);

  const editorScript = raw(`
    (function() {
      const TEMPLATES = ${templatesJson};
      const list = document.getElementById('tier-list');
      const tpl = document.getElementById('tier-row-template');

      function renderRows(configs) {
        list.innerHTML = '';
        configs.forEach((c, i) => addRow(c.name, c.divisionCount, i));
        renumber();
      }
      function addRow(name, count, idx) {
        const node = tpl.content.firstElementChild.cloneNode(true);
        node.querySelector('input[name="tier_name[]"]').value = name || '';
        node.querySelector('input[name="tier_count[]"]').value = count || 1;
        node.dataset.rowIndex = idx;
        list.appendChild(node);
      }
      function renumber() {
        Array.from(list.children).forEach((row, i) => {
          row.dataset.rowIndex = i;
          row.querySelector('.tier-pos').textContent = (i + 1) + '.';
        });
      }
      list.addEventListener('click', (e) => {
        const row = e.target.closest('.tier-row');
        if (!row) return;
        if (e.target.classList.contains('tier-remove')) {
          if (list.children.length > 1) row.remove();
          renumber();
        } else if (e.target.classList.contains('tier-up')) {
          if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
          renumber();
        } else if (e.target.classList.contains('tier-down')) {
          if (row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
          renumber();
        }
      });
      document.getElementById('add-tier').addEventListener('click', () => {
        addRow('', 1, list.children.length);
        renumber();
      });
      document.getElementById('load-template').addEventListener('change', (e) => {
        const id = e.target.value;
        if (!id) return;
        const t = TEMPLATES.find(x => x.id === id);
        if (t) renderRows(t.config);
        e.target.value = '';
      });
      document.getElementById('save-template').addEventListener('click', () => {
        const name = prompt('Save current tier layout as template. Name?');
        if (!name) return;
        const config = Array.from(list.children).map(row => ({
          name: row.querySelector('input[name="tier_name[]"]').value,
          divisionCount: parseInt(row.querySelector('input[name="tier_count[]"]').value, 10) || 1,
        }));
        const form = document.getElementById('save-template-form');
        form.querySelector('input[name="templateName"]').value = name;
        form.querySelector('input[name="config"]').value = JSON.stringify(config);
        form.submit();
      });
    })();
  `);

  const body = html`
    <h2>Seasons</h2>
    <style>${editorStyles}</style>

    <div class="card">
      <strong>Create new season</strong>
      <p class="muted">Configure tiers, then submit. Pre-filled with your last-used layout (★). Created as <strong>inactive</strong> — your current active season is untouched.</p>

      <form method="post" action="/admin/seasons/create">
        <label>Name <input name="name" required placeholder="Season 2" /></label>
        <label>Deadline (UTC) <input name="deadline" type="datetime-local" /></label>
        <label>Group size <input name="targetGroupSize" type="number" min="2" max="20" value="5" /></label>
        <label>Min group <input name="minGroupSize" type="number" min="2" max="20" value="3" /></label>
        <label>Visibility
          <select name="visibility">
            <option value="PUBLIC">PUBLIC (visible to players)</option>
            <option value="INTERNAL">INTERNAL (admin-only test)</option>
          </select>
        </label>

        <div style="flex:1 1 100%; margin-top:12px">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px">
            <strong>Tiers</strong>
            ${templates.length > 0
              ? html`<select id="load-template" style="margin-left:auto">
                  <option value="">— Load template… —</option>
                  ${templateOptions}
                </select>`
              : raw("")}
            <button type="button" class="secondary" id="save-template">💾 Save current as template</button>
            <a href="/admin/seasons/templates"><button type="button" class="secondary">Manage templates</button></a>
          </div>
          <div id="tier-list">${tierRowsHtml}</div>
          <button type="button" class="secondary" id="add-tier" style="margin-top:6px">+ Add tier</button>
          <template id="tier-row-template">
            <div class="tier-row" data-row-index="0">
              <span class="tier-pos">1.</span>
              <input type="text" name="tier_name[]" placeholder="Tier name" required />
              <input type="number" name="tier_count[]" value="1" min="1" max="50" required />
              <button type="button" class="secondary tier-up" title="Move up">▲</button>
              <button type="button" class="secondary tier-down" title="Move down">▼</button>
              <button type="button" class="danger tier-remove" title="Remove">✕</button>
            </div>
          </template>
        </div>

        <button type="submit" style="margin-top:12px">Create season</button>
      </form>

      <form id="save-template-form" method="post" action="/admin/seasons/templates/save" style="display:none">
        <input type="hidden" name="templateName" />
        <input type="hidden" name="config" />
      </form>

      <script>${editorScript}</script>
    </div>

    <div class="grid grid-2">${seasonCards.length ? seasonCards : html`<div class="muted">No seasons yet.</div>`}</div>
  `;

  send(res, layout({ title: "Seasons", activePath: "/admin/seasons", flash: readFlash(req), body, ...(await sessionContext(req)) }));
});

// Save current tier layout as a named template (triggered by JS form submit).
router.post("/seasons/templates/save", async (req, res) => {
  const name = String(req.body.templateName ?? "").trim();
  const configJson = String(req.body.config ?? "");
  if (!name) return redirectWith(res, "/admin/seasons", { err: "Template name required." });
  try {
    const parsed = JSON.parse(configJson) as TierConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return redirectWith(res, "/admin/seasons", { err: "Template must have at least one tier." });
    }
    await saveTemplate(name, parsed);
    redirectWith(res, "/admin/seasons", { ok: `Template "${name}" saved.` });
  } catch {
    redirectWith(res, "/admin/seasons", { err: "Invalid template config." });
  }
});

// Manage templates: list, edit names, delete.
router.get("/seasons/templates", async (req, res) => {
  const templates = await listTemplates();
  const rows = templates.map((t) => html`<tr>
    <td>${t.isLastUsed ? raw('<span class="pill" style="background:rgba(241,196,15,0.2); color:#f1c40f">LAST USED</span> ') : raw("")}<strong>${t.name}</strong></td>
    <td><span class="muted">${t.config.map((c) => `${c.name}×${c.divisionCount}`).join(" · ")}</span></td>
    <td>${t.updatedAt.toISOString().slice(0, 10)}</td>
    <td>
      <form method="post" action="/admin/seasons/templates/${t.id}/delete" onsubmit="return confirm('Delete template ${t.name}?')" style="display:inline">
        <button class="danger" type="submit">Delete</button>
      </form>
    </td>
  </tr>`);
  const body = html`
    <h2>Tier templates</h2>
    <p class="muted">Saved layouts for the Create Season form. The ★ Last used template is auto-updated after every season create.</p>
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Layout</th><th>Updated</th><th></th></tr></thead>
        <tbody>${rows.length ? rows : html`<tr><td colspan="4" class="muted">No templates saved yet.</td></tr>`}</tbody>
      </table>
      <p style="margin-top:12px"><a href="/admin/seasons">← Back to Seasons</a></p>
    </div>
  `;
  send(res, layout({ title: "Tier templates", activePath: "/admin/seasons", flash: readFlash(req), body, ...(await sessionContext(req)) }));
});

router.post("/seasons/templates/:id/delete", async (req, res) => {
  await deleteTemplate(req.params.id!);
  redirectWith(res, "/admin/seasons/templates", { ok: "Template deleted." });
});

router.post("/seasons/create", async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) return redirectWith(res, "/admin/seasons", { err: "Name required." });

  // Parse the structured rows. tier_name[] and tier_count[] arrive as arrays (or single strings).
  const rawNames = req.body.tier_name;
  const rawCounts = req.body.tier_count;
  const names = Array.isArray(rawNames) ? rawNames : rawNames ? [rawNames] : [];
  const counts = Array.isArray(rawCounts) ? rawCounts : rawCounts ? [rawCounts] : [];

  const tierConfigs: TierConfig[] = [];
  for (let i = 0; i < names.length; i++) {
    const tierName = String(names[i] ?? "").trim();
    const tierCount = parseInt(String(counts[i] ?? "1"), 10);
    if (!tierName || Number.isNaN(tierCount) || tierCount < 1) continue;
    tierConfigs.push({ name: tierName, divisionCount: Math.min(50, tierCount) });
  }

  // Fallback to old-style textarea (legacy compat) or default
  const fallbackConfigs = tierConfigs.length === 0
    ? parseTierConfig(String(req.body.tiers ?? ""))
    : tierConfigs;

  const totalDivisions = fallbackConfigs.reduce((sum, t) => sum + t.divisionCount, 0);
  if (totalDivisions === 0) {
    return redirectWith(res, "/admin/seasons", { err: "Need at least one tier with one division." });
  }

  let deadline: Date | null = null;
  if (req.body.deadline) {
    const d = new Date(req.body.deadline + "Z");
    if (!Number.isNaN(d.getTime())) deadline = d;
  }

  const targetGroupSize = Math.max(2, parseInt(req.body.targetGroupSize, 10) || 5);
  const minGroupSize = Math.max(2, parseInt(req.body.minGroupSize, 10) || 3);
  const visibility: "PUBLIC" | "INTERNAL" = req.body.visibility === "INTERNAL" ? "INTERNAL" : "PUBLIC";

  const season = await prisma.season.create({
    data: { name, deadline, isActive: false, targetGroupSize, minGroupSize, visibility },
  });
  await createTiersAndDivisions(season.id, fallbackConfigs);
  // Save the layout we just used as "Last used" so the form pre-fills with it next time
  await recordLastUsed(fallbackConfigs);

  redirectWith(res, "/admin/seasons", { ok: `Created ${name} (inactive, ${fallbackConfigs.length} tiers, group size ${targetGroupSize}). Use Activate when ready.` });
});

// CSV exports — one row per player (standings) or one row per pairing.
// Filename suffix uses the season name so downloads don't collide.
function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "season";
}

// Global player roster export — useful as a backup before migrating to a different DB.
router.get("/export/players.csv", async (_req, res) => {
  const players = await prisma.player.findMany({
    include: {
      memberships: {
        where: { division: { season: { isActive: true } } },
        include: { division: { include: { tier: true } } },
      },
    },
    orderBy: { displayName: "asc" },
  });

  const rows = players.map((p) => {
    const m = p.memberships[0];
    return [
      p.discordId,
      p.displayName,
      isMockPlayer(p) ? "FAKE" : "REAL",
      m?.division.name ?? "",
      m?.division.tier.name ?? "",
      m?.status ?? "",
      p.createdAt.toISOString(),
    ];
  });

  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="players.csv"`);
  res.send(
    csvDocument(
      ["discord_id", "display_name", "type", "current_division", "current_tier", "current_status", "created_at"],
      rows,
    ),
  );
});

router.get("/seasons/:id/export/standings.csv", async (req, res) => {
  const id = req.params.id!;
  const season = await prisma.season.findUnique({
    where: { id },
    include: {
      // Load tiers in top→bottom order; each tier nests its divisions ordered by groupNumber.
      tiers: {
        orderBy: { position: "asc" },
        include: {
          divisions: {
            orderBy: { groupNumber: "asc" },
            include: {
              members: { include: { player: true } },
              pairings: {
                where: { status: "CONFIRMED" },
                select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
              },
            },
          },
        },
      },
    },
  });
  if (!season) return res.status(404).send("season not found");

  const rows: unknown[][] = [];
  for (const tier of season.tiers) {
    for (const division of tier.divisions) {
      const droppedIds = new Set(division.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId));
      const standings = computeStandings(division.members.map((m) => m.player), division.pairings);
      standings.forEach((row, idx) => {
        rows.push([
          season.name,
          division.name,
          tier.name,
          idx + 1,
          row.player.displayName,
          row.player.discordId,
          row.points,
          row.wins,
          row.draws,
          row.losses,
          row.gamesWon,
          row.gamesLost,
          row.played,
          droppedIds.has(row.player.id) ? "DROPPED" : "ACTIVE",
        ]);
      });
    }
  }

  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${safeFilename(season.name)}-standings.csv"`);
  res.send(
    csvDocument(
      [
        "season", "division", "tier", "rank", "player", "discord_id",
        "points", "wins", "draws", "losses", "games_won", "games_lost", "played", "status",
      ],
      rows,
    ),
  );
});

router.get("/seasons/:id/export/pairings.csv", async (req, res) => {
  const id = req.params.id!;
  const season = await prisma.season.findUnique({
    where: { id },
    include: {
      tiers: {
        orderBy: { position: "asc" },
        include: {
          divisions: {
            orderBy: { groupNumber: "asc" },
            include: {
              pairings: {
                include: { playerA: true, playerB: true },
                orderBy: { reportedAt: "asc" },
              },
            },
          },
        },
      },
    },
  });
  if (!season) return res.status(404).send("season not found");

  const rows: unknown[][] = [];
  for (const tier of season.tiers) {
    for (const division of tier.divisions) {
      for (const p of division.pairings) {
        rows.push([
          season.name,
          division.name,
          tier.name,
          p.playerA.displayName,
          p.playerB.displayName,
          p.gamesWonA,
          p.gamesWonB,
          p.status,
          p.reportedAt?.toISOString() ?? "",
          p.confirmedAt?.toISOString() ?? "",
          p.adminOverrideBy ?? "",
          p.adminOverrideReason ?? "",
        ]);
      }
    }
  }

  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${safeFilename(season.name)}-pairings.csv"`);
  res.send(
    csvDocument(
      [
        "season", "division", "tier",
        "player_a", "player_b", "games_won_a", "games_won_b",
        "status", "reported_at", "confirmed_at",
        "admin_override_by", "admin_override_reason",
      ],
      rows,
    ),
  );
});

router.post("/seasons/:id/activate", async (req, res) => {
  const id = req.params.id!;
  const target = await prisma.season.findUnique({ where: { id } });
  if (!target) return redirectWith(res, "/admin/seasons", { err: "Season not found." });
  // Only demote a prior active season of the same visibility
  const prior = await prisma.season.findFirst({
    where: { isActive: true, visibility: target.visibility, NOT: { id } },
  });
  if (prior) {
    await prisma.season.update({ where: { id: prior.id }, data: { isActive: false, endedAt: new Date() } });
  }
  await prisma.season.update({ where: { id }, data: { isActive: true, endedAt: null } });
  redirectWith(res, "/admin/seasons", { ok: `Activated as ${target.visibility}.` });
});

void computeStandings;

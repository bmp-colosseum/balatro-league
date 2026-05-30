// Public, read-only views. No login required — anyone with the URL can browse standings.

import { Router } from "express";
import { Rarity } from "@prisma/client";
import { prisma } from "../db.js";
import { loadPlayerHistory } from "../profile.js";
import { computeStandings, formatDivisionField } from "../standings.js";
import { html, raw } from "./html.js";
import { layout } from "./layout.js";
import { sessionContext } from "./session-context.js";

export const publicRouter = Router();

const RARITY_LABEL: Record<Rarity, string> = {
  LEGENDARY: "Legendary",
  RARE: "Rare",
  UNCOMMON: "Uncommon",
  COMMON: "Common",
};

const RARITY_ORDER: Rarity[] = ["LEGENDARY", "RARE", "UNCOMMON", "COMMON"];

// List of every season (active + past). Click into one to see its standings.
publicRouter.get("/seasons", async (req, res) => {
  const seasons = await prisma.season.findMany({
    where: { visibility: "PUBLIC" },
    include: {
      _count: { select: { divisions: true } },
      divisions: { include: { _count: { select: { members: true, pairings: true } } } },
    },
    orderBy: [{ isActive: "desc" }, { startedAt: "desc" }],
  });

  const cards = seasons.map((s) => {
    const players = s.divisions.reduce((sum, d) => sum + d._count.members, 0);
    const sets = s.divisions.reduce((sum, d) => sum + d._count.pairings, 0);
    const pill = s.isActive
      ? raw('<span class="pill" style="background:rgba(46,204,113,0.2); color:#2ecc71">ACTIVE</span>')
      : raw('<span class="pill" style="background:rgba(149,165,166,0.2); color:#c0c8cb">FINISHED</span>');
    const period = s.endedAt
      ? `${s.startedAt.toISOString().slice(0, 10)} → ${s.endedAt.toISOString().slice(0, 10)}`
      : `Started ${s.startedAt.toISOString().slice(0, 10)}`;
    return html`<a href="/seasons/${s.id}" class="division-card">
      <strong style="font-size:16px">${s.name}</strong> ${pill}
      <div class="muted" style="margin-top:6px">${period}</div>
      <div class="muted">${s._count.divisions} divisions · ${players} players · ${sets} sets</div>
    </a>`;
  });

  const body = html`
    <h2>Seasons</h2>
    ${cards.length ? html`<div class="grid grid-2">${cards}</div>` : html`<div class="card muted">No seasons yet.</div>`}
  `;
  res.set("Content-Type", "text/html; charset=utf-8").send(
    layout({ title: "Seasons", activePath: "/seasons", body, ...(await sessionContext(req)) }).value,
  );
});

publicRouter.get("/seasons/:id", async (req, res) => {
  const season = await prisma.season.findFirst({
    where: { id: req.params.id!, visibility: "PUBLIC" },
    include: {
      divisions: {
        include: {
          members: { include: { player: true } },
          pairings: {
            where: { status: "CONFIRMED" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
          },
        },
        orderBy: [{ rarity: "asc" }, { groupNumber: "asc" }],
      },
    },
  });

  if (!season) {
    const body = html`<h2>Season not found</h2><p><a href="/seasons">← all seasons</a></p>`;
    return res.set("Content-Type", "text/html; charset=utf-8").send(
      layout({ title: "Season not found", activePath: "/seasons", body, ...(await sessionContext(req)) }).value,
    );
  }

  const byRarity = new Map<Rarity, typeof season.divisions>();
  for (const d of season.divisions) {
    if (!byRarity.has(d.rarity)) byRarity.set(d.rarity, []);
    byRarity.get(d.rarity)!.push(d);
  }

  const sections = RARITY_ORDER.filter((r) => (byRarity.get(r)?.length ?? 0) > 0).map((rarity) => {
    const divs = byRarity.get(rarity)!;
    const cards = divs.map((d) => {
      const droppedIds = new Set(d.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId));
      const rows = computeStandings(d.members.map((m) => m.player), d.pairings).map((r) => ({
        ...r,
        dropped: droppedIds.has(r.player.id),
      }));
      const rowsHtml = rows.length
        ? rows.map((r, i) => {
            const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
            const linked = html`<a href="/profile/${r.player.discordId}" style="color:var(--text)">${r.player.displayName}</a>`;
            const name = r.dropped ? html`<s>${linked}</s>` : linked;
            return html`<tr><td>${medal}</td><td>${name}</td><td><strong>${r.points}</strong></td><td>${r.wins}-${r.draws}-${r.losses}</td><td>${r.gamesWon}-${r.gamesLost}</td></tr>`;
          })
        : [html`<tr><td colspan="5" class="muted">No sets played.</td></tr>`];
      return html`<div class="card">
        <strong>${d.name}</strong>
        <table style="margin-top:8px">
          <thead><tr><th></th><th>Player</th><th>Pts</th><th>W-D-L</th><th>Games</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;
    });
    return html`<h3 style="margin-top:24px">${RARITY_LABEL[rarity]}</h3><div class="grid grid-2">${cards}</div>`;
  });

  const period = season.endedAt
    ? `${season.startedAt.toISOString().slice(0, 10)} → ${season.endedAt.toISOString().slice(0, 10)}`
    : `Started ${season.startedAt.toISOString().slice(0, 10)}`;
  const body = html`
    <div style="display:flex; align-items:baseline; gap:12px; margin-bottom:8px">
      <h2 style="margin:0">${season.name}</h2>
      ${season.isActive ? raw('<span class="pill" style="background:rgba(46,204,113,0.2); color:#2ecc71">ACTIVE</span>') : raw('<span class="pill" style="background:rgba(149,165,166,0.2); color:#c0c8cb">FINISHED</span>')}
      <span class="muted">· ${period}</span>
      <a href="/seasons" style="margin-left:auto">← all seasons</a>
    </div>
    ${sections.length ? sections : html`<div class="card muted">No divisions in this season.</div>`}
  `;
  res.set("Content-Type", "text/html; charset=utf-8").send(
    layout({ title: season.name, activePath: "/seasons", body, ...(await sessionContext(req)) }).value,
  );
});

// Public profile page: season-by-season history for a single player.
publicRouter.get("/profile/:discordId", async (req, res) => {
  const discordId = req.params.discordId!;
  const player = await prisma.player.findUnique({ where: { discordId } });
  if (!player) {
    const body = html`<h2>Profile not found</h2><p>No player with Discord ID <code>${discordId}</code>.</p>`;
    return res.set("Content-Type", "text/html; charset=utf-8").send(
      layout({ title: "Not found", activePath: "", body, ...(await sessionContext(req)) }).value,
    );
  }
  const profile = await loadPlayerHistory(player.id);
  if (!profile) {
    return res.status(500).send("Couldn't load profile.");
  }

  const rarityPill = (r: Rarity) => html`<span class="pill ${r.toLowerCase()}">${RARITY_LABEL[r]}</span>`;
  const rows = profile.history.map((h) => {
    const rankStr = h.rank > 0 ? `#${h.rank}/${h.totalMembers}` : raw('<span class="muted">—</span>');
    const statusPill = h.status === "DROPPED"
      ? raw(' <span class="pill" style="background:rgba(231,76,60,0.2); color:#e74c3c">DROPPED</span>')
      : raw("");
    const activeMarker = h.isActive ? raw(' <span class="pill confirmed">ACTIVE</span>') : raw("");
    return html`<tr>
      <td><a href="/seasons/${h.seasonId}">${h.seasonName}</a>${activeMarker}</td>
      <td>${rarityPill(h.rarity)} ${h.divisionName}${statusPill}</td>
      <td>${rankStr}</td>
      <td><strong>${h.points}</strong></td>
      <td>${h.wins}-${h.draws}-${h.losses}</td>
      <td>${h.gamesWon}-${h.gamesLost}</td>
    </tr>`;
  });

  const t = profile.totals;
  const body = html`
    <h2>${profile.player.displayName}</h2>
    <p class="muted">Discord ID: <code>${profile.player.discordId}</code></p>

    <div class="grid grid-3">
      <div class="stat"><div class="label">Seasons</div><div class="value">${t.seasons}</div></div>
      <div class="stat"><div class="label">Total points</div><div class="value">${t.points}</div></div>
      <div class="stat"><div class="label">Best rank</div><div class="value">${t.bestRank ? `#${t.bestRank}` : "—"}</div></div>
    </div>
    <div class="grid grid-3" style="margin-top:16px">
      <div class="stat"><div class="label">Wins (2-0)</div><div class="value">${t.wins}</div></div>
      <div class="stat"><div class="label">Draws (1-1)</div><div class="value">${t.draws}</div></div>
      <div class="stat"><div class="label">Losses (0-2)</div><div class="value">${t.losses}</div></div>
    </div>

    <div class="card" style="margin-top:24px">
      <strong>Season history</strong>
      ${rows.length
        ? html`<table>
            <thead><tr><th>Season</th><th>Division</th><th>Rank</th><th>Pts</th><th>W-D-L</th><th>Games</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
        : html`<p class="muted">No season history yet.</p>`}
    </div>
  `;
  res.set("Content-Type", "text/html; charset=utf-8").send(
    layout({ title: profile.player.displayName, activePath: "", body, ...(await sessionContext(req)) }).value,
  );
});

publicRouter.get("/standings", async (req, res) => {
  const season = await prisma.season.findFirst({
    where: { isActive: true, visibility: "PUBLIC" },
    include: {
      divisions: {
        include: {
          members: { include: { player: true } },
          pairings: {
            where: { status: "CONFIRMED" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
          },
        },
        orderBy: [{ rarity: "asc" }, { groupNumber: "asc" }],
      },
    },
  });

  if (!season) {
    const body = html`<h2>Standings</h2><div class="card muted">No active season right now.</div>`;
    return res.set("Content-Type", "text/html; charset=utf-8").send(
      layout({ title: "Standings", activePath: "/standings", body, ...(await sessionContext(req)) }).value,
    );
  }

  const byRarity = new Map<Rarity, typeof season.divisions>();
  for (const d of season.divisions) {
    if (!byRarity.has(d.rarity)) byRarity.set(d.rarity, []);
    byRarity.get(d.rarity)!.push(d);
  }

  const sections = RARITY_ORDER.filter((r) => (byRarity.get(r)?.length ?? 0) > 0).map((rarity) => {
    const divs = byRarity.get(rarity)!;
    const cards = divs.map((d) => {
      const droppedIds = new Set(d.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId));
      const rows = computeStandings(d.members.map((m) => m.player), d.pairings).map((r) => ({
        ...r,
        dropped: droppedIds.has(r.player.id),
      }));
      const rowsHtml = rows.length
        ? rows.map((r, i) => {
            const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
            const linked = html`<a href="/profile/${r.player.discordId}" style="color:var(--text)">${r.player.displayName}</a>`;
            const name = r.dropped ? html`<s>${linked}</s>` : linked;
            return html`<tr><td>${medal}</td><td>${name}</td><td><strong>${r.points}</strong></td><td>${r.wins}-${r.draws}-${r.losses}</td><td>${r.gamesWon}-${r.gamesLost}</td></tr>`;
          })
        : [html`<tr><td colspan="5" class="muted">No sets played yet.</td></tr>`];
      void formatDivisionField; // referenced for symmetry with Discord path
      return html`<div class="card">
        <strong>${d.name}</strong>
        <table style="margin-top:8px">
          <thead><tr><th></th><th>Player</th><th>Pts</th><th>W-D-L</th><th>Games</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;
    });
    return html`<h3 style="margin-top:24px">${RARITY_LABEL[rarity]}</h3>
      <div class="grid grid-2">${cards}</div>`;
  });

  const body = html`
    <h2>${season.name} — Standings</h2>
    ${sections.length ? sections : html`<div class="card muted">No divisions in this season.</div>`}
  `;
  res.set("Content-Type", "text/html; charset=utf-8").send(
    layout({ title: "Standings", activePath: "/standings", body, ...(await sessionContext(req)) }).value,
  );
});

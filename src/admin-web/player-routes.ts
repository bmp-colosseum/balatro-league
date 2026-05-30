// Player-facing routes (login required).
//   GET  /me                — profile + standings + pending/open sets + report form
//   POST /me/report         — submit a new set result (mirrors /report Discord command)
//   POST /me/confirm/:id    — confirm a pending set against you
//   POST /me/dispute/:id    — dispute a pending set against you

import express, { Router } from "express";
import { prisma } from "../db.js";
import { confirmSet, disputeSet, reportSet } from "../reporting.js";
import { parsePairingResult } from "../scoring.js";
import { computeStandings } from "../standings.js";
import { html, raw, type RawHtml } from "./html.js";
import { layout } from "./layout.js";
import { requireLogin } from "./auth.js";

export const playerRouter = Router();
playerRouter.use(express.urlencoded({ extended: true }));
playerRouter.use(requireLogin());

playerRouter.get("/me", async (req, res) => {
  const u = req.session.user!;
  const player = await prisma.player.findUnique({
    where: { discordId: u.discordId },
    include: {
      memberships: {
        where: { division: { season: { isActive: true, visibility: "PUBLIC" } } },
        include: {
          division: {
            include: {
              members: { include: { player: true } },
              pairings: {
                include: { playerA: true, playerB: true },
              },
              season: { select: { targetGroupSize: true } },
            },
          },
        },
      },
    },
  });

  const avatarUrl = u.avatar
    ? `https://cdn.discordapp.com/avatars/${u.discordId}/${u.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  const flashMessage = readFlashFromQuery(req);

  const identityCard = html`<div class="card" style="display:flex; gap:16px; align-items:center">
    <img src="${avatarUrl}" alt="" style="width:64px; height:64px; border-radius:50%" />
    <div>
      <div style="font-size:18px; font-weight:600">${u.username}</div>
      <div class="muted">Discord ID: <code>${u.discordId}</code></div>
      ${player
        ? raw('<div style="margin-top:4px"><span class="pill confirmed">Linked</span> Your Discord ID is connected to a league profile.</div>')
        : raw('<div style="margin-top:4px"><span class="pill pending">Not linked yet</span> Sign up via the Discord bot to join.</div>')}
    </div>
    <span style="margin-left:auto">
      <a href="/auth/logout"><button class="secondary" type="button">Logout</button></a>
    </span>
  </div>`;

  if (!player) {
    const body = html`
      <h2>Your profile</h2>
      ${identityCard}
      <div class="card">
        <strong>Not in the league yet</strong>
        <p>You're logged in, but no league profile is linked to <code>${u.discordId}</code>.</p>
        <p>Sign up via the Discord bot's Sign Up button, or ask an admin to add you.</p>
      </div>
    `;
    return res.set("Content-Type", "text/html; charset=utf-8").send(
      layout({ title: "Your profile", activePath: "/me", flash: flashMessage, body, sessionUser: req.session.user ?? null }).value,
    );
  }

  const activeMembership = player.memberships[0];
  if (!activeMembership) {
    const body = html`
      <h2>Your profile</h2>
      ${identityCard}
      <div class="card">
        <strong>Not in an active division</strong>
        <p>You're registered but haven't been placed in a division for the current season.</p>
      </div>
    `;
    return res.set("Content-Type", "text/html; charset=utf-8").send(
      layout({ title: "Your profile", activePath: "/me", flash: flashMessage, body, sessionUser: req.session.user ?? null }).value,
    );
  }

  const div = activeMembership.division;
  const droppedIds = new Set(div.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId));
  const confirmedPairings = div.pairings.filter((p) => p.status === "CONFIRMED");
  const rows = computeStandings(div.members.map((m) => m.player), confirmedPairings.map((p) => ({
    playerAId: p.playerAId,
    playerBId: p.playerBId,
    gamesWonA: p.gamesWonA,
    gamesWonB: p.gamesWonB,
  }))).map((r) => ({ ...r, dropped: droppedIds.has(r.player.id) }));
  const myRank = rows.findIndex((r) => r.player.id === player.id) + 1;
  const myRow = rows.find((r) => r.player.id === player.id);

  // What sets are pending vs played for THIS player?
  const myPairings = div.pairings.filter(
    (p) => p.playerAId === player.id || p.playerBId === player.id,
  );
  const pendingAgainstMe = myPairings.filter(
    (p) => p.status === "PENDING" && p.reporterId !== player.id,
  );
  const pendingByMe = myPairings.filter(
    (p) => p.status === "PENDING" && p.reporterId === player.id,
  );
  const disputed = myPairings.filter((p) => p.status === "DISPUTED");

  // Opponents I haven't yet played a CONFIRMED/PENDING/DISPUTED set against:
  const settledOpponentIds = new Set<string>();
  for (const p of myPairings) {
    if (p.status !== "CANCELLED") {
      settledOpponentIds.add(p.playerAId === player.id ? p.playerBId : p.playerAId);
    }
  }
  const remainingOpponents = div.members
    .filter((m) => m.playerId !== player.id && m.status === "ACTIVE" && !settledOpponentIds.has(m.playerId))
    .map((m) => m.player);

  // ---------- render ----------
  const standingsRows = rows.map((r, i) => {
    const isMe = r.player.id === player.id;
    const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
    return html`<tr style="${isMe ? "background:rgba(88,101,242,0.15)" : ""}">
      <td>${medal}</td>
      <td>${r.dropped ? html`<s>${r.player.displayName}</s>` : r.player.displayName} ${isMe ? raw('<span class="muted">(you)</span>') : raw("")}</td>
      <td><strong>${r.points}</strong></td>
      <td>${r.wins}-${r.draws}-${r.losses}</td>
      <td>${r.gamesWon}-${r.gamesLost}</td>
    </tr>`;
  });

  const pendingAgainstMeCard = pendingAgainstMe.length
    ? html`<div class="card" style="border-left:3px solid var(--accent)">
        <strong>⚠️ Pending — waiting on your confirmation</strong>
        <p class="muted">An opponent reported a set against you. Confirm or dispute.</p>
        <table>
          <thead><tr><th>Opponent</th><th>They reported</th><th></th></tr></thead>
          <tbody>${pendingAgainstMe.map((p) => {
            const reporterIsA = p.reporterId === p.playerAId;
            const opp = reporterIsA ? p.playerA : p.playerB;
            const fromOppPov = reporterIsA
              ? `${p.gamesWonA}-${p.gamesWonB}`
              : `${p.gamesWonB}-${p.gamesWonA}`;
            const myView = reporterIsA
              ? `(I went ${p.gamesWonB}-${p.gamesWonA})`
              : `(I went ${p.gamesWonA}-${p.gamesWonB})`;
            return html`<tr>
              <td>${opp.displayName}</td>
              <td><strong>${fromOppPov}</strong> <span class="muted">${myView}</span></td>
              <td style="display:flex; gap:6px">
                <form method="post" action="/me/confirm/${p.id}"><button type="submit">Confirm</button></form>
                <form method="post" action="/me/dispute/${p.id}" onsubmit="return confirm('Dispute this result? An admin will resolve it.')"><button class="danger" type="submit">Dispute</button></form>
              </td>
            </tr>`;
          })}</tbody>
        </table>
      </div>`
    : raw("");

  const pendingByMeCard = pendingByMe.length
    ? html`<div class="card">
        <strong>Waiting on opponents</strong>
        <p class="muted">You reported these. They need to confirm.</p>
        <table>
          <thead><tr><th>Opponent</th><th>You reported</th><th>Status</th></tr></thead>
          <tbody>${pendingByMe.map((p) => {
            const opp = p.playerAId === player.id ? p.playerB : p.playerA;
            const myGames = p.playerAId === player.id ? p.gamesWonA : p.gamesWonB;
            const oppGames = p.playerAId === player.id ? p.gamesWonB : p.gamesWonA;
            return html`<tr>
              <td>${opp.displayName}</td>
              <td><strong>${myGames}-${oppGames}</strong></td>
              <td><span class="pill pending">PENDING</span></td>
            </tr>`;
          })}</tbody>
        </table>
      </div>`
    : raw("");

  const disputedCard = disputed.length
    ? html`<div class="card" style="border-left:3px solid var(--danger)">
        <strong>Disputed sets</strong>
        <p class="muted">An admin needs to resolve these.</p>
        ${disputed.map((p) => {
          const opp = p.playerAId === player.id ? p.playerB : p.playerA;
          return html`<div>vs <strong>${opp.displayName}</strong> — <span class="pill disputed">DISPUTED</span></div>`;
        })}
      </div>`
    : raw("");

  const reportFormCard = remainingOpponents.length
    ? html`<div class="card">
        <strong>Report a set</strong>
        <p class="muted">Submit your match result. It's recorded immediately. If something's wrong, ask an admin to override.</p>
        <form method="post" action="/me/report">
          <label>Opponent
            <select name="opponentPlayerId" required>
              <option value="">— pick opponent —</option>
              ${remainingOpponents.map((o) => html`<option value="${o.id}">${o.displayName}</option>`)}
            </select>
          </label>
          <label>Result (your POV)
            <select name="result" required>
              <option value="2-0">I won 2-0</option>
              <option value="1-1">We drew 1-1</option>
              <option value="0-2">I lost 0-2</option>
            </select>
          </label>
          <button type="submit">Submit</button>
        </form>
      </div>`
    : html`<div class="card muted">No remaining opponents to report against in <strong>${div.name}</strong>.</div>`;

  const body = html`
    <h2>Your profile</h2>
    ${identityCard}

    <div class="grid grid-3" style="margin-top:16px">
      <div class="stat"><div class="label">Division</div><div class="value" style="font-size:20px">${div.name}</div></div>
      <div class="stat"><div class="label">Your rank</div><div class="value">#${myRank}</div></div>
      <div class="stat"><div class="label">Points</div><div class="value">${myRow?.points ?? 0}</div></div>
    </div>

    ${pendingAgainstMeCard}
    ${reportFormCard}
    ${pendingByMeCard}
    ${disputedCard}

    <div class="card" style="margin-top:16px">
      <strong>Division standings — ${div.name}</strong>
      <table>
        <thead><tr><th></th><th>Player</th><th>Pts</th><th>W-D-L</th><th>Games</th></tr></thead>
        <tbody>${standingsRows}</tbody>
      </table>
    </div>
  `;
  res.set("Content-Type", "text/html; charset=utf-8").send(
    layout({ title: "Your profile", activePath: "/me", flash: flashMessage, body, sessionUser: req.session.user ?? null }).value,
  );
});

playerRouter.post("/me/report", async (req, res) => {
  const u = req.session.user!;
  const me = await prisma.player.findUnique({ where: { discordId: u.discordId } });
  if (!me) return redirectMe(res, { err: "You're not a Player yet — ask an admin to add you." });

  const opponentId = String(req.body.opponentPlayerId ?? "");
  const resultStr = String(req.body.result ?? "");
  const result = parsePairingResult(resultStr);
  if (!opponentId || !result) return redirectMe(res, { err: "Pick an opponent and a result." });

  const r = await reportSet({
    reporterPlayerId: me.id,
    opponentPlayerId: opponentId,
    result,
  });
  if (!r.ok) return redirectMe(res, { err: r.reason });
  redirectMe(res, { ok: "Set recorded." });
});

playerRouter.post("/me/confirm/:id", async (req, res) => {
  const u = req.session.user!;
  const me = await prisma.player.findUnique({ where: { discordId: u.discordId } });
  if (!me) return redirectMe(res, { err: "You're not a Player yet." });
  const r = await confirmSet(req.params.id!, me.id);
  redirectMe(res, r.ok ? { ok: "Confirmed." } : { err: r.reason });
});

playerRouter.post("/me/dispute/:id", async (req, res) => {
  const u = req.session.user!;
  const me = await prisma.player.findUnique({ where: { discordId: u.discordId } });
  if (!me) return redirectMe(res, { err: "You're not a Player yet." });
  const r = await disputeSet(req.params.id!, me.id);
  redirectMe(res, r.ok ? { ok: "Disputed. An admin will resolve it." } : { err: r.reason });
});

function redirectMe(res: express.Response, flash: { ok?: string; err?: string }) {
  const params = new URLSearchParams();
  if (flash.ok) params.set("ok", flash.ok);
  if (flash.err) params.set("err", flash.err);
  res.redirect(`/me${params.toString() ? `?${params}` : ""}`);
}

function readFlashFromQuery(req: express.Request) {
  if (req.query.ok) return { kind: "success" as const, message: String(req.query.ok) };
  if (req.query.err) return { kind: "error" as const, message: String(req.query.err) };
  return undefined;
}

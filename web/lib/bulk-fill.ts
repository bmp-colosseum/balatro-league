// Shared bulk-fill-season logic. Used by the /api/admin/finish-season
// endpoint and (potentially) admin UI buttons that want to autofill
// every pending pairing in a season with random results.
//
// Does ONE thing well: walks every active member pair across every
// division in the season, generates a random result, upserts the
// Pairing as CONFIRMED. Skips already-CONFIRMED rows. Recomputes
// standings. Optionally enqueues an announce per new/promoted row.
// Audit entry written so script runs show up in /admin/audit.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { enqueueAnnounceResult } from "@/lib/queue";
import { recomputeDivisionStandings } from "@/lib/standings-cache";

export interface BulkFillOptions {
  seasonId: string;
  seed?: number;
  // When true, enqueue an announce per pairing created or promoted
  // from pending. Worker drains at ~1/sec; a 250-pairing run takes
  // ~4 minutes to fully announce.
  announce?: boolean;
  actor: AuditActor;
}

export interface BulkFillResult {
  seasonName: string;
  divisionCount: number;
  created: number;
  confirmedFromPending: number;
  announceEnqueued: number;
}

type PairingResultKey = "2-0" | "1-1" | "0-2";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomResult(rand: () => number): PairingResultKey {
  const r = rand();
  if (r < 0.4) return "2-0";
  if (r < 0.6) return "1-1";
  return "0-2";
}

function gamesFromResult(result: PairingResultKey): { a: number; b: number } {
  if (result === "2-0") return { a: 2, b: 0 };
  if (result === "1-1") return { a: 1, b: 1 };
  return { a: 0, b: 2 };
}

export async function bulkFillSeason(opts: BulkFillOptions): Promise<BulkFillResult> {
  const { seasonId, actor } = opts;
  const seed = opts.seed ?? 42;
  const announce = opts.announce === true;
  const rand = rng(seed);

  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { id: true, name: true },
  });
  if (!season) throw new Error(`Season ${seasonId} not found`);

  const divisions = await prisma.division.findMany({
    where: { seasonId },
    include: {
      members: { where: { status: "ACTIVE" }, select: { playerId: true } },
    },
  });

  let created = 0;
  let confirmedFromPending = 0;
  let announceEnqueued = 0;
  for (const div of divisions) {
    const playerIds = div.members.map((m) => m.playerId).sort();
    for (let i = 0; i < playerIds.length; i++) {
      for (let j = i + 1; j < playerIds.length; j++) {
        const aId = playerIds[i]!;
        const bId = playerIds[j]!;
        const existing = await prisma.pairing.findUnique({
          where: { divisionId_playerAId_playerBId: { divisionId: div.id, playerAId: aId, playerBId: bId } },
        });
        const result = randomResult(rand);
        const { a: gA, b: gB } = gamesFromResult(result);
        if (!existing) {
          const row = await prisma.pairing.create({
            data: {
              divisionId: div.id,
              playerAId: aId,
              playerBId: bId,
              gamesWonA: gA,
              gamesWonB: gB,
              status: "CONFIRMED",
              reportedAt: new Date(),
              confirmedAt: new Date(),
            },
          });
          created++;
          if (announce) {
            await enqueueAnnounceResult(row.id).catch(() => {});
            announceEnqueued++;
          }
        } else if (existing.status !== "CONFIRMED") {
          // UncheckedUpdateInput lets us set the raw disputedById FK to
          // null without going through the relation API. Same effect.
          const data: Prisma.PairingUncheckedUpdateInput = {
            gamesWonA: gA,
            gamesWonB: gB,
            status: "CONFIRMED",
            reportedAt: existing.reportedAt ?? new Date(),
            confirmedAt: new Date(),
            disputedById: null,
            disputeProposedGamesWonA: null,
            disputeProposedGamesWonB: null,
            disputeReason: null,
            disputedAt: null,
          };
          await prisma.pairing.update({ where: { id: existing.id }, data });
          confirmedFromPending++;
          if (announce) {
            await enqueueAnnounceResult(existing.id).catch(() => {});
            announceEnqueued++;
          }
        }
      }
    }
  }

  // Refresh the materialized standings so /standings and admin pages
  // reflect the new results immediately.
  for (const div of divisions) {
    await recomputeDivisionStandings(div.id).catch(() => {});
  }

  // Audit entry — script runs now appear in /admin/audit alongside
  // human admin actions. Actor carries the token fingerprint.
  await recordAudit({
    actor,
    action: "season.bulk-fill",
    targetType: "Season",
    targetId: seasonId,
    summary: `Bulk-filled ${created + confirmedFromPending} pairings in "${season.name}" (seed ${seed}${announce ? ", announces enqueued" : ""})`,
    metadata: { seed, announce, created, confirmedFromPending, divisionCount: divisions.length, announceEnqueued },
  });

  return {
    seasonName: season.name,
    divisionCount: divisions.length,
    created,
    confirmedFromPending,
    announceEnqueued,
  };
}

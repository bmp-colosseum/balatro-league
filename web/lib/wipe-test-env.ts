// Test-environment data wipe. Drops every row across every gameplay
// table — players, seasons, divisions, pairings, shootouts, match
// sessions, signups, snapshots, standings cache, season-interest
// follows, easter-egg votes — leaving the league with a clean slate
// while preserving operator config (LeagueConfig, RoleBinding,
// TierTemplate, MatchConfigPreset, LeagueRulesTemplate) and the audit
// log itself.
//
// Designed for the test Railway environment ONLY. The route that
// fronts this function gates it on env + a typed confirmation; this
// function is "just do the wipe" with no extra guard beyond the FK
// ordering. Do not call from any other code path.

import { prisma } from "@/lib/prisma";
import { recordAudit, type AuditActor } from "@/lib/audit";

export interface WipeResult {
  truncatedTables: string[];
  rowsDeleted: number;
}

// Tables wiped, in CASCADE-tolerant order via TRUNCATE. The list is
// reasoned about, but the TRUNCATE ... CASCADE means we don't strictly
// need a topological order — PG will follow FK cascades regardless.
// Explicit list also documents what's wiped vs preserved.
const WIPED_TABLES = [
  "Match",
  "Game",
  "GameDeck",
  "Pairing",
  "Shootout",
  "MatchSession",
  "DivisionStandings",
  "DivisionMember",
  "Division",
  "Tier",
  "Signup",
  "SignupRound",
  "PlayerMmrSnapshot",
  "EasterEggVote",
  "SeasonInterest",
  "Season",
  "Player",
] as const;

export async function wipeTestEnvironment(actor: AuditActor): Promise<WipeResult> {
  // Count first so the audit + return value is informative. Single
  // SUM across the wiped tables.
  const counts = await Promise.all(
    WIPED_TABLES.map(async (table) => {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "${table}"`);
      return Number(rows[0]?.n ?? 0);
    }),
  );
  const rowsDeleted = counts.reduce((sum, c) => sum + c, 0);

  // One atomic TRUNCATE statement. CASCADE handles any cross-table FK
  // refs (e.g. dangling references from preserved-config tables, which
  // shouldn't exist but the cascade keeps it safe). RESTART IDENTITY
  // resets serial sequences — irrelevant for cuid PKs but harmless.
  const tableList = WIPED_TABLES.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);

  recordAudit({
    actor,
    action: "test-env.wipe",
    targetType: "Database",
    targetId: "ALL_GAMEPLAY_TABLES",
    summary: `Wiped test environment (${rowsDeleted} rows across ${WIPED_TABLES.length} tables)`,
    metadata: {
      truncatedTables: WIPED_TABLES.map((t) => t),
      rowsDeleted,
      perTableCounts: Object.fromEntries(WIPED_TABLES.map((t, i) => [t, counts[i]])),
    },
  });

  return { truncatedTables: WIPED_TABLES.map((t) => t), rowsDeleted };
}

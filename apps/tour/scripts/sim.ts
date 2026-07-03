// Simulation CLI — THIN caller into lib/services/simulate.ts (no logic here).
// Only touches seasons named "Sim ..." (guarded in the service).
//
//   npx tsx scripts/sim.ts seed   [--name "Sim Season"] [--players 24]
//   npx tsx scripts/sim.ts draft  [--name "Sim Season"] [--delay 3000]   (watch it live!)
//   npx tsx scripts/sim.ts week   [--name "Sim Season"]                  (pair + report one week)
//   npx tsx scripts/sim.ts fans   [--name "Sim Season"] [--count 10]     (fake pick'em predictors)
//   npx tsx scripts/sim.ts fantasy [--name "Sim Season"] [--scope SEASON|PLAYOFFS] [--managers N]
//   npx tsx scripts/sim.ts teardown [--name "Sim Season"]
import "dotenv/config";
import { seedScratchSeason, simulateDraft, simulateWeek, simulatePredictors, simulateFantasy, teardownSim } from "../lib/services/simulate";
import { prisma } from "../lib/db";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const cmd = process.argv[2];
  const name = arg("name", "Sim Season");
  if (cmd === "seed") {
    const r = await seedScratchSeason(name, Number(arg("players", "24")));
    console.log(`Seeded "${r.seasonName}": ${r.players} approved signups (${r.captains} willing captains).`);
    console.log(`Next: set up + run the draft on /admin/seasons/${encodeURIComponent(name)}/draft, or: npx tsx scripts/sim.ts draft`);
  } else if (cmd === "draft") {
    const r = await simulateDraft(name, Number(arg("delay", "0")));
    console.log(`Draft simulated: ${r.picks} picks made.`);
  } else if (cmd === "week") {
    const pairOnly = process.argv.includes("--pair-only");
    const r = await simulateWeek(name, { report: !pairOnly });
    console.log(r.week == null ? "No open week — season fully played." : `Week ${r.week}: ${r.paired} pairs, ${r.reported} results reported${pairOnly ? " (pair-only — sets left open)" : ""}.`);
  } else if (cmd === "fans") {
    const r = await simulatePredictors(name, Number(arg("count", "10")));
    console.log(`${r.picks} fake pick'em predictions made.`);
  } else if (cmd === "fantasy") {
    const scope = arg("scope", "SEASON") === "PLAYOFFS" ? "PLAYOFFS" : "SEASON";
    const managers = process.argv.includes("--managers") ? Number(arg("managers", "0")) : undefined;
    const r = await simulateFantasy(name, { scope, managers });
    console.log(`Fantasy (${r.scope}, roster ${r.rosterSize}) — ${r.setsCounted} sets counted:`);
    r.standings.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s.managerId.padEnd(10)} ${s.points} pts (${s.sets} player-sets)`));
  } else if (cmd === "teardown") {
    const r = await teardownSim(name);
    console.log(`Removed "${name}" + ${r.playersDeleted} sim players.`);
  } else {
    console.log("Usage: sim.ts seed|draft|week|fans|fantasy|teardown [--name ...] [--players N] [--delay ms] [--count N] [--scope SEASON|PLAYOFFS] [--managers N]");
    process.exitCode = 1;
  }
  await prisma.$disconnect();
  process.exit(0); // pg-boss enqueue connections keep the loop alive — exit explicitly
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});

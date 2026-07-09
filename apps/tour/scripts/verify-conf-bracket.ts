// Pure-logic check (no DB): reproduce the conference-bracket build + advancement the
// playoffs service does, and assert the shape (QF conf-contiguous -> SF conf finals ->
// cross-conference FINAL). Run: cd apps/tour && npx tsx scripts/verify-conf-bracket.ts
import { assembleBracketByChoice } from "@balatro/competition-core";

interface Series { round: string; bracketIndex: number; conferenceId: string | null; a: string; b: string; winner?: string }

// Mirrors startConferencePlayoffs: per-conference assembleBracketByChoice, laid out contiguous.
function buildQF(confs: { id: string; seeds: string[]; pick: string }[]): Series[] {
  const out: Series[] = [];
  let bi = 0;
  for (const c of confs) {
    const half = c.seeds.length / 2;
    const choosers = c.seeds.slice(0, half);
    const pickable = c.seeds.slice(half);
    const leftovers = pickable.filter((x) => x !== c.pick);
    const picks: Record<string, string> = { [choosers[0]!]: c.pick };
    for (let i = 1; i < choosers.length; i++) picks[choosers[i]!] = leftovers[i - 1]!;
    const res = assembleBracketByChoice(c.seeds, picks);
    if (!res.ok) throw new Error(`${c.id}: ${res.reason}`);
    for (const [a, b] of res.pairs) out.push({ round: "QF", bracketIndex: bi++, conferenceId: c.id, a, b });
  }
  return out;
}

// Mirrors maybeAdvance liveMode: pair consecutive feeders, carry conf (null when they differ).
function advance(series: Series[], nextRound: string): Series[] {
  const out: Series[] = [];
  for (let i = 0; i * 2 + 1 < series.length; i++) {
    const fA = series[i * 2]!, fB = series[i * 2 + 1]!;
    const conf = fA.conferenceId && fA.conferenceId === fB.conferenceId ? fA.conferenceId : null;
    out.push({ round: nextRound, bracketIndex: i, conferenceId: conf, a: fA.winner!, b: fB.winner! });
  }
  return out;
}

// higher seed (lower index within its conf's seed list) wins — deterministic.
const seedRank = new Map<string, number>();
function setWinners(series: Series[]) { for (const s of series) s.winner = (seedRank.get(s.a)! <= seedRank.get(s.b)!) ? s.a : s.b; }

function run(title: string, confs: { id: string; seeds: string[]; pick: string }[]) {
  seedRank.clear();
  for (const c of confs) c.seeds.forEach((id, i) => seedRank.set(id, i));
  console.log(`\n### ${title}`);
  const qf = buildQF(confs); setWinners(qf);
  console.log("QF:"); qf.forEach((s) => console.log(`  [${s.bracketIndex}] ${s.conferenceId}: ${s.a} vs ${s.b} -> ${s.winner}`));
  const sf = advance(qf, "SF"); setWinners(sf);
  console.log("SF:"); sf.forEach((s) => console.log(`  [${s.bracketIndex}] ${s.conferenceId ?? "CROSS"}: ${s.a} vs ${s.b} -> ${s.winner}`));
  const fin = advance(sf, "FINAL"); setWinners(fin);
  console.log("FINAL:"); fin.forEach((s) => console.log(`  [${s.bracketIndex}] ${s.conferenceId ?? "CROSS"}: ${s.a} vs ${s.b} -> ${s.winner}`));

  // Assertions
  const errs: string[] = [];
  if (qf.length !== confs.length * (confs[0]!.seeds.length / 2)) errs.push("QF count wrong");
  // every SF must be single-conference (a real conference final)
  for (const s of sf) if (!s.conferenceId) errs.push(`SF ${s.bracketIndex} is not conference-contained`);
  // #1 must play its pick in QF
  for (const c of confs) {
    const s1 = qf.find((s) => s.conferenceId === c.id && (s.a === c.seeds[0] || s.b === c.seeds[0]))!;
    const opp = s1.a === c.seeds[0] ? s1.b : s1.a;
    if (opp !== c.pick) errs.push(`${c.id}: #1 opponent is ${opp}, expected pick ${c.pick}`);
  }
  // FINAL must cross conferences
  if (fin.length === 1 && fin[0]!.conferenceId) errs.push("FINAL is not cross-conference");
  console.log(errs.length ? `  FAIL: ${errs.join("; ")}` : "  OK: shape correct");
}

// TT4: 2 conferences x 4 berths. Pluto #1 picks #4 (Ten Gallon), Eris #1 picks #3 (Slam Dunks).
run("TT4 2x4 (P1 picks #4, E1 picks #3)", [
  { id: "PLUTO", seeds: ["P1", "P2", "P3", "P4"], pick: "P4" },
  { id: "ERIS", seeds: ["E1", "E2", "E3", "E4"], pick: "E3" },
]);
// Other pick
run("TT4 2x4 (P1 picks #3, E1 picks #4)", [
  { id: "PLUTO", seeds: ["P1", "P2", "P3", "P4"], pick: "P3" },
  { id: "ERIS", seeds: ["E1", "E2", "E3", "E4"], pick: "E4" },
]);
// Stress: 2 conferences x 8 berths (QF 8 -> needs the >2-pair reorder path)
run("2x8 berths", [
  { id: "A", seeds: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"], pick: "A8" },
  { id: "B", seeds: ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"], pick: "B5" },
]);

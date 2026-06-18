// Schedule generator. Assigns every player in a division a fixed set of
// `degree` opponents (default 4) as a simple, undirected, `degree`-regular
// graph — no self-matches, no repeats, symmetric (if A plays B, B plays A).
//
// Fairness goal ("snake"): because standings + promotion run division-wide but
// you only play `degree` of N, your opponents ARE your strength of schedule. So
// we balance it: minimise the variance of each player's SoS (sum of opponent
// MMRs) so everyone faces a comparable slate and their short records are
// actually comparable. Note ΣSoS = degree·ΣMMR for ANY regular graph, so the
// target every player is pulled toward is degree·meanMMR; variance 0 = perfectly
// equal schedules.
//
// Method: seed with a circulant graph (each player linked to their ±1, ±2 … in
// MMR order — guaranteed valid + regular for N ≥ degree+1), then degree-
// preserving 2-swaps (rewire two edges, keeping every degree fixed) that reduce
// SoS variance, with a few seeded restarts. Trivial at division scale.

export interface SchedulePlayer {
  id: string;
  mmr: number;
}

export interface ScheduleResult {
  // playerId -> their assigned opponents (sorted strongest-first).
  opponents: Map<string, string[]>;
  // playerId -> strength of schedule (sum of opponent MMRs).
  sos: Map<string, number>;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

// Circulant seed on the MMR-sorted ring: each i linked to ±1..±(k/2).
function buildCirculant(n: number, k: number): Set<number>[] {
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  const half = Math.floor(k / 2);
  for (let i = 0; i < n; i++) {
    for (let d = 1; d <= half; d++) {
      adj[i]!.add((i + d) % n);
      adj[i]!.add((i - d + n) % n);
    }
  }
  return adj;
}

function sosArray(adj: Set<number>[], mmr: number[]): number[] {
  return adj.map((s) => {
    let sum = 0;
    for (const j of s) sum += mmr[j]!;
    return sum;
  });
}

function sumSq(sos: number[]): number {
  return sos.reduce((a, x) => a + x * x, 0);
}

// Degree-preserving 2-swap local search minimising Σ SoS². (Mean SoS is fixed
// by regularity, so minimising Σ SoS² minimises variance.) Each round scans all
// edge pairs and applies EVERY improving swap it finds; rounds repeat until a
// full scan makes no change (a local optimum).
function optimize(adj: Set<number>[], mmr: number[], rng: () => number, maxRounds: number): void {
  const n = adj.length;
  const sos = sosArray(adj, mmr);

  for (let round = 0; round < maxRounds; round++) {
    const edges: [number, number][] = [];
    for (let i = 0; i < n; i++) for (const j of adj[i]!) if (i < j) edges.push([i, j]);
    shuffle(edges, rng);

    let improved = false;
    for (let e1 = 0; e1 < edges.length; e1++) {
      for (let e2 = e1 + 1; e2 < edges.length; e2++) {
        // Re-read each iteration — edges[e1]/[e2] may have been rewired below.
        const [a, b] = edges[e1]!;
        const [c, d] = edges[e2]!;
        if (a === c || a === d || b === c || b === d) continue; // share a vertex

        // Apply the better of the two valid rewirings if it lowers Σ SoS².
        const before = sos[a]! ** 2 + sos[b]! ** 2 + sos[c]! ** 2 + sos[d]! ** 2;
        // R1: (a,c)+(b,d)
        const r1ok = !adj[a]!.has(c) && !adj[b]!.has(d);
        const r1 = r1ok
          ? (sos[a]! + mmr[c]! - mmr[b]!) ** 2 + (sos[b]! + mmr[d]! - mmr[a]!) ** 2 +
            (sos[c]! + mmr[a]! - mmr[d]!) ** 2 + (sos[d]! + mmr[b]! - mmr[c]!) ** 2
          : Infinity;
        // R2: (a,d)+(b,c)
        const r2ok = !adj[a]!.has(d) && !adj[b]!.has(c);
        const r2 = r2ok
          ? (sos[a]! + mmr[d]! - mmr[b]!) ** 2 + (sos[b]! + mmr[c]! - mmr[a]!) ** 2 +
            (sos[c]! + mmr[b]! - mmr[d]!) ** 2 + (sos[d]! + mmr[a]! - mmr[c]!) ** 2
          : Infinity;

        if (r1 <= r2 && r1 < before - 1e-9) {
          adj[a]!.delete(b); adj[b]!.delete(a); adj[c]!.delete(d); adj[d]!.delete(c);
          adj[a]!.add(c); adj[c]!.add(a); adj[b]!.add(d); adj[d]!.add(b);
          sos[a]! += mmr[c]! - mmr[b]!; sos[b]! += mmr[d]! - mmr[a]!;
          sos[c]! += mmr[a]! - mmr[d]!; sos[d]! += mmr[b]! - mmr[c]!;
          edges[e1] = [Math.min(a, c), Math.max(a, c)];
          edges[e2] = [Math.min(b, d), Math.max(b, d)];
          improved = true;
        } else if (r2 < before - 1e-9) {
          adj[a]!.delete(b); adj[b]!.delete(a); adj[c]!.delete(d); adj[d]!.delete(c);
          adj[a]!.add(d); adj[d]!.add(a); adj[b]!.add(c); adj[c]!.add(b);
          sos[a]! += mmr[d]! - mmr[b]!; sos[b]! += mmr[c]! - mmr[a]!;
          sos[c]! += mmr[b]! - mmr[d]!; sos[d]! += mmr[a]! - mmr[c]!;
          edges[e1] = [Math.min(a, d), Math.max(a, d)];
          edges[e2] = [Math.min(b, c), Math.max(b, c)];
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
}

export function generateSchedule(
  players: SchedulePlayer[],
  opts: { degree?: number; seed?: number; passes?: number; restarts?: number } = {},
): ScheduleResult {
  const k = opts.degree ?? 4;
  const n = players.length;
  // Sort strongest-first so the circulant ring is MMR-ordered.
  const sorted = [...players].sort((a, b) => b.mmr - a.mmr);
  const ids = sorted.map((p) => p.id);
  const mmr = sorted.map((p) => p.mmr);

  const opponents = new Map<string, string[]>();
  const sosOut = new Map<string, number>();

  // Too small for a proper k-regular graph → everyone plays everyone.
  if (n <= k + 1) {
    for (let i = 0; i < n; i++) {
      const list: string[] = [];
      let s = 0;
      for (let j = 0; j < n; j++) if (j !== i) { list.push(ids[j]!); s += mmr[j]!; }
      opponents.set(ids[i]!, list);
      sosOut.set(ids[i]!, s);
    }
    return { opponents, sos: sosOut };
  }

  const restarts = Math.max(1, opts.restarts ?? 8);
  const maxRounds = Math.max(1, opts.passes ?? 100);
  let best: { adj: Set<number>[]; cost: number } | null = null;
  for (let r = 0; r < restarts; r++) {
    const rng = mulberry32((opts.seed ?? 1) * 1009 + r * 7919 + 1);
    const adj = buildCirculant(n, k);
    optimize(adj, mmr, rng, maxRounds);
    const cost = sumSq(sosArray(adj, mmr));
    if (!best || cost < best.cost) best = { adj, cost };
  }

  const adj = best!.adj;
  for (let i = 0; i < n; i++) {
    const list = [...adj[i]!].sort((x, y) => mmr[y]! - mmr[x]!).map((j) => ids[j]!);
    let s = 0;
    for (const j of adj[i]!) s += mmr[j]!;
    opponents.set(ids[i]!, list);
    sosOut.set(ids[i]!, s);
  }
  return { opponents, sos: sosOut };
}

export interface ScheduleSummary {
  // Target every player is pulled toward (degree · mean MMR).
  idealSos: number;
  minSos: number;
  maxSos: number;
  spread: number; // max − min
  stdev: number;
}

export function summariseSchedule(result: ScheduleResult, players: SchedulePlayer[], degree = 4): ScheduleSummary {
  const meanMmr = players.reduce((a, p) => a + p.mmr, 0) / players.length;
  const idealSos = degree * meanMmr;
  const vals = [...result.sos.values()];
  const mean = vals.reduce((a, x) => a + x, 0) / vals.length;
  const variance = vals.reduce((a, x) => a + (x - mean) ** 2, 0) / vals.length;
  return {
    idealSos,
    minSos: Math.min(...vals),
    maxSos: Math.max(...vals),
    spread: Math.max(...vals) - Math.min(...vals),
    stdev: Math.sqrt(variance),
  };
}

// The ONE way a set row shows a player's slot: their seed -- unless they're a
// sub-only member, who never held a seed (the stored per-set number is an import
// artifact for them). Keeps the "subs hold no seed" policy consistent everywhere.
export function SeedOrSub({ seed, isSub }: { seed: number; isSub?: boolean }) {
  if (isSub) return <span className="badge" title="Temporary sub — holds no seed">sub</span>;
  return <>#{seed}</>;
}

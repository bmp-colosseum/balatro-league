"use client";

// Per-preset deck/stake WEIGHTS + pool policy (caps, guaranteed minimums) --
// the pieces of src/match-pool.ts's generatePool (weighted sampling,
// maxPerDeck/maxPerStake, guaranteedStakes) that no admin surface wrote
// before this. Sits alongside the existing Decks/Stakes ListEditor cards on
// this page: THOSE control MEMBERSHIP (which decks/stakes are in the pool at
// all, via addDeck/removeDeck/addStake/removeStake); this editor only tilts
// likelihood + adds caps/guarantees within whatever membership those lists
// currently hold, so it renders exactly one row per preset.decks/stakes
// entry -- there is nothing to add/remove here.
//
// A weight of 1 is normal/uniform (the default for every unlisted deck or
// stake); above 1 is more likely, below 1 is rarer, and 0 excludes it from
// the pool entirely (on top of -- not instead of -- removing it from the
// membership list above). Leaving every weight/cap/guarantee at its default
// is exactly today's behavior: unset columns parse to `[]`/`{}`, which
// src/match-pool.ts's generatePool treats identically to no policy at all.
//
// The combo-count line below re-runs the SAME pure feasibility check
// (poolFeasibility, from the shared @/lib/deck-pool-config-core -- synced
// verbatim from the bot's src/deck-pool-config-core.ts) the save action
// authoritatively validates against, so what you see here is what will
// actually be accepted, not a client-only approximation.
import { useState } from "react";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { Input } from "@/components/ui/input";
import { deckDescription, stakeDescription } from "@/lib/balatro-info";
import {
  DEFAULT_POOL_SIZE,
  poolFeasibility,
  type DeckWeight,
  type GuaranteedStake,
  type PoolPolicy,
  type StakeWeight,
} from "@/lib/deck-pool-config-core";
import { savePoolConfig } from "./actions";

function deckWeightRecord(weights: readonly DeckWeight[]): Record<string, number> {
  return Object.fromEntries(weights.map((w) => [w.deck, w.weight]));
}
function stakeWeightRecord(weights: readonly StakeWeight[] | undefined): Record<string, number> {
  return Object.fromEntries((weights ?? []).map((w) => [w.stake, w.weight]));
}
function guaranteeRecord(guarantees: readonly GuaranteedStake[] | undefined): Record<string, number> {
  return Object.fromEntries((guarantees ?? []).map((g) => [g.stake, g.min]));
}

export function PoolPolicyEditor({
  presetId,
  decks,
  stakes,
  deckWeights,
  poolPolicy,
}: {
  presetId: string;
  decks: string[];
  stakes: string[];
  deckWeights: DeckWeight[];
  poolPolicy: PoolPolicy;
}) {
  const [weights, setWeights] = useState<Record<string, number>>(() => deckWeightRecord(deckWeights));
  const [stakeWeights, setStakeWeights] = useState<Record<string, number>>(() => stakeWeightRecord(poolPolicy.stakeWeights));
  const [guaranteedMins, setGuaranteedMins] = useState<Record<string, number>>(() => guaranteeRecord(poolPolicy.guaranteedStakes));
  const [maxPerDeck, setMaxPerDeck] = useState<string>(poolPolicy.maxPerDeck != null ? String(poolPolicy.maxPerDeck) : "");
  const [maxPerStake, setMaxPerStake] = useState<string>(poolPolicy.maxPerStake != null ? String(poolPolicy.maxPerStake) : "");

  const maxPerDeckNum = maxPerDeck === "" ? undefined : Number(maxPerDeck);
  const maxPerStakeNum = maxPerStake === "" ? undefined : Number(maxPerStake);
  const liveDeckWeights: DeckWeight[] = decks.map((d) => ({ deck: d, weight: weights[d] ?? 1 }));
  const liveStakeWeights: StakeWeight[] = stakes.map((s) => ({ stake: s, weight: stakeWeights[s] ?? 1 }));
  const liveGuaranteedStakes: GuaranteedStake[] = stakes
    .filter((s) => (guaranteedMins[s] ?? 0) > 0)
    .map((s) => ({ stake: s, min: guaranteedMins[s]! }));

  const feasibility = poolFeasibility(decks, stakes, liveDeckWeights, DEFAULT_POOL_SIZE, {
    maxPerDeck: maxPerDeckNum,
    maxPerStake: maxPerStakeNum,
    guaranteedStakes: liveGuaranteedStakes,
    stakeWeights: liveStakeWeights,
  });

  return (
    <div className="card">
      <strong>Weights + pool policy</strong>
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Weight <strong>1</strong> is normal (uniform); above 1 is more likely, below 1 is rarer, and{" "}
        <strong>0</strong> excludes it from the pool entirely. Leaving everything at its default is fully uniform
        -- the same behavior as before this feature existed. A league match draws {DEFAULT_POOL_SIZE} combos per pool.
      </p>

      <ActionFlashForm action={savePoolConfig}>
        <input type="hidden" name="id" value={presetId} />

        <div className="flex flex-wrap gap-4" style={{ marginTop: 8 }}>
          <label style={{ display: "block" }}>
            <span className="muted" style={{ fontSize: 12 }}>Max per deck</span>
            <Input
              type="number"
              name="maxPerDeck"
              min={1}
              step={1}
              placeholder="No cap"
              value={maxPerDeck}
              onChange={(e) => setMaxPerDeck(e.target.value)}
              style={{ width: 120, display: "block", marginTop: 2 }}
            />
          </label>
          <label style={{ display: "block" }}>
            <span className="muted" style={{ fontSize: 12 }}>Max per stake</span>
            <Input
              type="number"
              name="maxPerStake"
              min={1}
              step={1}
              placeholder="No cap"
              value={maxPerStake}
              onChange={(e) => setMaxPerStake(e.target.value)}
              style={{ width: 120, display: "block", marginTop: 2 }}
            />
          </label>
        </div>

        <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          <strong>
            {feasibility.enabledDeckCount} deck{feasibility.enabledDeckCount === 1 ? "" : "s"} x{" "}
            {feasibility.enabledStakeCount} stake{feasibility.enabledStakeCount === 1 ? "" : "s"} ={" "}
            {feasibility.maxCombos} possible combo{feasibility.maxCombos === 1 ? "" : "s"}
          </strong>{" "}
          {!feasibility.feasible && (
            <span style={{ color: "var(--danger)" }}>
              Can&apos;t fill a {DEFAULT_POOL_SIZE}-combo pool: {feasibility.reasons.join(" ")}
            </span>
          )}
        </p>

        <div className="grid grid-2" style={{ marginTop: 12 }}>
          <div>
            <strong style={{ fontSize: 13 }}>Deck weights</strong>
            <table className="table-dense">
              <thead>
                <tr>
                  <th>Deck</th>
                  <th>Weight</th>
                </tr>
              </thead>
              <tbody>
                {decks.map((deck) => (
                  <tr key={deck} title={deckDescription(deck) ?? ""}>
                    <td>{deck}</td>
                    <td>
                      <Input
                        type="number"
                        name={`weight_${deck}`}
                        min={0}
                        step="0.1"
                        value={weights[deck] ?? 1}
                        aria-label={`${deck} weight`}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) setWeights((prev) => ({ ...prev, [deck]: v }));
                        }}
                        style={{ width: 72 }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <strong style={{ fontSize: 13 }}>Stake weights + guaranteed minimums</strong>
            <table className="table-dense">
              <thead>
                <tr>
                  <th>Stake</th>
                  <th>Weight</th>
                  <th>Min per pool</th>
                </tr>
              </thead>
              <tbody>
                {stakes.map((stake) => (
                  <tr key={stake} title={stakeDescription(stake) ?? ""}>
                    <td>{stake}</td>
                    <td>
                      <Input
                        type="number"
                        name={`stakeWeight_${stake}`}
                        min={0}
                        step="0.1"
                        value={stakeWeights[stake] ?? 1}
                        aria-label={`${stake} weight`}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) setStakeWeights((prev) => ({ ...prev, [stake]: v }));
                        }}
                        style={{ width: 72 }}
                      />
                    </td>
                    <td>
                      <Input
                        type="number"
                        name={`guarantee_${stake}`}
                        min={0}
                        step={1}
                        value={guaranteedMins[stake] ?? 0}
                        aria-label={`${stake} guaranteed minimum`}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v >= 0) setGuaranteedMins((prev) => ({ ...prev, [stake]: v }));
                        }}
                        style={{ width: 56 }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <SubmitButton>Save weights + policy</SubmitButton>
        </div>
      </ActionFlashForm>
    </div>
  );
}

// Public reference page: how Balatro Multiplayer (ranked ruleset) differs from
// vanilla Balatro. Faithfully transcribes the community doc "Balatro Multiplayer
// Changes" by SurCats + the BMP dev team (current for v0.3.3) so league players
// have it on the site instead of buried in a spreadsheet.
//
// Content is sourced verbatim-in-spirit from that doc; keep numbers/mechanics
// exact when editing. Same static-guide shape as /how-to-play and /traits.

import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import { Sprite } from "@/components/Sprite";

export const dynamic = "force-static";

export const metadata = {
  title: "Multiplayer changes — Balatro League",
  description:
    "How Balatro Multiplayer's ranked ruleset differs from vanilla Balatro: the shop queue, consumables, jokers, packs, and more.",
  // Unlisted for now: reachable by direct URL but kept out of nav and search
  // engines until SurCats okays republishing the source doc.
  robots: { index: false, follow: false },
};

const SECTIONS: { id: string; label: string }[] = [
  { id: "shop-queue", label: "Shop queue" },
  { id: "consumables", label: "Consumables" },
  { id: "card-modifiers", label: "Card modifiers" },
  { id: "packs", label: "Packs" },
  { id: "decks", label: "Decks" },
  { id: "jokers", label: "Jokers" },
  { id: "skip-tags", label: "Skip tags" },
  { id: "vouchers", label: "Vouchers" },
  { id: "misc", label: "Misc" },
];

export default function ChangesPage() {
  return (
    <>
      <SiteNav activePath="/changes" />
      <main>
        <h2>What&apos;s different in Balatro Multiplayer</h2>
        <p className="muted">
          Multiplayer changes a lot of vanilla Balatro&apos;s mechanics and RNG. This page collects
          those changes for the <strong>ranked ruleset</strong> — what&apos;s exclusive to MP, what&apos;s
          been reworked, and how the shop &ldquo;queues&rdquo; actually work.
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          Sourced from the community doc <em>&ldquo;Balatro Multiplayer Changes&rdquo;</em> by{" "}
          <strong>SurCats</strong> with help from the BMP dev team — current for <strong>v0.3.3</strong>.
          It covers ranked only and doesn&apos;t re-explain unchanged vanilla behavior.
        </p>

        <nav
          className="card"
          style={{
            marginTop: 12,
            marginBottom: 16,
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            position: "sticky",
            top: 0,
            zIndex: 20,
            // Solid background so section content doesn't bleed through while it floats.
            background: "var(--surface)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
          }}
        >
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="pill" style={{ textDecoration: "none" }}>
              {s.label}
            </a>
          ))}
        </nav>

        {/* ============================ SHOP QUEUE ============================ */}
        <Section id="shop-queue" title="The shop queue">
          <p>
            The single most important thing to understand about MP: <strong>the shop is deterministic
            and queue-based.</strong> Both players draw from the same predefined sequences, so the
            <em> order</em> you see, buy, block, and skip things changes what comes next — and what your
            opponent sees too. There are three independent parts of the shop, each with its own queue:
          </p>
          <ul>
            <li><strong>Main shop</strong> — the rerollable part: jokers, tarots, planets, spectrals (Ghost Deck), and playing cards (Magic Trick).</li>
            <li><strong>Pack</strong> portion — the two booster packs.</li>
            <li><strong>Voucher</strong> portion.</li>
          </ul>

          <SubHeading>Part 1 — the main shop queue</SubHeading>
          <p>
            The main shop is one master queue made of <strong>7 sub-queues</strong>. Five are always
            active; two are conditional:
          </p>
          <ul>
            <li>Common joker queue</li>
            <li>Uncommon joker queue</li>
            <li>Rare joker queue</li>
            <li>&ldquo;Up Top&rdquo; tarot queue</li>
            <li>&ldquo;Up Top&rdquo; planet queue</li>
            <li>&ldquo;Up Top&rdquo; spectral queue <span className="muted">(only surfaces on Ghost Deck)</span></li>
            <li>Playing-card queue <span className="muted">(only with the Magic Trick voucher)</span></li>
          </ul>
          <p>
            Every new shop or reroll advances the master queue. Each slot in the master queue points at
            a <em>type</em> (e.g. &ldquo;common joker&rdquo;, &ldquo;spectral&rdquo;); when it comes up, the next item from
            that sub-queue is revealed. So the shop is really &ldquo;take the next item of whatever type the
            master queue says next.&rdquo;
          </p>
          <Callout title="Worked example">
            <p>
              Suppose the master queue reads (CJ = common joker, RJ = rare, T = tarot, P = planet,
              S = spectral, C = playing card), and each sub-queue holds the items shown. On Ghost Deck,
              the shop reads off the top of whatever queue each slot points to:
            </p>
            <QueueExample
              cols={[
                { type: "CJ", item: "Jimbo", sprite: "j_joker" },
                { type: "CJ", item: "Raised Fist", sprite: "j_raised_fist" },
                { type: "S", item: "Hex", note: "Ghost only", sprite: "c_hex" },
                { type: "RJ", item: "Blueprint", sprite: "j_blueprint" },
                { type: "T", item: "The Fool", sprite: "c_fool" },
                { type: "C", item: "A♥" },
                { type: "P", item: "Pluto", sprite: "c_pluto" },
                { type: "S", item: "Ankh", note: "Ghost only", sprite: "c_ankh" },
              ]}
            />
            <p style={{ marginBottom: 0 }}>
              The 3rd slot is a spectral — <em>on Ghost Deck</em> you see a <strong>Hex</strong>; on any
              other deck that slot is skipped and the queue progresses straight to the rare,{" "}
              <strong>Blueprint</strong>.
            </p>
          </Callout>

          <p style={{ marginTop: 14 }}>
            <strong>Blocking shifts the queue.</strong> If something can&apos;t appear — you blocked it, or
            it&apos;s a planet for a hand you haven&apos;t unlocked — that sub-queue simply skips to its next
            item. Roll into an Eris you haven&apos;t unlocked and you get the next planet (Mars) instead.
            Because the playing-card queue only advances when you actually <em>see</em> it, not buying
            Magic Trick means you never consume those entries — they wait for when you do.
          </p>
          <Callout title="Blocking the Blueprint">
            <p style={{ marginBottom: 6 }}>The rare-joker queue holds: Blueprint → Stuntman → …</p>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ textAlign: "center" }}>
                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>You let it through</div>
                <Sprite id="j_blueprint" height={64} />
                <div style={{ fontSize: 11 }}>Blueprint</div>
              </div>
              <div style={{ fontSize: 18, opacity: 0.5 }}>→ block it →</div>
              <div style={{ textAlign: "center" }}>
                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Next rare slides up</div>
                <Sprite id="j_stuntman" height={64} />
                <div style={{ fontSize: 11 }}>Stuntman</div>
              </div>
            </div>
          </Callout>

          <SubHeading>Part 2 — &ldquo;Up Top&rdquo; vs &ldquo;Pack&rdquo; queues</SubHeading>
          <p>
            For tarots, spectrals, and planets there are actually <strong>two</strong> separate queues each:
          </p>
          <ul>
            <li><strong>Up Top</strong> — every consumable created <em>outside</em> a pack (shop slot, jokers like Seance, Purple Seals, Speedrun, etc.) pulls from here.</li>
            <li><strong>Pack</strong> — only progresses when you open a pack of that type.</li>
          </ul>
          <Callout title="Soul &amp; Black Hole">
            <p>
              The Soul (and Black Hole) have their own game-long queue of mostly misses. Every consumable
              created when you open a tarot/spectral pack rolls the Soul queue; on a hit, the consumable
              queue is pushed back one and the Soul is inserted. In practice: open a Mega Arcana Pack and
              successfully <em>tarot-block twice</em> and the Soul appears among your options. So holding
              the right tarots can be the difference between seeing the Soul or not.
            </p>
          </Callout>

          <SubHeading>The packs queue</SubHeading>
          <p>
            Separately from the per-type pack queues, there is a single game-long <strong>&ldquo;packs&rdquo; queue</strong>
            {" "}— the sequence of which <em>boosters</em> appear. It only advances when you see shops. The
            payoff: <strong>skipping a blind doesn&apos;t cost you packs.</strong> If you skip a shop and your
            opponent doesn&apos;t, you&apos;ll just see those same packs one blind later than they did.
          </p>

          <SubHeading>Part 3 — the voucher queue</SubHeading>
          <p>
            The voucher queue is a game-long list of numbers <strong>1–16</strong> (yes — even though there
            are 32 vouchers). Each entry tries to spawn the matching <strong>Tier 1</strong> voucher; if you
            already bought it, the <strong>Tier 2</strong> spawns instead; if you own both, the queue skips
            ahead and repeats. Voucher tags advance this queue the same way seeing a new ante does — except
            if two identical vouchers would appear back-to-back, the second is skipped.
          </p>
        </Section>

        {/* ============================ CONSUMABLES ============================ */}
        <Section id="consumables" title="Consumables">
          <Entry name="Asteroid" tag="MP exclusive" sprite="c_mp_asteroid">
            Delevels your nemesis&apos;s highest-level poker hand. On a tie it delevels in reverse hand
            order (Flush Five → Flush House → … → High Card). It can only hit hands your nemesis has
            unlocked.
          </Entry>
          <Entry name="Justice" tag="Banned" sprite="c_justice">
            Banned in ranked. This doesn&apos;t ban Glass — you can still get Glass from Standard Packs and
            the Familiar / Grim / Incantation spectrals (see Card Modifiers for Glass&apos;s changes).
          </Entry>
          <Entry name="Ouija" tag="Reworked" sprite="c_mp_ouija_standard">
            Reworked to destroy 3 random cards and convert the rest to a single random rank. The hand-size
            reduction is removed.
          </Entry>
          <Entry name="Aura" tag="Order" sprite="c_aura">
            Works on a game-long queue — same as vanilla.
          </Entry>
          <Entry name="Wraith" tag="Order" sprite="c_wraith">
            Shares a game-long queue with Rare skip tags. This queue does <strong>not</strong> take from the
            shop; the only way to advance it is taking Rare skips or Wraiths.
          </Entry>
          <Entry name="Judgement" tag="Order" sprite="c_judgement">
            On <strong>Orange Stake+</strong> it pulls jokers from its own separate queue. On lower stakes it
            takes the next joker from the shop queue.
          </Entry>
        </Section>

        {/* ============================ CARD MODIFIERS ============================ */}
        <Section id="card-modifiers" title="Card modifiers">
          <Entry name="Glass" tag="Reworked">
            <p>
              Even with Justice banned, Glass is still available (Standard Packs / Familiar / Grim /
              Incantation). It now gives <strong>1.5× mult</strong> on trigger instead of vanilla&apos;s 2×.
            </p>
            <p>
              Glass breaks run on a <strong>game-long queue</strong> read left-to-right that doesn&apos;t care
              how the hand is ordered or which cards are Glass. If the break queue is
              <code> Ok · Break · Ok · Break · …</code>, then in a hand the 1st glass card to score is &ldquo;ok&rdquo;,
              the 2nd breaks, and so on — regardless of position or seal.
            </p>
          </Entry>
          <Entry name="Lucky" tag="Order">
            Runs on two game-long queues — one for the 1/5 mult chance, one for the 1/15 $20 chance. Same
            as vanilla.
          </Entry>
          <Entry name="Purple Seal" tag="Order">
            Pulls from the Up Top tarot queue.
          </Entry>
        </Section>

        {/* ============================ PACKS ============================ */}
        <Section id="packs" title="Packs">
          <Entry name="Giga Standard" tag="MP exclusive">
            An Orange-Deck-exclusive pack: 10 standard cards, choose 4. It&apos;s <strong>unskippable</strong> —
            you must take 4.
          </Entry>
          <Entry name="Arcana / Celestial / Spectral packs" tag="Order">
            Each takes from its consumable&apos;s <strong>Pack</strong> queue (see the shop-queue section).
          </Entry>
          <Entry name="Buffoon packs" tag="Order">
            Take directly from the shop queue: Normal takes the next 2 jokers, Jumbo/Mega the next 4.
          </Entry>
          <Entry name="Standard packs" tag="Order">
            Pull from a game-long playing-card queue that&apos;s <em>separate</em> from the Magic Trick card
            queue. Opening order matters: a Normal then a Jumbo can strand cards you wanted that you&apos;d
            have gotten opening them the other way around.
          </Entry>
        </Section>

        {/* ============================ DECKS ============================ */}
        <Section id="decks" title="Decks">
          <Entry name="Orange Deck" tag="MP exclusive">
            Start with a <strong>Giga Standard Pack</strong> and <strong>2 copies of The Hanged Man</strong>.
          </Entry>
          <Entry name="Purple Deck" tag="MP exclusive">
            <strong>+1 voucher slot</strong>, and during Ante 1 vouchers are <strong>50% off</strong>.
          </Entry>
        </Section>

        {/* ============================ JOKERS ============================ */}
        <Section id="jokers" title="Jokers">
          <SubHeading>Multiplayer-exclusive</SubHeading>
          <p className="muted">
            Many MP jokers revolve around the PvP blind and your &ldquo;nemesis.&rdquo; Most send a Phantom
            (a copy visible to your opponent) and many are Blueprint-compatible.
          </p>
          <Entry name="Pacifist · Taxes · Skip Off" tag="MP exclusive" sprite={["j_pacifist", "j_taxes", "j_mp_skip_off"]}>
            Work as described in-game. Pacifist and Taxes are Blueprint-compatible; check Skip Off in the
            collection for its tech.
          </Entry>
          <Entry name="Defensive Joker" tag="MP exclusive" sprite="j_mp_defensive_joker">
            Shrinks whenever your opponent loses a life to a blind — so on higher stakes it can be optimal
            to throw a round to shrink your nemesis&apos;s Defensive. Blueprint-compatible.
          </Entry>
          <Entry name="Conjoined Joker" tag="MP exclusive" sprite="j_conjoined_joker">
            Scales off how many hands your opponent has left. No effect outside the PvP blind (and none if
            your nemesis has played all their hands) — but outside the blind you can read it to learn how
            many hands your nemesis has. Sends a Phantom; Blueprint-compatible.
          </Entry>
          <Entry name="Pizza" tag="MP exclusive" sprite="j_pizza">
            At the end of a PvP, Pizza is consumed and grants you +2 discards and your nemesis +1, lasting
            until the next ante. Copying it with Blueprint/Brainstorm consumes the Blueprint/Brainstorm.
            Sends a Phantom.
          </Entry>
          <Entry name="Let&apos;s Go Gambling" tag="MP exclusive" sprite="j_lets_go_gambling">
            Runs on two game-long queues: one for your hits (advances every hand you play) and one for your
            nemesis&apos;s hits (advances for every hand you play in the PvP blind). Sends a Phantom;
            Blueprint-compatible.
          </Entry>
          <Entry name="Penny Pincher" tag="MP exclusive" sprite="j_penny_pincher">
            Can only appear after Ante 2 — roll into one earlier and it&apos;s skipped (queue progresses).
            Pays 1/3 of what your nemesis spent in the previous ante&apos;s blind shop.
          </Entry>
          <Entry name="Speedrun" tag="MP exclusive" sprite="j_speedrun">
            On readying up for PvP, generates a spectral (from the Up Top spectral queue) — as long as your
            nemesis didn&apos;t ready up first this ante, or you ready within 30s of them. Sends a Phantom;
            Blueprint-compatible.
          </Entry>

          <SubHeading>Banned in ranked</SubHeading>
          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
            {["j_chicot", "j_matador", "j_mr_bones", "j_luchador"].map((s) => (
              <Sprite key={s} id={s} height={56} />
            ))}
          </div>
          <p>
            <BannedPill>Chicot</BannedPill> <BannedPill>Matador</BannedPill>{" "}
            <BannedPill>Mr. Bones</BannedPill> <BannedPill>Luchador</BannedPill>
          </p>
          <p className="muted">Banned for how they interact with the PvP blind.</p>

          <SubHeading>Vanilla jokers, changed</SubHeading>
          <Entry name="Hanging Chad" tag="Reworked" sprite="j_mp_hanging_chad">
            Retriggers the first <strong>two</strong> cards once each, rather than the first card twice —
            forcing more than one good card in your deck and nerfing photo-chad.
          </Entry>
          <Entry name="Bean" tag="Reworked" sprite="j_mp_turtle_bean">
            Starts at <strong>4 hand size</strong> instead of 5, reducing the edge of finding it after your
            opponent.
          </Entry>
          <Entry name="Seltzer" tag="Reworked" sprite="j_mp_seltzer">
            Starts at <strong>8 hands</strong> instead of 10, for the same reason.
          </Entry>
          <Entry name="Golden Ticket" tag="Reworked" sprite="j_ticket">
            Now <strong>Uncommon</strong> (was Common), gives <strong>$3</strong> (was $4), and no longer
            needs a gold card in your deck to appear in the shop.
          </Entry>
          <Entry name="Idol" tag="Reworked" sprite="j_idol">
            <p>
              Idol sorts your deck from the cards you have the <strong>most</strong> duplicates of to the
              fewest (ties broken by suit, then rank; Ace is low), then rolls <strong>1–1000</strong> and
              selects a card by that position. Crucially, <em>both players roll the same number</em> — so
              the better-stacked your deck, the more reliably Idol hits your most-common card.
            </p>
            <p className="muted">
              This lets you read your opponent: if your Idol hits your most-common card, your nemesis&apos;s
              very likely hit too; if it hits the last card in your sorted deck, theirs almost certainly
              missed unless their deck is perfectly stacked.
            </p>
            <Callout title="Same roll, different hit">
              <p style={{ marginBottom: 6 }}>
                Both decks sorted most-common → least. Say the roll lands on <strong>position 5</strong>:
              </p>
              <div style={{ marginBottom: 8 }}>
                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                  Player 1 — loosely stacked (pos 5 = 2♣, <em>not</em> their most-common)
                </div>
                <CardRow
                  items={["K♥", "K♥", "5♥", "5♥", "2♣", "2♣", "7♠", "A♠", "3♣", "4♦"]}
                  highlight={4}
                />
              </div>
              <div>
                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                  Player 2 — tightly stacked (pos 5 = JD, still in their top group)
                </div>
                <CardRow
                  items={["6♣", "6♣", "6♣", "J♦", "J♦", "3♥", "3♥", "4♠", "8♥", "A♣"]}
                  highlight={4}
                />
              </div>
              <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
                Same number rolled for both — but the player who stacked their deck better gets the more
                valuable hit. (Sort order: most copies → suit → rank; Ace is low.)
              </p>
            </Callout>
          </Entry>
          <Entry name="Bloodstone" tag="Reworked" sprite="j_mp_bloodstone">
            <p>
              Runs on two queues. A <strong>game-long</strong> queue advances every time you play a heart
              outside PvP. A separate <strong>PvP queue</strong> resets to the start after every hand you
              play in the PvP blind, and changes each ante.
            </p>
            <p className="muted">
              Resetting the PvP queue per hand means two players whose &ldquo;big&rdquo; hand triggers Bloodstone
              the same number of times get the same number of hits — even if one plays with 3 hands left
              and the other with 0.
            </p>
            <Callout title="PvP queue resets each hand">
              <p style={{ marginBottom: 6 }}>
                Say the ante&apos;s PvP queue is <code>1 1 0 0 1 0 0 1 0 1 1 1 1 1 1</code>{" "}
                (1 = hit, 0 = miss):
              </p>
              <BitQueue bits="110010010111111" used={7} />
              <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
                A hand that triggers Bloodstone <strong>7 times</strong> consumes the first 7 (
                <strong>3 hits</strong>), then the queue <strong>resets to the start</strong> — so the next
                hand that triggers 7 times also gets exactly 3. Both players&apos; equal-size hands score
                identically regardless of hands left.
              </p>
            </Callout>
          </Entry>
          <Entry name="Invisible Joker" tag="Reworked" sprite="j_invisible">
            <p>
              Reworked to cut variance between players. On sell, each joker is given a position by type
              (copies sorted by recency get unique positions) and Invisible copies the joker at the
              rightmost position.
            </p>
            <p>
              If both players hold the same jokers, Invisible copies the same one. If player 1 has one
              <em> extra</em> joker, their Invisible has a <strong>1/n</strong> chance to copy that extra
              one and otherwise copies what player 2 copies. Adding a joker can only ever change the pick
              <em> to the newly added joker</em> — never reshuffle the rest.
            </p>
          </Entry>
          <Entry name="Superposition · Vagabond · Cartomancer" tag="Order">
            Work as expected; their tarots come from the Up Top tarot queue.
          </Entry>
          <Entry name="8-Ball · Business Card · Gros Michel · Space Joker · Hallucination · Cavendish" tag="Order">
            One game-long queue each, advancing every time the joker triggers (8-Ball and Hallucination use
            the Up Top tarot queue). Procs roll 0–1 and hit if ≤ the joker&apos;s odds; <strong>Oops! All 6s</strong>
            {" "}doubles the threshold (e.g. 8-Ball 0.25 → 0.5, Hallucination 0.5 → 1).
          </Entry>
          <Entry name="Seance · Sixth Sense" tag="Order">
            Take their spectrals from the Up Top spectral queue.
          </Entry>
          <Entry name="Riff-Raff · Top Up Tag" tag="Order">
            Share one queue that does <strong>not</strong> take from the shop — so they can hand you common
            jokers your nemesis will never see.
          </Entry>
          <Entry name="To Do List" tag="Order">
            Mechanically vanilla (just synced across Mac/Windows). It picks a hand type by dividing 0–1 into
            equal ranges per unlocked hand type, in order — so if you have 5-of-a-kind unlocked and your
            nemesis doesn&apos;t, a 5-of-a-kind hit for you guarantees them a Straight Flush.
          </Entry>
        </Section>

        {/* ============================ SKIP TAGS ============================ */}
        <Section id="skip-tags" title="Skip tags">
          <Entry name="Boss Reroll Tag" tag="Banned">
            Banned for its interaction with the PvP blind.
          </Entry>
          <Entry name="Foil · Holographic · Polychrome · Negative tags" tag="Order">
            Work as expected (apply the edition to your next joker / give a Negative joker).
          </Entry>
          <Entry name="Charm · Meteor · Standard · Spectral tags" tag="Order">
            Act as if you opened a pack of that type and pull from that type&apos;s Pack queue (including Giga
            Standard on Orange Deck).
          </Entry>
          <Entry name="Rare Tag" tag="Order">
            Shares a game-long queue with Wraith that does not take from the shop — only Rare skips and
            Wraiths advance it.
          </Entry>
          <Entry name="Uncommon Tag" tag="Order">
            Has its own game-long uncommon-joker queue, separate from the shop. Taking Uncommon skips is the
            only way to advance it — an extra shot at an Idol, Dusk, or Mime your nemesis will never see.
          </Entry>
          <Entry name="Voucher Tag" tag="Order">
            Advances the voucher queue the same way seeing a new ante does.
          </Entry>
          <Entry name="Riff-Raff · Top Up Tag" tag="Order">
            Same shared off-shop queue as noted under Jokers.
          </Entry>
          <Entry name="Orbital Tag" tag="Order">
            Only change is Mac/Windows standardization — can still desync if players have different hands
            unlocked.
          </Entry>
        </Section>

        {/* ============================ VOUCHERS ============================ */}
        <Section id="vouchers" title="Vouchers">
          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
            {["v_directors_cut", "v_retcon", "v_hieroglyph", "v_petroglyph"].map((s) => (
              <Sprite key={s} id={s} height={56} />
            ))}
          </div>
          <p>
            <BannedPill>Director&apos;s Cut</BannedPill> <BannedPill>Retcon</BannedPill>{" "}
            <BannedPill>Hieroglyph</BannedPill> <BannedPill>Petroglyph</BannedPill>
          </p>
          <p className="muted">Banned for how they interact with the PvP blind and gameplay generally.</p>
          <p>
            No voucher&apos;s effect is changed from vanilla — but <em>when</em> vouchers appear is governed by
            the voucher queue (see the shop-queue section).
          </p>
        </Section>

        {/* ============================ MISC ============================ */}
        <Section id="misc" title="Misc">
          <Entry name="Hand smoothing" tag="Order">
            Vanilla&apos;s ante-based draws become <strong>round-based</strong> instead, making draws slightly
            more consistent between players. A small, hard-to-measure change.
          </Entry>
        </Section>

        <p style={{ marginTop: 24, textAlign: "center", fontSize: 12 }} className="muted">
          Text: <strong>&ldquo;Balatro Multiplayer Changes&rdquo;</strong> by SurCats &amp; the BMP dev team.
          {" "}Card art from <em>Balatro</em> (LocalThunk), extracted for the Antelytics viewer.
        </p>
        <p style={{ marginTop: 4, textAlign: "center" }}>
          <Link href="/how-to-play">→ How the league works</Link>
        </p>
      </main>
    </>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="card" id={id} style={{ marginTop: 12, scrollMarginTop: 72 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {children}
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h4 style={{ marginBottom: 4, marginTop: 20 }}>{children}</h4>;
}

// One reworked/exclusive item with a colored tag.
const TAG_STYLE: Record<string, { bg: string; fg: string }> = {
  "MP exclusive": { bg: "rgba(52,152,219,0.15)", fg: "#3498db" },
  Reworked: { bg: "rgba(241,196,15,0.15)", fg: "#f1c40f" },
  Banned: { bg: "rgba(231,76,60,0.15)", fg: "#e74c3c" },
  Order: { bg: "rgba(155,89,182,0.15)", fg: "#9b59b6" },
};

function Entry({
  name,
  tag,
  sprite,
  children,
}: {
  name: string;
  tag: keyof typeof TAG_STYLE;
  sprite?: string | string[];
  children: React.ReactNode;
}) {
  const t = TAG_STYLE[tag] ?? TAG_STYLE.Order!;
  const sprites = sprite ? (Array.isArray(sprite) ? sprite : [sprite]) : [];
  return (
    <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "flex-start" }}>
      {sprites.length > 0 && (
        <div style={{ display: "flex", gap: 2, flexShrink: 0, paddingTop: 2 }}>
          {sprites.map((s) => (
            <Sprite key={s} id={s} height={52} />
          ))}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <strong>{name}</strong>
          <span
            className="pill"
            style={{ background: t.bg, color: t.fg, fontSize: 11, padding: "1px 8px" }}
          >
            {tag}
          </span>
        </div>
        <div className="muted" style={{ marginTop: 2 }}>{children}</div>
      </div>
    </div>
  );
}

function Callout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderLeft: "3px solid var(--border, #444)",
        background: "rgba(255,255,255,0.03)",
        borderRadius: 4,
      }}
    >
      <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.6 }}>{title}</div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

function BannedPill({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="pill"
      style={{ background: "rgba(231,76,60,0.15)", color: "#e74c3c", fontSize: 12, marginRight: 4 }}
    >
      {children}
    </span>
  );
}

// A row of "queue slot → shop item" columns, for the shop-queue example.
function QueueExample({ cols }: { cols: { type: string; item: string; note?: string; sprite?: string }[] }) {
  return (
    <div style={{ display: "flex", gap: 8, overflowX: "auto", padding: "6px 0" }}>
      {cols.map((c, i) => (
        <div
          key={i}
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, minWidth: 60 }}
        >
          <span
            className="pill"
            style={{ fontSize: 10, padding: "1px 7px", background: "rgba(155,89,182,0.18)", color: "#9b59b6" }}
          >
            {c.type}
          </span>
          <span style={{ fontSize: 14, opacity: 0.35, lineHeight: 1 }}>↓</span>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "6px",
              fontSize: 11,
              textAlign: "center",
              background: "var(--surface-2)",
              minWidth: 58,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
            }}
          >
            {c.sprite ? <Sprite id={c.sprite} height={48} /> : null}
            <span>{c.item}</span>
            {c.note ? <div className="muted" style={{ fontSize: 9 }}>{c.note}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// A row of card/joker chips; suits colored, an optional highlighted index.
function CardRow({ items, highlight }: { items: string[]; highlight?: number }) {
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {items.map((it, i) => {
        const isCard = /[♥♦♠♣]/.test(it);
        const red = /[♥♦]/.test(it);
        const on = i === highlight;
        return (
          <span
            key={i}
            style={{
              border: on ? "2px solid var(--accent)" : "1px solid var(--border)",
              borderRadius: 4,
              padding: on ? "3px 7px" : "4px 8px",
              fontSize: 12,
              fontWeight: isCard ? 600 : 400,
              color: red ? "#e74c3c" : "var(--text)",
              background: on ? "rgba(241,196,15,0.14)" : "var(--surface-2)",
            }}
          >
            {it}
          </span>
        );
      })}
    </div>
  );
}

// A row of 1/0 queue cells: ✓ = hit (green), · = miss; first `used` are
// marked as consumed (accent border, full opacity).
function BitQueue({ bits, used }: { bits: string; used?: number }) {
  return (
    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
      {bits.split("").map((b, i) => {
        const hit = b === "1";
        const consumed = used !== undefined && i < used;
        return (
          <span
            key={i}
            title={consumed ? "this hand" : undefined}
            style={{
              width: 22,
              height: 26,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 700,
              border: consumed ? "2px solid var(--accent)" : "1px solid var(--border)",
              background: hit ? "rgba(46,204,113,0.18)" : "rgba(255,255,255,0.03)",
              color: hit ? "#2ecc71" : "var(--muted)",
              opacity: consumed ? 1 : 0.5,
            }}
          >
            {hit ? "✓" : "·"}
          </span>
        );
      })}
    </div>
  );
}

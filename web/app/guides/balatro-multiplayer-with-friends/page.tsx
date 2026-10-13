// Public guide: how to actually get Balatro Multiplayer running and play a
// friend -- the one page on the site written for someone who has never
// heard of Balatro League yet and just searched "balatro play with
// friends" / "balatro multiplayer". Per the SEO plan's Tier 2 item 2
// (.claude/knowledge/seo/01-audit-and-plan.md), it hooks into the league at
// the end rather than leading with it. Mod facts below (platform support,
// the official launcher, lobby/invite flow, ruleset names) were verified
// live against github.com/Balatro-Multiplayer/BalatroMultiplayer and
// balatromp.com/balatromp.com/docs on 2026-10-13 -- not written from
// training data, since a mod's install flow changes often.

import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import { JsonLd } from "@/components/JsonLd";
import { breadcrumbJsonLd, faqJsonLd } from "@/lib/json-ld";
import { absoluteUrl, pageMetadata } from "@/lib/seo";

const TITLE = "How to Play Balatro Multiplayer With Friends (2026 Guide)";
const PATH = "/guides/balatro-multiplayer-with-friends";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description:
    "Balatro has no official multiplayer, but the community Balatro Multiplayer mod adds it. How to install it, set up a lobby, invite a friend, and then join a structured season in Balatro League.",
  path: PATH,
});

// Visible FAQ content -- kept as one array so the on-page H3 list and the
// FAQPage JSON-LD below are built from the exact same text (lib/json-ld.ts's
// faqJsonLd never gets a markup answer the reader can't also read on the
// page).
const FAQ: { question: string; answer: string }[] = [
  {
    question: "Is Balatro Multiplayer cross-platform?",
    answer:
      "Yes, between Windows, Mac, and Linux (including Steam Deck) -- it's a PC mod, so it doesn't run on consoles or mobile.",
  },
  {
    question: "Is it free?",
    answer: "Yes. The mod, the Discord community, and Balatro League are all free to use and join.",
  },
  {
    question: "How long does a Balatro League season run?",
    answer:
      "A few weeks -- organizers set the exact length each season, and it's posted when sign-ups open. See How it works for the current one.",
  },
  {
    question: "Do I need to be good at Balatro to join the league?",
    answer:
      "No. New signups are placed in a division by rating, so you play people around your own level, and promotion/relegation moves you as you improve.",
  },
  {
    question: "What if my opponent doesn't show up for a scheduled match?",
    answer: "Report it in the league's Discord server and an organizer will sort it out.",
  },
];

export default function PlayWithFriendsGuidePage() {
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Balatro League", url: absoluteUrl("/") },
          { name: TITLE, url: absoluteUrl(PATH) },
        ])}
      />
      <JsonLd data={faqJsonLd(FAQ)} />
      <SiteNav activePath={PATH} />
      <main>
        <div className="card">
          <h1>How to play Balatro multiplayer with friends</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Balatro doesn&apos;t ship with official multiplayer, but the community{" "}
            <a href="https://github.com/Balatro-Multiplayer/BalatroMultiplayer" target="_blank" rel="noreferrer">
              Balatro Multiplayer
            </a>{" "}
            mod adds real-time matches against another player. Here&apos;s how to get it running and invite a friend.
          </p>
        </div>

        <section className="card">
          <h2>What you need</h2>
          <p>
            Balatro Multiplayer is a community-made mod, not an official feature -- it runs on the PC version of
            the game (Windows, Mac, or Linux, including Steam Deck) through two underlying mod tools,{" "}
            <strong>Steamodded</strong> and <strong>Lovely Injector</strong>. You don&apos;t need to install those
            two yourself: the mod&apos;s site,{" "}
            <a href="https://balatromp.com/" target="_blank" rel="noreferrer">
              balatromp.com
            </a>
            , has an official launcher that installs Lovely, Steamodded, and the multiplayer mod together, with
            download links for each platform. Run the launcher, let it install everything, and it also handles
            switching mod versions later if you ever need to. (There&apos;s a manual install path too, documented
            on{" "}
            <a href="https://balatromp.com/docs" target="_blank" rel="noreferrer">
              balatromp.com/docs
            </a>
            , for anyone who&apos;d rather install Lovely and Steamodded by hand.)
          </p>
        </section>

        <section className="card">
          <h2>Setting up a lobby and inviting a friend</h2>
          <p>Once the mod is installed and Balatro launches with it active:</p>
          <ol style={{ margin: "8px 0", paddingLeft: 20, display: "grid", gap: 6 }}>
            <li>Open the Multiplayer menu and create a lobby, picking a ruleset and your preferred stake.</li>
            <li>Press <strong>View Code</strong> to get a short, shareable lobby code.</li>
            <li>Send that code to your friend (Discord DM works fine).</li>
            <li>They open Multiplayer, choose <strong>Join Lobby</strong>, and enter the code.</li>
            <li>Once everyone&apos;s in, the host starts the match.</li>
          </ol>
          <p className="muted">
            If you don&apos;t have a specific friend to invite yet, the mod also has public matchmaking queues
            that pair you with another player automatically instead of a private lobby.
          </p>
        </section>

        <section className="card">
          <h2>Rulesets and stakes in brief</h2>
          <p>
            A lobby&apos;s host picks a ruleset when creating it. <strong>Ranked Queue</strong> runs rebalanced
            cards and jokers for competitive play; <strong>Vanilla Queue</strong> keeps the original game balance
            with a seed synced for both players; <strong>Smallworld</strong> restricts everyone to a smaller slice
            of the card pool for faster, scrappier runs. There are a few other named formats too (Sandbox,
            Badlatro, Traditional), plus fully custom lobbies with whatever options you want. Independent of the
            ruleset, the host also sets Balatro&apos;s own built-in <strong>stake</strong> -- the game&apos;s
            normal difficulty ladder -- same as a solo run.
          </p>
        </section>

        <section className="card">
          <h2>Then join the league</h2>
          <p>
            Playing one match with a friend is the whole mod in miniature -- a <strong>Balatro League</strong>{" "}
            season is that same mod, structured: you&apos;re placed in a division of similarly-rated players,
            given a fixed set of opponents (or a full round robin in smaller divisions) over a few weeks, and you
            report results as you go. Finish well and you&apos;re promoted to a harder division next season;
            finish poorly and you drop down. See{" "}
            <Link href="/how-it-works">how it works</Link> for the full rundown, or go straight to{" "}
            <Link href="/join">join the league</Link> to sign up for the next season. If you&apos;d rather play on
            a drafted team with conferences and playoffs instead of solo, the sister event is the{" "}
            <a href="https://tour.balatroleague.com/" target="_blank" rel="noreferrer">
              Pizza Power Team Tour
            </a>
            .
          </p>
        </section>

        <section className="card">
          <h2>FAQ</h2>
          <div style={{ display: "grid", gap: 14, marginTop: 8 }}>
            {FAQ.map((item) => (
              <div key={item.question}>
                <h3 style={{ margin: 0 }}>{item.question}</h3>
                <p className="muted" style={{ marginTop: 4 }}>{item.answer}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}

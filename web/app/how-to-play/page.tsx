// Onboarding page for new (and returning) players: the signup → divisions →
// playing → reporting → end-of-season loop. Admin-only while it's a work in
// progress — non-admins get a 404 so it doesn't surface until it's ready.

import Link from "next/link";
import { notFound } from "next/navigation";
import { hasTier } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { WipBanner } from "@/components/WipBanner";

// Must be dynamic to read the session for the admin gate (was force-static).
export const dynamic = "force-dynamic";

export const metadata = {
  title: "How to play — Balatro League",
  robots: { index: false, follow: false },
};

export default async function HowToPlayPage() {
  if (!(await hasTier("ADMIN"))) notFound();
  return (
    <>
      <SiteNav activePath="/how-to-play" />
      <main>
        <WipBanner note="Draft onboarding guide — not shown to players yet." />
        <h2>How to play</h2>
        <p className="muted">
          A short guide to the Balatro League round-robin format. Skim it once and you're
          set for the season.
        </p>

        <Section title="1. Sign up">
          <p>
            Find the <strong>signup post</strong> in the league's Discord and click <strong>Sign up</strong>.
            Signups open for a window before each season; if you miss it, you can still subscribe
            for a DM next time on your{" "}
            <Link href="/me">profile page</Link>.
          </p>
          <p className="muted">
            Tip: link your <a href="https://balatromp.com" target="_blank" rel="noopener">balatromp.com</a> account by playing a ranked game with the same Discord ID — your MMR
            is used to seed you into a fair division.
          </p>
        </Section>

        <Section title="2. Get assigned a division">
          <p>
            When signups close, an admin builds the season. You'll be placed into a{" "}
            <strong>division</strong> of 4–8 players in a tier matching your skill (Common → Legendary).
            Your division gets a private Discord channel and a role mention so you can find each other.
          </p>
          <p>
            Check{" "}
            <Link href="/standings">/standings</Link> any time to see who's in your division and what the
            current scoreboard looks like.
          </p>
        </Section>

        <Section title="3. Play your matches">
          <p>
            You play <strong>every other person in your division once</strong>, best-of-2 games. Schedule
            in your division channel or via DM — whatever works.
          </p>
          <p>
            Two ways to start a match:
          </p>
          <ul>
            <li>
              <code>/start-match @opponent</code> in your division channel — the bot opens a private
              thread, runs the deck/stake ban + pick flow, and tracks the series for you.
            </li>
            <li>
              Just play in Balatro multiplayer (any pool you both agree on) and report the result
              when you're done.
            </li>
          </ul>
          <p className="muted">
            Each best-of-2 is one match: <strong>2-0 win = 3 pts</strong>, <strong>1-1 draw = 1 pt</strong>,{" "}
            <strong>0-2 loss = 0 pts</strong>.
          </p>
        </Section>

        <Section title="4. Report the result">
          <p>
            Two equivalent paths — pick whichever's easier:
          </p>
          <ul>
            <li>
              <strong>Discord:</strong> <code>/report @opponent result:2-0|1-1|0-2</code> in <code>#bot-commands</code>.
            </li>
            <li>
              <strong>Web:</strong> the dedicated{" "}
              <Link href="/report">/report page</Link>.
            </li>
          </ul>
          <p>
            <strong>Discord <code>/report</code></strong> posts a Confirm + Dispute prompt to{" "}
            <strong>#results</strong> tagging your opponent. If they don't react within{" "}
            <strong>2 minutes</strong>, the result auto-confirms — so don't sweat slow opponents.
          </p>
          <p>
            <strong>Web /report</strong> records the result immediately and posts it to{" "}
            <strong>#results</strong>; your opponent gets a Discord DM with a dispute link if the score
            is wrong.
          </p>
          <p className="muted">
            Disputes spawn a public thread under <strong>#results</strong> where the staff helpers mediate.
            Be civil; screenshots help a lot.
          </p>
        </Section>

        <Section title="5. End of season">
          <p>
            Once everyone's played their full round-robin, the standings card shows a{" "}
            <span className="pill" style={{ background: "rgba(46,204,113,0.15)", color: "#2ecc71", fontSize: 11 }}>✅</span>.
            The top of each division <strong>promotes</strong> (↑ green) and the bottom{" "}
            <strong>relegates</strong> (↓ red) into the next season's bracket.
          </p>
          <p>
            Tied at a promotion or relegation slot? You'll see a{" "}
            <span style={{ color: "#f1c40f" }}>⚔</span> next to every tied player. Play a quick{" "}
            <strong>shootout</strong> (single best-of) to settle who moves; a helper records it with{" "}
            <code>/report-shootout</code>.
          </p>
        </Section>

        <Section title="Need help?">
          <p>
            Ping <code>@League Helper</code> or <code>@League Admin</code> in your division channel,
            or use the in-Discord <code>/feedback</code> command to send a bug report or suggestion straight
            to the dev. We're a small league — questions are welcome.
          </p>
        </Section>

        <p style={{ marginTop: 24, textAlign: "center" }}>
          <Link href="/standings">→ See current standings</Link>
        </p>
      </main>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {children}
    </section>
  );
}

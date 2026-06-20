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
          The round-robin format in a nutshell.
        </p>

        <Section title="1. Sign up">
          <p>
            Find the <strong>signup post</strong> in Discord and click <strong>Sign up</strong>.
            Miss the window? Subscribe for a DM next time on your{" "}
            <Link href="/me">profile</Link>.
          </p>
          <p className="muted">
            Tip: play a ranked game on <a href="https://balatromp.com" target="_blank" rel="noopener">balatromp.com</a> with the same Discord ID. Your MMR helps seed you fairly.
          </p>
        </Section>

        <Section title="2. Get a division">
          <p>
            When the season starts you're put in a <strong>division</strong> with its own Discord channel.
            Check <Link href="/standings">/standings</Link> any time.
          </p>
        </Section>

        <Section title="3. Play your matches">
          <p>
            Play your <strong>assigned opponents</strong> — <strong>2 games</strong> each (top divisions play everyone; most play 4 others). Run <code>/schedule</code> in Discord to see your matchups; arrange each however works.
          </p>
          <p>
            Run <code>/start-match @opponent</code> in your channel and the bot handles the ban/pick flow. Or just play in Balatro and report after.
          </p>
          <p className="muted">
            Each match: <strong>2-0 = 3 pts</strong>, <strong>1-1 = 1 pt</strong>, <strong>0-2 = 0 pts</strong>.
          </p>
        </Section>

        <Section title="4. Report the result">
          <p>
            Two ways:
          </p>
          <ul>
            <li>
              <strong>Discord:</strong> <code>/report @opponent result:2-0|1-1|0-2</code>.
            </li>
            <li>
              <strong>Web:</strong> the <Link href="/report">/report page</Link>.
            </li>
          </ul>
          <p>
            Either way it posts to <strong>#results</strong> and your opponent can dispute. On Discord, no reaction within <strong>2 minutes</strong> auto-confirms, so don't sweat slow opponents.
          </p>
        </Section>

        <Section title="5. End of season">
          <p>
            Top of each division <strong>moves up</strong> (↑), bottom <strong>moves down</strong> (↓) next season.
          </p>
          <p>
            Tied at a promotion or relegation slot? You'll see a{" "}
            <span style={{ color: "#f1c40f" }}>⚔</span> next to each tied player. Play a quick <strong>showdown</strong> to settle it.
          </p>
        </Section>

        <Section title="Need help?">
          <p>
            Ping <code>@League Helper</code> in your channel, or use <code>/feedback</code> in Discord.
            We're a small league — questions are welcome.
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

// /how-it-works -- public explainer for how the league runs, start to
// finish. Renders the SAME structured content the bot DMs first-timers
// (src/onboarding-guide.ts -> web/lib/onboarding-guide.ts, mirrored by
// web/scripts/sync-schema.mjs) so the page and the DM never disagree on
// wording. Season-specific bits (label, dates) come from the active season,
// same derivation as the DM (src/onboarding-dm.ts); with no active season
// the shared content degrades to its own evergreen fallback text.

import { SiteNav } from "@/components/SiteNav";
import { loadHowItWorksPageData } from "@/lib/loaders/how-it-works";
import { discordMarkdownToHtml } from "@/lib/discord-markdown";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "How it works - Balatro League",
};

export default async function HowItWorksPage() {
  const { content, supportChannelUrl } = await loadHowItWorksPageData();

  return (
    <>
      <SiteNav activePath="/how-it-works" />
      <main>
        <div className="card howto-hero">
          <p className="howto-eyebrow">{content.title}</p>
          <h1>How it works</h1>
          <p className="muted">Everything you need to know about how the league runs, start to finish.</p>
        </div>

        {content.sections.map((section) => (
          <section key={section.id} id={section.id} className="card howto-section">
            <h3>
              {section.heading}
              {section.headingPunctuation === "?" ? "?" : ""}
            </h3>
            {/* Shared guide bodies carry a tiny sliver of Discord markdown
                (**bold**, <url>) -- discordMarkdownToHtml converts and
                HTML-escapes it; see web/lib/discord-markdown.ts. */}
            <p dangerouslySetInnerHTML={{ __html: discordMarkdownToHtml(section.body) }} />
          </section>
        ))}

        <section className="card howto-section" id="report-a-problem">
          <h3>Something wrong with a result?</h3>
          <p>
            Press <strong>Report a problem</strong> on the result post in Discord,{" "}
            {supportChannelUrl ? (
              <>
                open a ticket in the{" "}
                <a href={supportChannelUrl} target="_blank" rel="noopener noreferrer">
                  support channel
                </a>
                ,
              </>
            ) : (
              "open a ticket in the support channel,"
            )}{" "}
            or DM <strong>Chrono</strong>.
          </p>
        </section>
      </main>
    </>
  );
}

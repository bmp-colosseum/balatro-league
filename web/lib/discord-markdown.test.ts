import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { discordMarkdownToHtml } from "./discord-markdown.js";

describe("discordMarkdownToHtml", () => {
  it("converts **bold** to <strong>", () => {
    expect(discordMarkdownToHtml("**Standings.** Full standings")).toBe(
      "<strong>Standings.</strong> Full standings",
    );
  });

  it("converts a suppressed Discord link <url> to an anchor", () => {
    expect(discordMarkdownToHtml("Full standings for every division: <https://balatroleague.com/standings>")).toBe(
      'Full standings for every division: <a href="https://balatroleague.com/standings" target="_blank" rel="noopener noreferrer">balatroleague.com/standings</a>',
    );
  });

  it("handles multiple bold spans and a link in one string, matching a real onboarding-guide section", () => {
    const input =
      "Click **Help** at the bottom of your division channel, ask in the support channel (<https://discord.com/channels/1/2>), or DM **Chrono**, who runs the league. Good luck out there!";
    expect(discordMarkdownToHtml(input)).toBe(
      'Click <strong>Help</strong> at the bottom of your division channel, ask in the support channel (<a href="https://discord.com/channels/1/2" target="_blank" rel="noopener noreferrer">open in Discord</a>), or DM <strong>Chrono</strong>, who runs the league. Good luck out there!',
    );
  });

  it("escapes stray HTML-special characters in plain text (never breaks out of the markup)", () => {
    expect(discordMarkdownToHtml("5 < 10 & 10 > 5 \"quoted\" it's fine")).toBe(
      "5 &lt; 10 &amp; 10 &gt; 5 &quot;quoted&quot; it&#39;s fine",
    );
  });

  it("escapes HTML-special characters inside a bold span too", () => {
    expect(discordMarkdownToHtml("**<script>alert(1)</script>**")).toBe(
      "<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>",
    );
  });

  it("passes plain text through unchanged (no markdown tokens)", () => {
    expect(discordMarkdownToHtml("A season usually runs about two weeks.")).toBe(
      "A season usually runs about two weeks.",
    );
  });

  it("leaves an unmatched single '<' that isn't a suppressed link as escaped text", () => {
    expect(discordMarkdownToHtml("a < b and this is plain text")).toBe("a &lt; b and this is plain text");
  });

  it("round-trips every onboarding-guide section body for both supportChannelUrl states without throwing", () => {
    // Exercises the converter against the real content it ships with,
    // not just hand-picked examples -- a dynamic import keeps this test
    // from depending on web/lib's build order relative to the bot sync.
    return import("./onboarding-guide.js").then(({ buildOnboardingGuideSections }) => {
      for (const supportChannelUrl of [null, "https://discord.com/channels/1/2"]) {
        const content = buildOnboardingGuideSections({
          seasonLabel: "Season 7",
          seasonWindowLines: [],
          standingsUrl: "https://balatroleague.com/standings",
          supportChannelUrl,
        });
        for (const section of content.sections) {
          const html = discordMarkdownToHtml(section.body);
          expect(html).not.toContain("**");
          expect(typeof html).toBe("string");
        }
      }
    });
  });

  it("property: never contains a literal '**' or a bare '<url>' token after conversion", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("plain ", "**bold** ", "<https://example.test/x> ")), (parts) => {
        const input = parts.join("");
        const html = discordMarkdownToHtml(input);
        expect(html).not.toContain("**");
        expect(html).not.toMatch(/<https?:\/\//);
      }),
    );
  });
});

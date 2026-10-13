import { describe, expect, it } from "vitest";
import { breadcrumbJsonLd, organizationJsonLd, websiteJsonLd } from "./json-ld";

// "Valid JSON" here means: every value survives a JSON.stringify/JSON.parse round
// trip unchanged (no undefined, no function, no circular ref) -- the actual escaping
// of "<" for the browser is JsonLd.tsx's job, not this pure layer's.
function roundTrips(x: unknown): boolean {
  return JSON.parse(JSON.stringify(x)) !== undefined && JSON.stringify(JSON.parse(JSON.stringify(x))) === JSON.stringify(x);
}

describe("websiteJsonLd", () => {
  it("has the required @context/@type/name/url fields", () => {
    const ld = websiteJsonLd({ name: "Balatro League", url: "https://balatroleague.com" });
    expect(ld).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Balatro League",
      url: "https://balatroleague.com",
    });
    expect(roundTrips(ld)).toBe(true);
  });
});

describe("organizationJsonLd", () => {
  it("omits sameAs entirely when not given", () => {
    const ld = organizationJsonLd({
      name: "Balatro League",
      url: "https://balatroleague.com",
      logo: "https://balatroleague.com/og-image.png",
    });
    expect(ld).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Balatro League",
      url: "https://balatroleague.com",
      logo: "https://balatroleague.com/og-image.png",
    });
    expect("sameAs" in ld).toBe(false);
    expect(roundTrips(ld)).toBe(true);
  });

  it("includes sameAs as a one-element array when a Discord invite is given", () => {
    const ld = organizationJsonLd({
      name: "Balatro League",
      url: "https://balatroleague.com",
      logo: "https://balatroleague.com/og-image.png",
      sameAs: "https://discord.gg/example",
    });
    expect(ld.sameAs).toEqual(["https://discord.gg/example"]);
    expect(roundTrips(ld)).toBe(true);
  });
});

describe("breadcrumbJsonLd", () => {
  it("numbers positions from 1 in the given order", () => {
    const ld = breadcrumbJsonLd([
      { name: "Standings", url: "https://balatroleague.com/standings" },
      { name: "Legendary", url: "https://balatroleague.com/divisions/abc" },
    ]);
    expect(ld).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Standings", item: "https://balatroleague.com/standings" },
        { "@type": "ListItem", position: 2, name: "Legendary", item: "https://balatroleague.com/divisions/abc" },
      ],
    });
    expect(roundTrips(ld)).toBe(true);
  });

  it("handles a single-item list (still >= 2 required by Google in practice, but the builder itself is a pure function of its input)", () => {
    const ld = breadcrumbJsonLd([{ name: "Standings", url: "https://balatroleague.com/standings" }]);
    expect((ld.itemListElement as unknown[]).length).toBe(1);
  });

  it("handles an empty list without throwing", () => {
    const ld = breadcrumbJsonLd([]);
    expect(ld.itemListElement).toEqual([]);
    expect(roundTrips(ld)).toBe(true);
  });
});

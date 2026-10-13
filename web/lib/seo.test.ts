import { describe, expect, it } from "vitest";
import { absoluteUrl, DEFAULT_OG_IMAGE, pageMetadata, SITE_NAME, SITE_URL } from "./seo";

describe("pageMetadata", () => {
  it("sets title/description/canonical from plain inputs", () => {
    const meta = pageMetadata({ title: "Standings", description: "Current standings.", path: "/standings" });
    expect(meta.title).toBe("Standings");
    expect(meta.description).toBe("Current standings.");
    expect(meta.alternates).toEqual({ canonical: "/standings" });
  });

  it("builds an absolute og:url from the site-relative path", () => {
    const meta = pageMetadata({ title: "Standings", description: "d", path: "/standings" });
    expect(meta.openGraph?.url).toBe(`${SITE_URL}/standings`);
  });

  it("defaults the OG/Twitter image to the shared brand card", () => {
    const meta = pageMetadata({ title: "T", description: "d", path: "/x" });
    expect(meta.openGraph?.images).toEqual([{ url: DEFAULT_OG_IMAGE, width: 1200, height: 630 }]);
    expect(meta.twitter?.images).toEqual([DEFAULT_OG_IMAGE]);
  });

  it("accepts a page-specific image override", () => {
    const meta = pageMetadata({ title: "T", description: "d", path: "/x", image: "/custom.png" });
    expect(meta.openGraph?.images).toEqual([{ url: "/custom.png", width: 1200, height: 630 }]);
    expect(meta.twitter?.images).toEqual(["/custom.png"]);
  });

  it("carries the site name and type into openGraph/twitter so a page that only sets one field never loses the others", () => {
    const meta = pageMetadata({ title: "T", description: "d", path: "/x" });
    expect(meta.openGraph?.siteName).toBe(SITE_NAME);
    expect(meta.openGraph?.type).toBe("website");
    expect(meta.twitter?.card).toBe("summary_large_image");
    expect(meta.twitter?.title).toBe("T");
    expect(meta.openGraph?.title).toBe("T");
  });

  it("omits robots by default (indexable)", () => {
    const meta = pageMetadata({ title: "T", description: "d", path: "/x" });
    expect(meta.robots).toBeUndefined();
  });

  it("emits a noindex robots directive, keeping follow true, when noIndex is set", () => {
    const meta = pageMetadata({ title: "piton322", description: "d", path: "/profile/abc", noIndex: true });
    expect(meta.robots).toEqual({ index: false, follow: true });
    // still gets a canonical -- noindex doesn't mean "don't bother with metadata"
    expect(meta.alternates).toEqual({ canonical: "/profile/abc" });
  });

  it("never carries an undefined field into the returned object", () => {
    const meta = pageMetadata({ title: "T", description: "d", path: "/x" });
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
  });
});

describe("absoluteUrl", () => {
  it("prefixes a leading-slash path with the site origin", () => {
    expect(absoluteUrl("/join")).toBe(`${SITE_URL}/join`);
  });

  it("tolerates a path missing its leading slash", () => {
    expect(absoluteUrl("join")).toBe(`${SITE_URL}/join`);
  });
});

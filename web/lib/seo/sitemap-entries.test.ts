import { describe, expect, it } from "vitest";
import { buildSitemapEntries } from "./sitemap-entries";

const SITE_URL = "https://balatroleague.com";

describe("buildSitemapEntries", () => {
  it("prefixes every path with the site origin, preserving input order", () => {
    const entries = buildSitemapEntries(SITE_URL, [{ path: "/standings" }, { path: "/join" }]);
    expect(entries).toEqual([
      { url: "https://balatroleague.com/standings" },
      { url: "https://balatroleague.com/join" },
    ]);
  });

  it("carries lastModified through when given", () => {
    const d = new Date("2026-09-01T00:00:00.000Z");
    const entries = buildSitemapEntries(SITE_URL, [{ path: "/seasons/abc", lastModified: d }]);
    expect(entries).toEqual([{ url: "https://balatroleague.com/seasons/abc", lastModified: d }]);
  });

  it("omits lastModified (not null, not undefined-but-present) when not given", () => {
    const entries = buildSitemapEntries(SITE_URL, [{ path: "/standings" }]);
    expect("lastModified" in entries[0]!).toBe(false);
  });

  it("returns an empty array for an empty input", () => {
    expect(buildSitemapEntries(SITE_URL, [])).toEqual([]);
  });

  it("is a pure function of its inputs -- same input, same output", () => {
    const input = [{ path: "/stats" }, { path: "/traits" }];
    expect(buildSitemapEntries(SITE_URL, input)).toEqual(buildSitemapEntries(SITE_URL, input));
  });

  it("handles a realistic mixed batch -- static paths alongside dated profile paths, same shape app/sitemap.ts builds", () => {
    const lastPlayed = new Date("2026-10-01T00:00:00.000Z");
    const entries = buildSitemapEntries(SITE_URL, [
      { path: "/standings" },
      { path: "/profile/p1", lastModified: lastPlayed },
      { path: "/profile/p2", lastModified: lastPlayed },
    ]);
    expect(entries).toEqual([
      { url: "https://balatroleague.com/standings" },
      { url: "https://balatroleague.com/profile/p1", lastModified: lastPlayed },
      { url: "https://balatroleague.com/profile/p2", lastModified: lastPlayed },
    ]);
  });
});

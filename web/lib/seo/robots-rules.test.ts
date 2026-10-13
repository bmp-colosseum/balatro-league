import { describe, expect, it } from "vitest";
import { buildRobotsRules } from "./robots-rules";

const SITE_URL = "https://balatroleague.com";

describe("buildRobotsRules", () => {
  it("allows everything by default and points at the sitemap", () => {
    const robots = buildRobotsRules(SITE_URL, []);
    expect(robots.rules.userAgent).toBe("*");
    expect(robots.rules.allow).toBe("/");
    expect(robots.sitemap).toBe("https://balatroleague.com/sitemap.xml");
  });

  it("carries the given disallow list through unchanged", () => {
    const disallow = ["/admin", "/me", "/auth", "/report", "/changes", "/api"];
    const robots = buildRobotsRules(SITE_URL, disallow);
    expect(robots.rules.disallow).toEqual(disallow);
  });

  it("does not disallow /profile -- noindex pages must stay crawlable so the per-page noindex tag is seen", () => {
    const disallow = ["/admin", "/me", "/auth", "/report", "/changes", "/api"];
    const robots = buildRobotsRules(SITE_URL, disallow);
    expect(robots.rules.disallow).not.toContain("/profile");
  });

  it("is a pure function of its inputs", () => {
    expect(buildRobotsRules(SITE_URL, ["/admin"])).toEqual(buildRobotsRules(SITE_URL, ["/admin"]));
  });
});

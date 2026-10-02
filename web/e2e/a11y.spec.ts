import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

// Regression guard for the color-contrast audit: axe flagged "serious"
// color-contrast violations on 13 of 15 pages, all traced to the same
// culprit -- the `a` tag's default color (--accent-2, Discord blurple)
// measured 3.4-3.7:1 against the dark page/card backgrounds, under the
// 4.5:1 WCAG AA floor for normal-size text. Fixed by giving text consumers
// a dedicated lighter twin (--accent-2-text) in app/globals.css, leaving
// --accent-2 itself untouched for solid-fill buttons/progress bars (where
// white text on top already clears contrast).
//
// /changes is deliberately excluded: it has its OWN separate contrast issue
// (hardcoded hex category-badge swatches, e.g. "#9b59b6", not the shared
// --accent-2 token) on an admin-only WIP page -- a distinct follow-up, not
// part of this fix.
const PAGES = [
  "/", "/standings", "/players", "/stats", "/hall-of-fame", "/seasons",
  "/traits", "/join", "/how-to-play",
];
const ADMIN_PAGES = ["/admin", "/admin/config", "/admin/results", "/admin/seasons"];

test("public pages have no color-contrast violations", async ({ page }) => {
  for (const path of PAGES) {
    await page.goto(path, { waitUntil: "networkidle" });
    const results = await new AxeBuilder({ page }).withTags(["wcag2aa"]).analyze();
    const violation = results.violations.find((v) => v.id === "color-contrast");
    expect(violation, `${path}: ${JSON.stringify(violation?.nodes.map((n) => n.html))}`).toBeUndefined();
  }
});

test("admin pages have no color-contrast violations", async ({ page }) => {
  await page.request.post("/api/test-auth", { data: { discordId: "e2e-owner", name: "E2E Admin" } });
  for (const path of ADMIN_PAGES) {
    await page.goto(path, { waitUntil: "networkidle" });
    const results = await new AxeBuilder({ page }).withTags(["wcag2aa"]).analyze();
    const violation = results.violations.find((v) => v.id === "color-contrast");
    expect(violation, `${path}: ${JSON.stringify(violation?.nodes.map((n) => n.html))}`).toBeUndefined();
  }
});

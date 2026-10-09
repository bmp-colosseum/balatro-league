import { test, expect, type Page } from "@playwright/test";

// Objective mobile check: at an iPhone-SE width, the page must not scroll
// horizontally. Horizontal overflow = a fixed-width element / un-reflowed grid
// broke the layout. (Wide data tables are handled separately by the global
// .table-scroll rule, and aren't populated in the empty E2E DB anyway — this
// guards the page chrome, forms, and grids.)
const PHONE = { width: 375, height: 812 };

async function expectNoHorizontalOverflow(page: Page, path: string): Promise<void> {
  await page.setViewportSize(PHONE);
  await page.goto(path, { waitUntil: "networkidle" });
  // Let layout settle (async content, fonts, reflow) before measuring so we
  // don't catch a transient mid-render width.
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${path} overflows horizontally by ${overflow}px at 375px`).toBeLessThanOrEqual(3);
}

test("public pages have no horizontal overflow at 375px", async ({ page }) => {
  for (const p of ["/standings", "/stats", "/seasons", "/join"]) {
    await expectNoHorizontalOverflow(page, p);
  }
});

test("admin pages have no horizontal overflow at 375px", async ({ page }) => {
  await page.request.post("/api/test-auth", { data: { discordId: "e2e-owner", name: "E2E Admin" } });
  for (const p of ["/admin", "/admin/audit", "/admin/matches", "/admin/seasons", "/admin/config"]) {
    await expectNoHorizontalOverflow(page, p);
  }
});

// The header used to wrap into three rows below 640px (logo, then the 7
// primary links, then search/settings/login) -- SiteMobileMenu now folds the
// links + settings + login/logout into one labelled "Menu" trigger instead.
// A one-row header stays well under 100px; the old three-row layout measured
// well over 150px at this width.
test("site header is a single row at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/standings", { waitUntil: "networkidle" });
  await page.waitForTimeout(150);
  const box = await page.locator("header").first().boundingBox();
  expect(box?.height, "header should collapse to one row below 640px").toBeLessThan(100);
});

// AdminNav gets the same treatment: every admin link (main + system) is
// reachable from one labelled "Admin menu" trigger below 640px -- nothing
// hidden, per MJ's "every admin page is necessary".
test("admin nav folds every link into one Admin menu trigger at 390px", async ({ page }) => {
  await page.request.post("/api/test-auth", { data: { discordId: "e2e-owner", name: "E2E Admin" } });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/admin", { waitUntil: "networkidle" });
  await page.waitForTimeout(150);
  const trigger = page.getByRole("button", { name: /^Admin menu$/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  // Inbox + the Matches / Messages / Settings groups' children (main) and
  // the System group's children (Activity ... Transcripts). Rules & Settings
  // and Ops are devOps-gated and not visible to a plain test-auth owner
  // without that binding.
  await expect(page.getByRole("menuitem", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Messages" })).toBeVisible();
});

// Visible tap targets under the 44px floor (standings/players/stats tables,
// the mobile standings cards, nav/menu triggers) -- measured the same way as
// the production audit: bounding-box height of every visible interactive
// element at 390px on /standings.
test("no visible tap targets under 44px on /standings at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/standings", { waitUntil: "networkidle" });
  await page.waitForTimeout(150);
  const underCount = await page.evaluate(() => {
    const all = document.querySelectorAll("a, button, summary, [role='button'], input, select, textarea");
    let under = 0;
    for (const el of all) {
      if (!(el instanceof HTMLElement) || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 44) under++;
    }
    return under;
  });
  expect(underCount).toBe(0);
});

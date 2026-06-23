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
  for (const p of ["/admin", "/admin/audit", "/admin/results", "/admin/seasons", "/admin/config"]) {
    await expectNoHorizontalOverflow(page, p);
  }
});

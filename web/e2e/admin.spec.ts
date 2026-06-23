import { test, expect, type Page } from "@playwright/test";

// Authenticate as the league owner via the test-only auth route (no Discord
// OAuth). Sets a forged NextAuth session cookie in the browser context.
async function loginAsAdmin(page: Page): Promise<void> {
  const res = await page.request.post("/api/test-auth", {
    data: { discordId: "e2e-owner", name: "E2E Admin" },
  });
  expect(res.ok()).toBeTruthy();
}

test("admin-gated page redirects anonymous users to sign in", async ({ page }) => {
  await page.goto("/admin/divisions");
  await expect(page).toHaveURL(/\/auth\/signin/);
});

test("WIP pages (/changes, /how-to-play) are admin-only (404 for anon)", async ({ page }) => {
  // Anonymous must not be able to reach them at all — not even by direct URL.
  for (const path of ["/changes", "/how-to-play"]) {
    const res = await page.goto(path);
    expect(res?.status(), `${path} should 404 for anon`).toBe(404);
  }
  // Admin sees them, flagged WIP.
  await loginAsAdmin(page);
  const res = await page.goto("/changes");
  expect(res?.status()).toBe(200);
  await expect(page.getByText(/WIP — admin-only preview/)).toBeVisible();
});

test("⌘K palette hides Admin from anon, shows it to admins", async ({ page }) => {
  // Anonymous — Admin group must not appear.
  await page.goto("/standings");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByPlaceholder("Jump to a page…")).toBeVisible();
  await expect(page.getByRole("option", { name: "Standings" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Dashboard" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Admin — Admin group appears.
  await loginAsAdmin(page);
  await page.goto("/standings");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("option", { name: "Dashboard" })).toBeVisible();
});

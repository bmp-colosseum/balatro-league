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
  await page.goto("/admin/players");
  await expect(page).toHaveURL(/\/auth\/signin/);
});

test("admin can add a player (real end-to-end flow)", async ({ page }) => {
  await loginAsAdmin(page);

  await page.goto("/admin/players");
  await expect(page).toHaveURL(/\/admin\/players/); // not bounced to sign-in
  await expect(page.getByText("Add fake player")).toBeVisible();

  const form = page.locator('form:has(input[placeholder="Alice"])');
  await form.locator('input[name="name"]').fill("E2E Tester");
  await form.getByRole("button", { name: "Add" }).click();

  await expect(page.getByText("E2E Tester")).toBeVisible();
});

test("⌘K palette hides Admin from anon, shows it to admins", async ({ page }) => {
  // Anonymous — Admin group must not appear.
  await page.goto("/standings");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByPlaceholder("Jump to a page…")).toBeVisible();
  await expect(page.getByRole("option", { name: "Standings" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Admin dashboard" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Admin — Admin group appears.
  await loginAsAdmin(page);
  await page.goto("/standings");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("option", { name: "Admin dashboard" })).toBeVisible();
});

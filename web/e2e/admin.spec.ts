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

test("FormSelect (shadcn Select) renders, opens, and submits the chosen value", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto("/admin/players");

  // The Sort filter is a FormSelect (native <select> → Base UI Select that
  // mirrors into a hidden <input name="sort">). It has static options and
  // always renders, so it's a stable end-to-end check that the client
  // component mounts, the styled menu opens, and the mirror actually submits.
  const trigger = page.getByText("Name (A-Z)", { exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();

  // Opening the popup reveals the other options (build alone can't catch a
  // hydration/render break here).
  const option = page.getByText("Rating (high → low)", { exact: true });
  await expect(option).toBeVisible();
  await option.click();

  // Submit the GET filter — the mirrored hidden input must carry the value.
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/sort=rating-desc/);
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
  await expect(page.getByRole("option", { name: "Admin dashboard" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Admin — Admin group appears.
  await loginAsAdmin(page);
  await page.goto("/standings");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("option", { name: "Admin dashboard" })).toBeVisible();
});

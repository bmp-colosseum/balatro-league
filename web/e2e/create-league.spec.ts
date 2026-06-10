import { test, expect, type Page } from "@playwright/test";

// Full "create a league" flow: seed a closed signup round, then drive the admin
// build UI to turn it into a season — exactly the lifecycle an admin runs.

async function loginAsAdmin(page: Page): Promise<void> {
  const res = await page.request.post("/api/test-auth", {
    data: { discordId: "e2e-owner", name: "E2E Admin" },
  });
  expect(res.ok()).toBeTruthy();
}

test("admin builds a season from signups", async ({ page }) => {
  await loginAsAdmin(page);

  // Seed a CLOSED signup round + fake signups (token-gated endpoint).
  const seed = await page.request.post("/api/admin/seed-signups", {
    headers: { Authorization: "Bearer e2e-admin-token-0123456789" },
    data: { count: 12, reset: true },
  });
  expect(seed.ok()).toBeTruthy();
  const { buildPath, count } = await seed.json();
  expect(count).toBe(12);

  // Drive the build UI: open the build page and place the players.
  await page.goto(buildPath);
  await expect(page.getByRole("heading", { name: /build season/i })).toBeVisible();
  await page.getByRole("button", { name: /build season .* place/i }).click();

  // buildSeason redirects to the new season's detail page.
  await expect(page).toHaveURL(/\/seasons\/[a-z0-9]+/);
  await expect(page).toHaveURL(/just-built=1/);
});

import { test, expect } from "@playwright/test";

// Public-surface smoke tests — these run a REAL browser, so they catch the
// "builds fine, crashes on click" class (e.g. the ⌘K cmdk-context crash).

test("standings page renders", async ({ page }) => {
  await page.goto("/standings");
  await expect(page.getByRole("heading", { name: /standings/i })).toBeVisible();
});

test("stats page renders (with the chart container)", async ({ page }) => {
  await page.goto("/stats");
  await expect(page.getByRole("heading", { name: /league stats/i })).toBeVisible();
});

test("⌘K command palette opens and navigates (regression)", async ({ page }) => {
  await page.goto("/standings");
  await page.getByRole("button", { name: "Search" }).click();
  // If the cmdk <Command> context is missing this throws on open.
  const input = page.getByPlaceholder("Jump to a page…");
  await expect(input).toBeVisible();
  await input.fill("stats");
  await page.getByRole("option", { name: "Stats" }).click();
  await expect(page).toHaveURL(/\/stats/);
});

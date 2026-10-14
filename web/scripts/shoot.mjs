#!/usr/bin/env node
// Playwright screenshot + a one-line JSON measurement, for proving a change
// visually without opening a browser by hand. Pairs with verify-env.mjs:
// boot a VERIFY_URL, then shoot whatever paths you changed.
//
// Usage:
//   node scripts/shoot.mjs /standings                       # relative path against VERIFY_URL env
//   node scripts/shoot.mjs http://localhost:54123/standings  # or a full URL
//   node scripts/shoot.mjs /standings --width 390
//   node scripts/shoot.mjs /standings --width 1280 --full --out standings-1280.png
//
// Prints exactly one JSON line to stdout with the measurements an agent
// needs without re-opening the screenshot: overflow (horizontal scroll
// width beyond viewport -- 0 is clean), h1Count, title, canonical link,
// robots meta content, and any console errors the page logged.
//
// Uses this repo's own `playwright` dependency (web/node_modules/playwright,
// already a chromium.launch()-capable package via @playwright/test). If a
// project doesn't have it installed, D:/balatro-team-tour/node_modules/playwright
// is a documented fallback (set PLAYWRIGHT_MODULE_PATH to its absolute path).

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FALLBACK_PLAYWRIGHT = "D:/balatro-team-tour/node_modules/playwright/index.js";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (err) {
    if (process.env.PLAYWRIGHT_MODULE_PATH) {
      return await import(process.env.PLAYWRIGHT_MODULE_PATH);
    }
    console.error(`[shoot] local 'playwright' not resolvable (${err.message}); trying fallback: ${FALLBACK_PLAYWRIGHT}`);
    return await import(FALLBACK_PLAYWRIGHT);
  }
}

function parseArgs(argv) {
  const opts = { width: 1280, height: 900, full: false, out: null, target: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--width") opts.width = Number(argv[++i]);
    else if (a === "--height") opts.height = Number(argv[++i]);
    else if (a === "--full") opts.full = true;
    else if (a === "--out") opts.out = argv[++i];
    else rest.push(a);
  }
  opts.target = rest[0] ?? null;
  return opts;
}

function resolveUrl(target) {
  if (!target) throw new Error("usage: node scripts/shoot.mjs <url-or-path> [--width 390|1280] [--full] [--out file.png]");
  if (/^https?:\/\//.test(target)) return target;
  const base = process.env.VERIFY_URL;
  if (!base) throw new Error("no VERIFY_URL env var set and target isn't a full URL -- pass a full http(s) URL, or export VERIFY_URL first");
  return new URL(target, base).toString();
}

function defaultOutPath(url, width) {
  const u = new URL(url);
  const slug = (u.pathname === "/" ? "home" : u.pathname.replace(/^\//, "").replace(/\//g, "-")) || "home";
  mkdirSync(resolve("shots"), { recursive: true });
  return resolve("shots", `${slug}-${width}.png`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = resolveUrl(opts.target);
  const outPath = opts.out ? resolve(opts.out) : defaultOutPath(url, opts.width);
  mkdirSync(dirname(outPath), { recursive: true });

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(200); // let async content / fonts settle before measuring

  const measurements = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const h1Count = document.querySelectorAll("h1").length;
    const title = document.title;
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;
    const robots = document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null;
    return { overflow, h1Count, title, canonical, robots };
  });

  await page.screenshot({ path: outPath, fullPage: opts.full });
  await browser.close();

  console.log(
    JSON.stringify({
      url,
      width: opts.width,
      full: opts.full,
      out: outPath,
      overflow: measurements.overflow,
      h1Count: measurements.h1Count,
      title: measurements.title,
      canonical: measurements.canonical,
      robots: measurements.robots,
      consoleErrors,
    }),
  );
}

main().catch((err) => {
  console.error(`[shoot] ${err.message}`);
  process.exit(1);
});

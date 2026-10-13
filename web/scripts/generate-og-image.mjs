// Generates public/og-image.png (1200x630) -- the default Open Graph / Twitter Card
// image every page falls back to via lib/seo.ts's DEFAULT_OG_IMAGE, and the
// Organization JSON-LD `logo` (app/layout.tsx). Card Table palette per
// design-system/MASTER.md: felt (#1b443f) ground, panel-2 (#2f4447) card, panel-edge
// (#0d1a1a) hard offset shadow + border, gold (#f1b53a) headline, paper (#f3eee2)
// subhead. Re-run with `node scripts/generate-og-image.mjs` from web/ whenever the
// brand card needs regenerating -- a one-shot build step, not something next build
// runs itself.
//
// Text uses a system sans-serif, not the site's self-hosted Jersey 10 / Silkscreen
// pixel webfonts: embedding a custom font into a rasterized SVG depends on the host's
// font-rendering backend (resvg/librsvg) having that font registered, which isn't
// guaranteed outside this one dev machine, and a one-time committed PNG asset has no
// good way to self-verify that later. A bold system font keeps this script
// reproducible anywhere Node + sharp run.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "..", "public", "og-image.png");

const WIDTH = 1200;
const HEIGHT = 630;

const FELT = "#1b443f";
const FELT_DEEP = "#12302d";
const FELT_LINE = "rgba(255,255,255,0.07)";
const PANEL_2 = "#2f4447";
const PANEL_EDGE = "#0d1a1a";
const GOLD = "#f1b53a";
const PAPER = "#f3eee2";
const PAPER_DIM = "#b8c2bf";

const CARD_X = 80;
const CARD_Y = 115;
const CARD_W = WIDTH - CARD_X * 2;
const CARD_H = HEIGHT - CARD_Y * 2;
const SHADOW_OFFSET = 10;

const svg = `
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="felt" x1="0" y1="0" x2="${WIDTH}" y2="${HEIGHT}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${FELT}" />
      <stop offset="1" stop-color="${FELT_DEEP}" />
    </linearGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#felt)" />

  <!-- Subtle diagonal weave on the felt ground, same idea as the felt-line token on
       the live site (app/globals.css), kept sparse so it reads at OG-card scale. -->
  ${Array.from({ length: 14 }, (_, i) => {
    const x = -200 + i * 110;
    return `<line x1="${x}" y1="${HEIGHT}" x2="${x + 260}" y2="0" stroke="${FELT_LINE}" stroke-width="2" />`;
  }).join("\n  ")}

  <!-- Hard offset shadow, design-system/MASTER.md's shadow recipe: a second rect
       behind the card, offset down. -->
  <rect x="${CARD_X}" y="${CARD_Y + SHADOW_OFFSET}" width="${CARD_W}" height="${CARD_H}" rx="18" fill="${PANEL_EDGE}" />
  <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" rx="18" fill="${PANEL_2}" stroke="${PANEL_EDGE}" stroke-width="3" />

  <text x="${WIDTH / 2}" y="${HEIGHT / 2 - 25}" text-anchor="middle"
        font-family="Arial, 'Segoe UI', sans-serif" font-weight="700" font-size="92"
        fill="${GOLD}" letter-spacing="1">Balatro League</text>
  <text x="${WIDTH / 2}" y="${HEIGHT / 2 + 45}" text-anchor="middle"
        font-family="Arial, 'Segoe UI', sans-serif" font-weight="400" font-size="34"
        fill="${PAPER}">A Balatro multiplayer league on Discord</text>

  <!-- Gold accent rule, echoing the promotion-zone gold stripe on /standings. -->
  <rect x="${WIDTH / 2 - 80}" y="${HEIGHT / 2 + 75}" width="160" height="4" rx="2" fill="${GOLD}" />

  <text x="${WIDTH / 2}" y="${HEIGHT - 60}" text-anchor="middle"
        font-family="Arial, 'Segoe UI', sans-serif" font-weight="400" font-size="22"
        fill="${PAPER_DIM}">balatroleague.com</text>
</svg>
`;

const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes)`);

# Balatro League -- Design System (v2 "Card Table")

Source of truth for the site's look. Mockup that defined it: Season 8 standings
(claude.ai artifact "Balatro League Standings", 2026-10-08). Apply these tokens
and rules to every page; do not invent new colours or type styles per page.

## Identity

The league is a card game played on a table. The site is the table: a dark felt
ground, panels that sit on it like chunky game UI with a hard offset shadow, the
four Balatro rarity colours doing the work of telling tiers apart, and a pixel
display face for names and numbers that matter. Data stays legible first: tables
are the product.

## Tokens (CSS custom properties on `:root`, dark-first, single theme)

| token | value | use |
|---|---|---|
| --felt | #1b443f | page ground |
| --felt-deep | #12302d | sticky bars, footer |
| --felt-line | rgba(255,255,255,.07) | subtle diagonal weave on the ground |
| --panel | #26383a | cards, tables, forms |
| --panel-2 | #2f4447 | panel headers, hover rows, inputs |
| --panel-edge | #0d1a1a | borders and the hard offset shadow |
| --paper | #f3eee2 | primary text |
| --paper-dim | #b8c2bf | secondary text |
| --paper-faint | #7f8f8c | labels, notes, column headers |
| --gold | #f1b53a | champion, promotion zone, focus ring, "you" badge |
| --gold-ink | #2a1d05 | text on gold |
| --common | #1e9bff | Common tier |
| --uncommon | #3cc78f | Uncommon tier, positive lives |
| --rare | #ff6259 | Rare tier, relegation zone, negative lives, destructive |
| --legendary | #bb73d6 | Legendary tier |
| --radius | 10px | panels; 6-8px for buttons/chips |
| --shadow | 0 6px 0 var(--panel-edge), 0 14px 28px rgba(0,0,0,.35) | panels |

Semantic aliases keep the existing names working: `--bg` = felt, `--surface` =
panel, `--surface-2` = panel-2, `--border` = panel-edge, `--text` = paper,
`--muted` = paper-dim, `--accent` = gold, `--danger` = rare, `--success` =
uncommon, `--info` = common, `--admin` keeps its orange. Tailwind/shadcn
`--color-*` variables map onto the same tokens.

## Type

- Display: **Pixelify Sans** 700 (Google Fonts) for h1/h2, division names,
  tier chips, points cells, the "you" badge. Never for body copy.
- Body: **Nunito Sans** 400/600/700 for everything else. 15px base, line-height 1.5.
- Numbers in columns: `font-variant-numeric: tabular-nums`.
- Uppercase labels (table headers, eyebrows): 11px, letter-spacing .8px, paper-faint.
- Headings: `text-wrap: balance`. Scale: h1 clamp(28px, 5vw, 40px); h2 22px; h3 17px.

## Components

- **Panel**: panel bg, 2px panel-edge border, radius 10, --shadow. Header strip
  in panel-2 with a 2px panel-edge bottom border.
- **Button**: display face 15px, 8px radius, 0 4px 0 rgba(0,0,0,.45) shadow,
  presses down 3px on :active. Primary = gold with gold-ink text; secondary =
  panel-2 with paper text; destructive = rare with #0b1b1a text. Link-style
  buttons stay body face.
- **Tier chip**: rarity colour bg, #0b1b1a text, display face 12px uppercase,
  letter-spacing .6px, 5px radius.
- **Standings table**: rank (faint), player (bold, optional italic tiebreak
  note under the name at 11.5px faint), Pts in display face 20px, W-D-L
  (dim, nowrap), Pl, Lives (coloured by sign). Promotion rows get a 4px gold
  inset stripe on the first cell; relegation rows a 4px rare stripe; the last
  row above each line gets a 2px dashed border in that colour. A zone key
  sits under the table. On phones (<=480px) hide W-D-L and Pl.
- **Sticky top bar**: felt-deep, 3px panel-edge bottom border, brand in display
  face with the paper card chip, nav links as pills (active = panel + 3px shadow).
- **Form controls**: panel bg, 2px panel-edge border, 8px radius, 0 4px 0
  panel-edge shadow, gold focus ring (3px, offset 2px).

## Rules

- Semantic colour (promote/relegate/positive/negative) is separate from the tier
  colour of the division being viewed; both can appear on one row.
- No emoji as icons in the UI; use inline SVG (Lucide) or none.
- Hover/transition 150-300ms; respect prefers-reduced-motion.
- Phone first: 16px side gutter, tables scroll inside their own wrapper, the
  page never scrolls sideways.
- Contrast: paper on panel >= 7:1; paper-faint on panel >= 4.5:1; dark ink on
  every rarity colour and on gold >= 4.5:1.

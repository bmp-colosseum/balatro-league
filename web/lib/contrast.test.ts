import { describe, it, expect } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCssColor,
  relativeLuminance,
  contrastRatio,
  alphaBlend,
  compositeStack,
  isLargeText,
  requiredRatio,
  passesContrast,
  contrastRatioFromCss,
  type Rgb,
  type Rgba,
} from "./contrast.js";

const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });
const rgba = (r: number, g: number, b: number, a: number): Rgba => ({ r, g, b, a });

describe("parseCssColor", () => {
  it("parses 6-digit hex", () => {
    expect(parseCssColor("#ff0000")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("parses 3-digit hex (each channel doubled)", () => {
    expect(parseCssColor("#f00")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("parses 8-digit hex (alpha channel)", () => {
    const parsed = parseCssColor("#ff000080");
    expect(parsed?.r).toBe(255);
    expect(parsed?.g).toBe(0);
    expect(parsed?.b).toBe(0);
    expect(parsed?.a).toBeCloseTo(128 / 255, 3);
  });

  it("parses rgb(...) with no alpha as fully opaque", () => {
    expect(parseCssColor("rgb(18, 48, 45)")).toEqual({ r: 18, g: 48, b: 45, a: 1 });
  });

  it("parses rgba(...) with a fractional alpha", () => {
    expect(parseCssColor("rgba(231, 76, 60, 0.15)")).toEqual({ r: 231, g: 76, b: 60, a: 0.15 });
  });

  it("parses a percentage alpha", () => {
    expect(parseCssColor("rgba(231, 76, 60, 15%)")?.a).toBeCloseTo(0.15, 5);
  });

  it("parses the literal 'transparent' as alpha 0", () => {
    expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("returns null for anything it can't parse", () => {
    expect(parseCssColor("currentcolor")).toBeNull();
    expect(parseCssColor("hotpink")).toBeNull();
    expect(parseCssColor("color-mix(in srgb, red 50%, blue)")).toBeNull();
  });

  it("round-trips every byte value through hex parsing", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (r, g, b) => {
          const hex = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
          expect(parseCssColor(hex)).toEqual({ r, g, b, a: 1 });
        },
      ),
    );
  });
});

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance(rgb(0, 0, 0))).toBeCloseTo(0, 6);
    expect(relativeLuminance(rgb(255, 255, 255))).toBeCloseTo(1, 6);
  });

  it("is monotonic along the grey ramp", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 254 }),
        fc.integer({ min: 1, max: 255 }),
        (a, b) => {
          fc.pre(a < b);
          const grey = (v: number) => rgb(v, v, v);
          expect(relativeLuminance(grey(a))).toBeLessThan(relativeLuminance(grey(b)));
        },
      ),
    );
  });
});

describe("contrastRatio", () => {
  it("is exactly 21 for black vs white (WCAG's own worked example)", () => {
    expect(contrastRatio(rgb(0, 0, 0), rgb(255, 255, 255))).toBeCloseTo(21, 2);
  });

  it("is exactly 1 for a color against itself", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (r, g, b) => {
          expect(contrastRatio(rgb(r, g, b), rgb(r, g, b))).toBeCloseTo(1, 6);
        },
      ),
    );
  });

  it("is order-independent (ratio doesn't care which side is 'foreground')", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (r1, g1, b1, r2, g2, b2) => {
          const a = rgb(r1, g1, b1);
          const b = rgb(r2, g2, b2);
          expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
        },
      ),
    );
  });

  it("never returns less than 1", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (r1, g1, b1, r2, g2, b2) => {
          expect(contrastRatio(rgb(r1, g1, b1), rgb(r2, g2, b2))).toBeGreaterThanOrEqual(1);
        },
      ),
    );
  });
});

describe("alphaBlend", () => {
  it("alpha 1 returns the foreground unchanged", () => {
    expect(alphaBlend(rgba(10, 20, 30, 1), rgb(200, 200, 200))).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("alpha 0 returns the background unchanged", () => {
    expect(alphaBlend(rgba(10, 20, 30, 0), rgb(200, 200, 200))).toEqual({ r: 200, g: 200, b: 200 });
  });

  it("clamps an out-of-range alpha into [0, 1]", () => {
    expect(alphaBlend(rgba(10, 20, 30, 5), rgb(200, 200, 200))).toEqual({ r: 10, g: 20, b: 30 });
    expect(alphaBlend(rgba(10, 20, 30, -5), rgb(200, 200, 200))).toEqual({ r: 200, g: 200, b: 200 });
  });

  it("linearly interpolates each channel independently", () => {
    const result = alphaBlend(rgba(0, 100, 200, 0.5), rgb(200, 100, 0));
    expect(result.r).toBeCloseTo(100, 5);
    expect(result.g).toBeCloseTo(100, 5);
    expect(result.b).toBeCloseTo(100, 5);
  });
});

describe("compositeStack", () => {
  it("is a no-op with zero layers", () => {
    expect(compositeStack(rgb(50, 60, 70), [])).toEqual({ r: 50, g: 60, b: 70 });
  });

  it("composites in order, farthest layer first", () => {
    const base = rgb(0, 0, 0);
    const result = compositeStack(base, [rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.5)]);
    // Two successive 50% white layers over black: 50%, then 50% of the
    // remainder -- 0.75 total white, not 1.0 (compositing isn't additive).
    expect(result.r).toBeCloseTo(191.25, 1);
  });

  it("matches a single alphaBlend when given exactly one layer", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (r, g, b, a, br, bg, bb) => {
          const layer = rgba(r, g, b, a);
          const base = rgb(br, bg, bb);
          const viaComposite = compositeStack(base, [layer]);
          const viaBlend = alphaBlend(layer, base);
          expect(viaComposite.r).toBeCloseTo(viaBlend.r, 5);
          expect(viaComposite.g).toBeCloseTo(viaBlend.g, 5);
          expect(viaComposite.b).toBeCloseTo(viaBlend.b, 5);
        },
      ),
    );
  });
});

describe("isLargeText / requiredRatio / passesContrast", () => {
  it.each([
    [24, 400, true],
    [23.9, 400, false],
    [18.66, 700, true],
    [18.65, 700, false],
    [18.66, 400, false],
    [14, 400, false],
    [30, 400, true],
  ])("isLargeText(%spx, weight %s) -> %s", (size, weight, expected) => {
    expect(isLargeText(size, weight)).toBe(expected);
  });

  it("requires 3:1 for large text and 4.5:1 otherwise", () => {
    expect(requiredRatio(true)).toBe(3);
    expect(requiredRatio(false)).toBe(4.5);
  });

  it.each([
    [4.5, false, true],
    [4.49, false, false],
    [3, true, true],
    [2.99, true, false],
  ])("passesContrast(%s, large=%s) -> %s", (ratio, large, expected) => {
    expect(passesContrast(ratio as number, large as boolean)).toBe(expected);
  });
});

describe("contrastRatioFromCss", () => {
  it("matches the WCAG black/white example from two hex strings", () => {
    expect(contrastRatioFromCss("#000000", "#ffffff")).toBeCloseTo(21, 2);
  });

  it("composites a translucent foreground onto the background first", () => {
    // 15%-alpha danger red over the v1 page background, the exact shape of
    // .flash.error's self-tinted badge.
    const direct = contrastRatioFromCss("#e74c3c", "#0f1115");
    const tinted = contrastRatioFromCss("rgba(231, 76, 60, 0.15)", "#0f1115");
    expect(tinted).not.toBeNull();
    expect(direct).not.toBeNull();
    // The tint is much closer to the background than the solid color is,
    // so its contrast against that same background must be lower.
    expect(tinted!).toBeLessThan(direct!);
  });

  it("returns null when either side fails to parse", () => {
    expect(contrastRatioFromCss("not-a-color", "#000000")).toBeNull();
    expect(contrastRatioFromCss("#000000", "not-a-color")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Token-pair regression suite: parses the live design tokens straight out of
// globals.css (both the v1 :root palette and the v2 "Card Table" palette
// nested under html[data-ui="v2"]) and asserts WCAG AA on every text-token x
// surface-token pair this codebase actually renders, per the 2026-10
// contrast audit. A future edit that nudges one of these tokens back under
// threshold fails here instead of shipping silently.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS_PATH = path.resolve(__dirname, "../app/globals.css");
const globalsCss = fs.readFileSync(GLOBALS_CSS_PATH, "utf8");

/** Finds the first top-level `{...}` block following `selector` and returns its inner text. */
function extractBlock(css: string, selector: string): string {
  const startIdx = css.indexOf(selector);
  if (startIdx === -1) throw new Error(`selector not found in globals.css: ${selector}`);
  const braceStart = css.indexOf("{", startIdx);
  if (braceStart === -1) throw new Error(`no opening brace for selector: ${selector}`);
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(braceStart + 1, i);
    }
  }
  throw new Error(`unbalanced braces for selector: ${selector}`);
}

/** Parses every `--name: value;` custom property declared directly in a CSS block (not nested rules). */
function parseTokens(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block))) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

/** Resolves a token value, following `var(--other)` chains within the same merged token map. */
function resolveToken(raw: string, tokens: Record<string, string>, seen: Set<string> = new Set()): string {
  const varMatch = raw.match(/^var\(\s*--([a-zA-Z0-9-]+)\s*\)$/);
  if (!varMatch) return raw;
  const name = varMatch[1];
  if (seen.has(name)) throw new Error(`circular var() reference while resolving --${name}`);
  const next = tokens[name];
  if (next === undefined) throw new Error(`var(--${name}) has no definition in this token map`);
  return resolveToken(next, tokens, new Set(seen).add(name));
}

const rootTokensRaw = parseTokens(extractBlock(globalsCss, ":root {"));
// The v2 block only redeclares the tokens it overrides; everything else
// (e.g. --admin) falls through to :root by the normal CSS cascade, so merge
// :root underneath it before resolving var() chains.
const v2TokensRaw = { ...rootTokensRaw, ...parseTokens(extractBlock(globalsCss, 'html[data-ui="v2"] {')) };

function resolveAll(tokensRaw: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const name of Object.keys(tokensRaw)) {
    resolved[name] = resolveToken(tokensRaw[name], tokensRaw);
  }
  return resolved;
}

const v1 = resolveAll(rootTokensRaw);
const v2 = resolveAll(v2TokensRaw);

describe("globals.css v1 token pairs clear WCAG AA", () => {
  // [text token, surface token, large-text?]
  const pairs: Array<[string, string, boolean?]> = [
    ["text", "bg"], ["text", "surface"], ["text", "surface-2"],
    ["muted", "bg"], ["muted", "surface"], ["muted", "surface-2"],
    ["accent", "bg"], ["accent", "surface"],
    ["accent-2-text", "bg"], ["accent-2-text", "surface"],
    ["danger", "bg"], ["danger", "surface"], ["danger", "surface-2"],
    ["success", "bg"], ["success", "surface"], ["success", "surface-2"],
    ["info", "bg"], ["info", "surface"],
    ["admin", "bg"], ["admin", "surface"],
  ];

  it.each(pairs)("%s on %s", (fgName, bgName, large) => {
    const ratio = contrastRatioFromCss(v1[fgName], v1[bgName]);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThanOrEqual(requiredRatio(Boolean(large)));
  });

  it("admin-ink on admin (the classic-look-on pill) clears 4.5:1", () => {
    const ratio = contrastRatioFromCss(v1["admin-ink"], v1["admin"]);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThanOrEqual(4.5);
  });

  // Dark-ink companions for solid --success/--danger fills with white text
  // on top (admin sweep, 2026-10): the DM-unread-count badges and the
  // "Accept result" confirm button.
  it.each([
    ["success-ink", "success"],
    ["danger-ink", "danger"],
  ])("%s on %s clears 4.5:1", (inkName, fillName) => {
    const ratio = contrastRatioFromCss(v1[inkName], v1[fillName]);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThanOrEqual(4.5);
  });
});

describe("globals.css v2 'Card Table' token pairs clear WCAG AA", () => {
  const pairs: Array<[string, string, boolean?]> = [
    ["text", "bg"], ["text", "surface"], ["text", "surface-2"],
    ["muted", "bg"], ["muted", "surface"], ["muted", "surface-2"],
    ["paper-faint", "bg"], ["paper-faint", "surface"], ["paper-faint", "surface-2"],
    ["accent", "bg"], ["accent", "surface"],
    ["common", "bg"], ["common", "surface"], ["common", "surface-2"],
    ["uncommon", "bg"], ["uncommon", "surface"], ["uncommon", "surface-2"],
    ["rare", "bg"], ["rare", "surface"], ["rare", "surface-2"],
    ["legendary", "bg"], ["legendary", "surface"], ["legendary", "surface-2"],
    ["admin", "bg"], ["admin", "surface"], ["admin", "surface-2"],
  ];

  it.each(pairs)("%s on %s", (fgName, bgName, large) => {
    const ratio = contrastRatioFromCss(v2[fgName], v2[bgName]);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThanOrEqual(requiredRatio(Boolean(large)));
  });

  it("gold-ink on gold (tier chip ink) clears 4.5:1", () => {
    expect(contrastRatioFromCss(v2["gold-ink"], v2["gold"])!).toBeGreaterThanOrEqual(4.5);
  });

  // success-ink/danger-ink aren't re-themed per look, but --success/
  // --danger resolve to --uncommon/--rare here, so re-check the pairing
  // against what it actually composites with under v2.
  it.each([
    ["success-ink", "success"],
    ["danger-ink", "danger"],
  ])("%s on %s clears 4.5:1", (inkName, fillName) => {
    const ratio = contrastRatioFromCss(v2[inkName], v2[fillName]);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["common", "uncommon", "rare", "legendary"])(
    "the dark chip ink (#0b1b1a) clears 4.5:1 on the %s tier fill",
    (tier) => {
      expect(contrastRatioFromCss("#0b1b1a", v2[tier])!).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe("the --flash-*-text tokens clear WCAG AA against their own self-tint", () => {
  // Every `.flash.success`/`.flash.error`-shaped badge in this codebase
  // (plus every ad-hoc inline W/L/DISPUTED/VOID/DROPPED/banned pill that
  // reuses the same recipe -- see --flash-danger-text's comment in
  // globals.css for the full call-site list) draws its background as a
  // translucent tint of a FIXED literal color -- rgba(231,76,60,_),
  // rgba(46,204,113,_), rgba(241,196,15,_), rgba(149,165,166,_) -- never a
  // themed token, over whichever surface the current look puts underneath.
  // --flash-*-text is the token that DOES vary per look. Compositing a
  // color over its own tint shifts the effective background toward that
  // color, which *reduces* contrast -- so this is checked against the
  // actual composited backdrop, not the plain surface, at the highest
  // alpha (0.2) any call site in the app pairs with text color.
  const v1Surfaces = [v1.bg, v1.surface, v1["surface-2"]];
  const v2Surfaces = [v2.bg, v2.surface, v2["surface-2"]];

  function selfTintedBg(tintHex: string, surfaceHex: string, alpha: number): string {
    const tint = parseCssColor(tintHex);
    const surface = parseCssColor(surfaceHex);
    if (!tint || !surface) throw new Error("unparseable color in selfTintedBg");
    const blended = alphaBlend({ ...tint, a: alpha }, surface);
    return `rgb(${blended.r}, ${blended.g}, ${blended.b})`;
  }

  // [flash token, the fixed rgba literal its real-world tint uses -- note
  // the muted tint is rgb(149,165,166) ("#95a5a6"), a plain grey distinct
  // from the --muted TOKEN's own color (#abb3c4 / #b8c2bf); the info tint
  // is rgb(118,199,255) ("#76c7ff"), i.e. --info's own v1 color -- some
  // call sites instead tint with rgb(52,152,219) ("#3498db", the admin
  // sweep's "Returning" pill), a different blue, which --flash-info-text
  // also has to clear (checked separately below since it's not --info's
  // own hue). --accent-2/--accent-2-text aren't re-themed per v2 look, so
  // --flash-accent-2-text only needs one set of ratios, not a v1/v2 pair --
  // it's included in both it.each tables below for simplicity (the v2
  // globals.css override just falls through to the same :root value).]
  const TINTS: Array<[string, string]> = [
    ["flash-danger-text", "#e74c3c"],
    ["flash-success-text", "#2ecc71"],
    ["flash-accent-text", "#f1c40f"],
    ["flash-muted-text", "#95a5a6"],
    ["flash-info-text", "#76c7ff"],
    ["flash-accent-2-text", "#5865f2"],
  ];

  it.each(TINTS)("v1 %s clears 4.5:1 on every page surface at alpha 0.2", (tokenName, tintHex) => {
    for (const surface of v1Surfaces) {
      const bg = selfTintedBg(tintHex, surface, 0.2);
      const ratio = contrastRatioFromCss(v1[tokenName], bg);
      expect(ratio).not.toBeNull();
      expect(ratio!).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(TINTS)("v2 %s clears 4.5:1 on every panel surface at alpha 0.2", (tokenName, tintHex) => {
    for (const surface of v2Surfaces) {
      const bg = selfTintedBg(tintHex, surface, 0.2);
      const ratio = contrastRatioFromCss(v2[tokenName], bg);
      expect(ratio).not.toBeNull();
      expect(ratio!).toBeGreaterThanOrEqual(4.5);
    }
  });

  // components/DraggableRatingTable.tsx's "Returning" status pill tints
  // with rgb(52,152,219) ("#3498db") -- a different blue than --info's own
  // hue -- while still using --flash-info-text for the label. Checked
  // against that specific mismatched tint rather than assuming it's
  // covered by the same-hue cases above.
  it("flash-info-text clears 4.5:1 on the #3498db-tinted 'Returning' pill", () => {
    for (const [tokens, surfaces] of [[v1, v1Surfaces], [v2, v2Surfaces]] as const) {
      for (const surface of surfaces) {
        const bg = selfTintedBg("#3498db", surface, 0.2);
        const ratio = contrastRatioFromCss(tokens["flash-info-text"], bg);
        expect(ratio).not.toBeNull();
        expect(ratio!).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

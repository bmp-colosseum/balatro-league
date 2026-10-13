// Pure WCAG 2.x contrast-ratio core. No DOM, no fs, no network -- takes plain
// color values in, returns plain numbers/booleans out. Any caller that needs
// to resolve an "effective background" (walking ancestors, sampling a
// screenshot) does that in its own shell and calls down into this core with
// plain RGB(A) values.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Rgba extends Rgb {
  a: number;
}

/**
 * Parses a CSS color string into an {r,g,b,a} tuple (0-255 channels, 0-1
 * alpha). Supports `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(...)` and
 * `rgba(...)` -- i.e. every form `getComputedStyle` returns plus every form a
 * hand-written CSS token value takes. Returns null for anything else
 * (named colors, `transparent`, `currentcolor`, gradients, etc.) so callers
 * can decide how to handle the "couldn't parse" case explicitly.
 */
export function parseCssColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();

  if (v === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const rgbaMatch = v.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?))?\s*\)$/,
  );
  if (rgbaMatch) {
    const alphaRaw = rgbaMatch[4];
    const a =
      alphaRaw === undefined
        ? 1
        : alphaRaw.endsWith("%")
          ? Number(alphaRaw.slice(0, -1)) / 100
          : Number(alphaRaw);
    return {
      r: Number(rgbaMatch[1]),
      g: Number(rgbaMatch[2]),
      b: Number(rgbaMatch[3]),
      a,
    };
  }

  const hexMatch = v.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }

  return null;
}

function channelToLinear(channel255: number): number {
  const srgb = channel255 / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an opaque RGB color (0-255 channels). */
export function relativeLuminance(rgb: Rgb): number {
  const r = channelToLinear(rgb.r);
  const g = channelToLinear(rgb.g);
  const b = channelToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque colors; always >= 1. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Composites a (possibly translucent) foreground color over an opaque background. */
export function alphaBlend(fg: Rgba, bg: Rgb): Rgb {
  const a = Math.max(0, Math.min(1, fg.a));
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/**
 * Composites an ordered stack of translucent layers (farthest from the
 * viewer first, i.e. outermost ancestor first) down onto an opaque base,
 * returning the single opaque color a viewer actually sees. Used to resolve
 * an "effective background" by walking an element's ancestor chain from the
 * page root down to its parent.
 */
export function compositeStack(base: Rgb, layers: Rgba[]): Rgb {
  return layers.reduce<Rgb>((acc, layer) => alphaBlend(layer, acc), base);
}

/** WCAG "large text" rule: >= 24px, or >= 18.66px (14pt) and bold (>=700). */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  if (fontSizePx >= 24) return true;
  if (fontSizePx >= 18.66 && fontWeight >= 700) return true;
  return false;
}

/** WCAG 2.x AA threshold for the given text size class. */
export function requiredRatio(large: boolean): number {
  return large ? 3 : 4.5;
}

export function passesContrast(ratio: number, large: boolean): boolean {
  return ratio >= requiredRatio(large);
}

/**
 * Convenience wrapper for the common case: two parseable CSS color strings,
 * background assumed opaque (as every design token in this codebase is).
 * Returns null if either string fails to parse.
 */
export function contrastRatioFromCss(fgCss: string, bgCss: string): number | null {
  const fg = parseCssColor(fgCss);
  const bg = parseCssColor(bgCss);
  if (!fg || !bg) return null;
  const fgOpaque = fg.a < 1 ? alphaBlend(fg, bg) : fg;
  return contrastRatio(fgOpaque, bg);
}

// Pure metadata builder for per-route title / description / Open Graph / Twitter Card /
// canonical data. Mirrors the Team Tour site's lib/seo.ts pageMetadata pattern (same
// problem: links get pasted into Discord constantly, and an unfurl with no title/
// description/image is indistinguishable from any other page). No prisma/react/
// Date.now() here -- callers (generateMetadata / a page's static `metadata` export)
// gather the page's own subject (a player name, a division name) and pass in plain
// strings.
import type { Metadata } from "next";

// Overridable for staging -- same pattern as the sibling Tour's SITE_URL constant.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://balatroleague.com";
export const SITE_NAME = "Balatro League";
export const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png`;

export interface PageMetaInput {
  // The page's subject -- e.g. "Standings", "piton322", "Legendary - Season 9". Root
  // layout's `title.template` ("%s | Balatro League") appends the site name, so this
  // should NOT repeat it.
  title: string;
  description: string;
  // Site-relative path (with a leading slash), e.g. `/divisions/${id}`.
  path: string;
  // Absolute or site-relative image URL; defaults to the shared brand card
  // (public/og-image.png) when a page has nothing more specific to show.
  image?: string;
  // Set true to emit `robots: {index: false}` while still following links from the
  // page and keeping a canonical -- "don't rank this", not "don't bother with
  // metadata". No current page uses this (admin/me/auth/report set their own plain
  // `robots` field instead, since they don't need pageMetadata's OG/Twitter fields
  // at all): player profiles were the one noIndex: true caller until the TO decided
  // (2026-10-13) that indexing them was fine. Kept for the next page that needs it
  // -- see docs/handbook/seo.md.
  noIndex?: boolean;
}

/**
 * Builds title/description/canonical/Open Graph/Twitter Card metadata from one shared
 * shape, so every route authors through the same fields. Next.js REPLACES a parent's
 * openGraph/twitter object wholesale rather than deep-merging it, so a page that only
 * sets `openGraph.title` would silently lose siteName/type/images -- funneling every
 * page through this one function is what keeps that from happening.
 */
export function pageMetadata({ title, description, path, image, noIndex }: PageMetaInput): Metadata {
  const url = `${SITE_URL}${path}`;
  const ogImage = image ?? DEFAULT_OG_IMAGE;
  return {
    title,
    description,
    alternates: { canonical: path },
    ...(noIndex ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      type: "website",
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  };
}

/** A full URL for a site path -- for anywhere a relative link is useless, like a
 *  Discord message or a JSON-LD `url` field. Same base pageMetadata already uses, so
 *  the two cannot disagree. */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

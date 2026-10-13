// Pure JSON-LD builders -- plain data in, a plain schema.org object out. No react/
// next/prisma here; callers (app/layout.tsx, a page's own server component) gather the
// page's subject and feed it in, then render the result through
// <JsonLd data={...} /> (components/JsonLd.tsx), which owns the one browser-facing
// concern (escaping `<` in the serialized script body).
//
// Scope, per the SEO audit (.claude/knowledge/seo/01-audit-and-plan.md section 5):
// WebSite + Organization (cheap, drives the Google-results "site name") and
// BreadcrumbList (desktop rich result on profile/division/season pages). Event/
// SportsEvent and FAQPage markup are deliberately NOT built here -- Google doesn't
// show rich results for either on a site like this (virtual-only events; FAQ rich
// results are government/health-only since 2023).

export interface WebsiteJsonLdInput {
  name: string;
  url: string;
}

export interface OrganizationJsonLdInput {
  name: string;
  url: string;
  logo: string;
  /** Discord invite URL, or any other canonical profile for this org. Omitted
   *  entirely (not emitted as null/empty) when there's nothing to link. */
  sameAs?: string;
}

export interface BreadcrumbItem {
  name: string;
  /** Absolute URL for this crumb. */
  url: string;
}

/** JSON-LD object for a page; always valid JSON (no `undefined` values survive
 *  JSON.stringify, but this type keeps call sites from ever handing one in). */
export type JsonLdObject = Record<string, unknown>;

export function websiteJsonLd({ name, url }: WebsiteJsonLdInput): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name,
    url,
  };
}

export function organizationJsonLd({ name, url, logo, sameAs }: OrganizationJsonLdInput): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name,
    url,
    logo,
    ...(sameAs ? { sameAs: [sameAs] } : {}),
  };
}

export function breadcrumbJsonLd(items: BreadcrumbItem[]): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

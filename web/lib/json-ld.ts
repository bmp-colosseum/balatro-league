// Pure JSON-LD builders -- plain data in, a plain schema.org object out. No react/
// next/prisma here; callers (app/layout.tsx, a page's own server component) gather the
// page's subject and feed it in, then render the result through
// <JsonLd data={...} /> (components/JsonLd.tsx), which owns the one browser-facing
// concern (escaping `<` in the serialized script body).
//
// Scope, per the SEO audit (.claude/knowledge/seo/01-audit-and-plan.md section 5):
// WebSite + Organization (cheap, drives the Google-results "site name") and
// BreadcrumbList (desktop rich result on profile/division/season pages). Event/
// SportsEvent markup is deliberately NOT built here -- Google doesn't show rich
// results for virtual-only online events. faqJsonLd below IS built (the "play with
// friends" guide, app/guides/balatro-multiplayer-with-friends/page.tsx) even though
// the same audit section notes Google retired FAQ rich results for ordinary sites in
// 2023 (government/health-only now) -- the markup still describes the page's real,
// visible Q&A honestly (schema.org doesn't require a rich-result payoff to be valid),
// costs nothing, and is cheap insurance if that policy ever loosens again.

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

export interface FaqItem {
  question: string;
  /** Plain text (or simple HTML -- schema.org's acceptedAnswer.text allows a
   *  small set of formatting tags) matching exactly what the page's visible
   *  FAQ section renders, so the markup never claims an answer the reader
   *  can't also see on the page. */
  answer: string;
}

export function faqJsonLd(items: FaqItem[]): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

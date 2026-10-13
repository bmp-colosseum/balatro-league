// Renders one schema.org JSON-LD block, per Next's own guidance (a <script
// type="application/ld+json"> in layout/page, JSON.stringify'd with "<" escaped so a
// value that happens to contain "</script>" can't break out of the tag). The data
// itself comes from the pure builders in lib/json-ld.ts -- this component owns only
// the one browser-facing concern (serialization + escaping), nothing else.
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}

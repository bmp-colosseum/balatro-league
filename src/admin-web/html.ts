// Minimal tagged-template-literal HTML builder with auto-escaping.
// Marker `raw()` lets the caller opt into NOT escaping when interpolating already-trusted HTML
// (e.g. composed sub-templates). Keeps XSS surface tight by default.

const RAW = Symbol("raw-html");

export interface RawHtml {
  [RAW]: true;
  value: string;
}

export function raw(value: string): RawHtml {
  return { [RAW]: true, value };
}

function isRaw(v: unknown): v is RawHtml {
  return typeof v === "object" && v !== null && (v as { [RAW]?: boolean })[RAW] === true;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (isRaw(value)) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escape(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return raw(out);
}

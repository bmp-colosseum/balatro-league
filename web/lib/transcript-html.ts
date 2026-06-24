// Renders a captured transcript as a self-contained HTML document — viewable on
// its own (open / save / print) and embedded in an iframe on the admin page.
// Built from our captured DB rows (not the live thread), so deleted and edited
// messages are preserved. EVERYTHING user-supplied is HTML-escaped — message
// content, names and filenames are attacker-controlled.

import type { TranscriptHeader, TranscriptMessage } from "@/lib/loaders/transcripts";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function renderTranscriptHtml(header: TranscriptHeader, messages: TranscriptMessage[]): string {
  const rows = messages
    .map((m) => {
      const tags =
        (m.editedAt ? `<span class="tag">edited</span>` : "") +
        (m.deletedAt ? `<span class="tag del">🗑 deleted ${esc(fmt(m.deletedAt))}</span>` : "");
      const original =
        m.editedAt && m.originalContent != null
          ? `<div class="orig"><span class="lbl">original:</span> ${esc(m.originalContent)}</div>`
          : "";
      const atts = m.attachments
        .map((a) => {
          const isImage = !!a.contentType && a.contentType.startsWith("image/");
          const href = `/admin/transcripts/attachment/${a.id}`;
          return isImage
            ? `<a href="${href}" target="_blank"><img class="att" src="${href}" alt="${esc(a.filename)}"></a>`
            : `<a class="file" href="${href}" target="_blank">📎 ${esc(a.filename)}</a>`;
        })
        .join("");
      return `<div class="msg${m.deletedAt ? " deleted" : ""}">
  <div class="meta"><span class="author">${esc(m.authorName)}</span><span class="time">${esc(fmt(m.postedAt))}</span>${tags}</div>
  <div class="body">${esc(m.content) || '<span class="empty">(no text)</span>'}</div>
  ${original}${atts ? `<div class="atts">${atts}</div>` : ""}
</div>`;
    })
    .join("\n");

  const title = `${header.kind === "dispute" ? "Dispute" : "Match"} transcript`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1f2328; background: #fff; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 16px; }
  .hdr { border-bottom: 1px solid #e3e5e8; padding-bottom: 10px; margin-bottom: 14px; }
  .hdr h1 { font-size: 18px; margin: 0 0 6px; }
  .hdr .kv { color: #5c6370; font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 2px 16px; }
  .msg { padding: 8px 10px; border-radius: 6px; margin: 2px 0; }
  .msg:hover { background: #f6f7f9; }
  .msg.deleted { background: #fdf0f0; }
  .meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
  .author { font-weight: 600; }
  .time { color: #8a9099; font-size: 12px; }
  .tag { font-size: 11px; color: #8a9099; border: 1px solid #e3e5e8; border-radius: 4px; padding: 0 5px; }
  .tag.del { color: #b42318; border-color: #f3c0bb; }
  .body { white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
  .msg.deleted .body { text-decoration: line-through; opacity: 0.85; }
  .empty { color: #9aa0a8; font-style: italic; }
  .orig { margin-top: 5px; padding-left: 8px; border-left: 2px solid #e3e5e8; color: #5c6370; font-size: 12.5px; white-space: pre-wrap; }
  .orig .lbl { font-size: 11px; }
  .atts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .att { max-width: 260px; max-height: 260px; border-radius: 6px; border: 1px solid #e3e5e8; display: block; }
  .file { font-size: 13px; color: #3b5bdb; text-decoration: none; }
  .empty-log { color: #9aa0a8; padding: 20px 0; }
</style></head>
<body><div class="wrap">
  <div class="hdr">
    <h1>${esc(title)}</h1>
    <div class="kv">
      <span><b>Players:</b> ${esc(header.participants.join(", ")) || "—"}</span>
      <span><b>Messages:</b> ${header.count}${header.deleted > 0 ? ` (${header.deleted} deleted)` : ""}</span>
      <span><b>Span:</b> ${esc(fmt(header.firstAt))} → ${esc(fmt(header.lastAt))}</span>
      <span><b>Match ID:</b> ${esc(header.matchId ?? "—")}</span>
      <span><b>Thread ID:</b> ${esc(header.threadId)}</span>
    </div>
  </div>
  ${rows || '<div class="empty-log">No messages captured for this thread (it may have been purged).</div>'}
</div></body></html>`;
}

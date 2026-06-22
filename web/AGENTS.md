<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Styling conventions — USE THE DESIGN SYSTEM, don't reinvent it

There is ONE design system, in `web/app/globals.css`. The recurring mess is
pages overriding it with ad-hoc inline styles and hardcoded hex colors. Stop.
When you add UI, reach for the token/class FIRST; inline `style={{}}` is a last
resort for genuine one-offs only.

**Colors → always a token, never a hex literal.** Use the CSS variables from
`globals.css :root`: `--bg`, `--surface`, `--surface-2`, `--border`, `--text`,
`--muted`, `--accent` (gold), `--accent-2` (blue), `--danger` (red),
`--success` (green), `--info` (light blue), `--admin` (amber). In JSX write
`style={{ color: "var(--success)" }}` — NEVER `"#2ecc71"`. Every brand color
has a token; if you need a new one, add it to `:root`, don't inline a hex.

**Cards → `.card` (+ an accent variant), never a bespoke bordered div.**
`<div className="card">`. For a colored border use a variant class —
`card-info` / `card-admin` / `card-success` / `card-danger` / `card-accent` —
NOT inline `style={{ borderColor: "#..." }}`.

**Reach for the shared classes before inline styles:** `.stat` (+ `.label` /
`.value`), `.grid` / `.grid-2` / `.grid-3`, `.pill`, `.muted`, `.table-dense`,
`.table-scroll`, `.responsive-table` (+ `data-label` / `card-header` cells for
the mobile-card layout), `.flash` / `.flash.success` / `.flash.error`. A plain
`<table>` is already styled — don't re-style it.

**Buttons → the components, not raw `<button>`.** `<Button>`
(`@/components/ui/button`) for actions; `<SubmitButton>` for form submits (it
shows a pending "Working…" state); `<ConfirmButton>` for destructive/confirm
actions (confirm prompt + pending). Don't hand-roll or inline-style buttons.
For a tiny inline text affordance (a `+ Add` / `remove` / `done` link inside a
row), use the `.link-action` class + a color token — NOT a `<Button>` (its forced
height/padding won't sit inline).

**Inline `style={{}}` is fine ONLY for true layout one-offs** (a flex `gap`, a
specific `width`/`marginTop`). Colors, card borders, and anything a token or
class already covers must use the token/class so it stays consistent.

import { html, raw, type RawHtml } from "./html.js";

// Nav groups by who can see them.
// PUBLIC always visible. PLAYER only when logged in. ADMIN only when isAdmin.
const PUBLIC_NAV = [
  { href: "/standings", label: "Standings" },
  { href: "/players", label: "Players" },
  { href: "/seasons", label: "Past seasons" },
] as const;
const PLAYER_NAV = [
  { href: "/me", label: "My profile" },
] as const;
const ADMIN_NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/players", label: "Players" },
  { href: "/admin/rankings", label: "Rankings" },
  { href: "/admin/divisions", label: "Divisions" },
  { href: "/admin/signups", label: "Signups" },
  { href: "/admin/seasons", label: "Manage seasons" },
] as const;

const STYLES = `
  :root {
    --bg: #0f1115;
    --surface: #181b22;
    --surface-2: #1f232c;
    --border: #2a2f3a;
    --text: #e6e8ec;
    --muted: #98a0ad;
    --accent: #f1c40f;
    --accent-2: #5865f2;
    --danger: #e74c3c;
    --success: #2ecc71;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
  a { color: var(--accent-2); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 24px; }
  header h1 { margin: 0; font-size: 16px; }
  nav { display: flex; gap: 16px; }
  nav a { color: var(--muted); padding: 4px 8px; border-radius: 4px; }
  nav a.active { color: var(--text); background: var(--surface-2); }
  main { max-width: 1100px; margin: 24px auto; padding: 0 24px; }
  h2 { margin-top: 0; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .grid { display: grid; gap: 16px; }
  .grid-2 { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .grid-3 { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .stat { background: var(--surface-2); padding: 16px; border-radius: 8px; }
  .stat .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat .value { font-size: 28px; font-weight: 600; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  tr:hover { background: var(--surface-2); }
  form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  input, select { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); padding: 8px 10px; border-radius: 4px; font: inherit; }
  input:focus, select:focus { outline: 1px solid var(--accent-2); border-color: var(--accent-2); }
  button { background: var(--accent-2); color: white; border: none; padding: 8px 14px; border-radius: 4px; cursor: pointer; font: inherit; }
  button.danger { background: var(--danger); }
  button.secondary { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); }
  button:hover { filter: brightness(1.1); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .pill.legendary { background: rgba(241, 196, 15, 0.2); color: #f1c40f; }
  .pill.rare { background: rgba(155, 89, 182, 0.2); color: #c79be1; }
  .pill.uncommon { background: rgba(52, 152, 219, 0.2); color: #76c7ff; }
  .pill.common { background: rgba(149, 165, 166, 0.2); color: #c0c8cb; }
  .pill.fake { background: rgba(241, 196, 15, 0.15); color: #f1c40f; }
  .pill.real { background: rgba(46, 204, 113, 0.15); color: #2ecc71; }
  .pill.pending { background: rgba(241, 196, 15, 0.15); color: #f1c40f; }
  .pill.confirmed { background: rgba(46, 204, 113, 0.15); color: #2ecc71; }
  .pill.disputed { background: rgba(231, 76, 60, 0.15); color: #e74c3c; }
  .progress { background: var(--surface-2); border-radius: 99px; height: 6px; overflow: hidden; margin-top: 6px; }
  .progress > div { background: var(--accent-2); height: 100%; transition: width 0.2s; }
  .division-card { display: block; padding: 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; color: var(--text); }
  .division-card:hover { border-color: var(--accent-2); text-decoration: none; }
  .division-card strong { display: block; margin-bottom: 4px; }
  .flash { padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; }
  .flash.success { background: rgba(46, 204, 113, 0.15); color: var(--success); border: 1px solid rgba(46, 204, 113, 0.3); }
  .flash.error { background: rgba(231, 76, 60, 0.15); color: var(--danger); border: 1px solid rgba(231, 76, 60, 0.3); }
  .muted { color: var(--muted); }
`;

export function layout(opts: {
  title: string;
  activePath: string;
  flash?: { kind: "success" | "error"; message: string };
  body: RawHtml;
  sessionUser?: { username: string; avatar: string | null; discordId: string } | null;
  isAdmin?: boolean;
}): RawHtml {
  // Build nav from the groups the caller is allowed to see
  const visibleNav = [
    ...PUBLIC_NAV,
    ...(opts.sessionUser ? PLAYER_NAV : []),
    ...(opts.isAdmin ? ADMIN_NAV : []),
  ];
  const navItems = visibleNav.map(
    (n) => html`<a href="${n.href}" class="${n.href === opts.activePath ? "active" : ""}">${n.label}</a>`,
  );
  const flash = opts.flash
    ? html`<div class="flash ${opts.flash.kind}">${opts.flash.message}</div>`
    : raw("");
  const userArea = opts.sessionUser
    ? html`<span style="margin-left:auto; display:flex; align-items:center; gap:8px">
        <a href="/me" style="color:var(--text)">${opts.sessionUser.username}</a>
        <a href="/auth/logout" class="muted" style="font-size:12px">logout</a>
      </span>`
    : html`<span style="margin-left:auto"><a href="/auth/discord/login" class="muted" style="font-size:12px">Login with Discord</a></span>`;
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${opts.title} · Balatro League</title>
  <style>${raw(STYLES)}</style>
  <script src="https://unpkg.com/htmx.org@2.0.4" defer></script>
</head>
<body>
  <header>
    <h1>🃏 Balatro League</h1>
    <nav>${navItems}</nav>
    ${userArea}
  </header>
  <main>
    ${flash}
    ${opts.body}
  </main>
</body>
</html>`;
}

// Single source of truth for navigation links, shared by the public nav
// (SiteNav), the admin nav (AdminNav), and the ⌘K command palette — so the three
// surfaces never drift (same labels, same destinations). Plain data, importable
// from both server components and the client palette.

export interface NavLink {
  href: string;
  label: string;
  exact?: boolean;
}

// Public primary nav — shown to everyone. (Join / My profile / Admin are
// appended conditionally by SiteNav; they aren't part of the always-on set.)
// "Players" is a sign-in wall for a logged-out visitor (the page itself
// redirects to /auth/signin), so SiteNav drops it from the rendered nav for
// that audience -- it stays in this shared list since the command palette
// still offers it to everyone (clicking it bounces the same way the page
// always has). "Traits" isn't here at all: it's a cosmetic-badges page, not
// a primary-nav destination -- it's linked from the profile's Traits card
// instead (see ProfileView.tsx).
export const PRIMARY_LINKS: NavLink[] = [
  { href: "/standings", label: "Standings" },
  { href: "/players", label: "Players" },
  { href: "/stats", label: "Stats" },
  { href: "/hall-of-fame", label: "Hall of Fame" },
  { href: "/seasons", label: "Seasons" },
];

export interface AdminNavLink extends NavLink {
  devOpsOnly?: boolean;
  // Tucked behind the "System" dropdown in the admin nav (rarely-touched
  // settings / devops tools) rather than the always-visible primary row.
  system?: boolean;
  // Sub-links rendered under this entry via the same disclosure mechanism
  // the "System" dropdown already uses (AdminNav / AdminMobileMenu) -- a
  // group link is a dropdown trigger, not its own destination, so its own
  // `href` is a nominal anchor only (used for the active-state check) and
  // is never itself navigated to.
  children?: AdminNavLink[];
}

// Five top-level admin nav groups plus System, replacing the previous flat
// 29-link / "System" dropdown layout (see
// .claude/knowledge/ux-audit/01-findings.md, "Admin: proposed information
// architecture"). Once-a-season pages (Seasons, Signups, Divisions,
// Standings Preview, Season end, Winners, Season Audit, Role audit, Play
// Times) are intentionally NOT linked here anymore -- they move into the
// Season Tools hub page's own checklist (see
// web/app/admin/season-tools/page.tsx) instead of the nav. Season Audit,
// Role audit and Play Times stay in System too (see below) since they were
// never explicitly reassigned a new nav home; they're reachable both ways.
export const ADMIN_LINKS: AdminNavLink[] = [
  { href: "/admin", label: "Inbox", exact: true },
  {
    href: "/admin/matches",
    label: "Matches",
    children: [
      { href: "/admin/matches", label: "Matches" },
      { href: "/admin/schedule-audit", label: "Data Audit" },
      { href: "/admin/participation", label: "Participation" },
      { href: "/admin/whats-at-stake", label: "At Stake" },
    ],
  },
  { href: "/admin/messages", label: "Messages" },
  { href: "/admin/season-tools", label: "Season tools" },
  {
    href: "/admin/settings",
    label: "Settings",
    children: [
      { href: "/admin/settings", label: "Settings", devOpsOnly: true },
      { href: "/admin/config", label: "Config" },
      { href: "/admin/traits", label: "Traits" },
      { href: "/admin/deck-bans", label: "Deck Bans" },
      { href: "/admin/avoided-pairs", label: "Avoided Pairs" },
      { href: "/admin/bans", label: "Bans" },
      { href: "/admin/players", label: "Players" },
      { href: "/admin/mmr", label: "MMR" },
    ],
  },
  // ── System group (behind the "System" dropdown), devops-only mechanism unchanged ──
  {
    href: "/admin/activity",
    label: "System",
    system: true,
    children: [
      { href: "/admin/activity", label: "Activity" },
      { href: "/admin/play-times", label: "Play Times" },
      { href: "/admin/ops", label: "Ops", devOpsOnly: true },
      { href: "/admin/host", label: "Host" },
      { href: "/admin/roles", label: "Role audit" },
      { href: "/admin/audit", label: "Action log" },
      { href: "/admin/season-audit", label: "Season Audit" },
    ],
  },
];

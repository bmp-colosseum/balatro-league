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
export const PRIMARY_LINKS: NavLink[] = [
  { href: "/standings", label: "Standings" },
  { href: "/players", label: "Players" },
  { href: "/stats", label: "Stats" },
  { href: "/hall-of-fame", label: "Hall of Fame" },
  { href: "/seasons", label: "Seasons" },
  { href: "/traits", label: "Traits" },
];

export interface AdminNavLink extends NavLink {
  devOpsOnly?: boolean;
  // Tucked behind the "System ▾" menu in the admin nav (rarely-touched
  // settings / devops tools) rather than the always-visible primary row.
  system?: boolean;
}

export const ADMIN_LINKS: AdminNavLink[] = [
  { href: "/admin", label: "Dashboard", exact: true },
  { href: "/admin/seasons", label: "Seasons" },
  { href: "/admin/signups", label: "Signups" },
  { href: "/admin/mmr", label: "MMR" },
  { href: "/admin/divisions", label: "Divisions" },
  { href: "/admin/participation", label: "Participation" },
  { href: "/admin/whats-at-stake", label: "At Stake" },
  { href: "/admin/results", label: "Results" },
  { href: "/admin/disputes", label: "Disputes" },
  { href: "/admin/bans", label: "Bans" },
  { href: "/admin/activity", label: "Activity", system: true },
  { href: "/admin/deck-bans", label: "Deck Bans" },
  { href: "/admin/traits", label: "Traits" },
  { href: "/admin/message", label: "Message", system: true },
  // ── System group (behind "System ▾") ──
  { href: "/admin/config", label: "Config", system: true },
  { href: "/admin/settings", label: "Rules & Settings", devOpsOnly: true, system: true },
  { href: "/admin/ops", label: "Ops", devOpsOnly: true, system: true },
  { href: "/admin/audit", label: "Audit", system: true },
  { href: "/admin/schedule-audit", label: "Data Audit", system: true },
  { href: "/admin/transcripts", label: "Transcripts", system: true },
];

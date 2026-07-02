import Link from "next/link";
import { Settings, Fingerprint, Users, Activity, LayoutDashboard, KeyRound } from "lucide-react";
import { getViewer, isAdmin } from "@/lib/auth";
import { hasAnyAccess } from "@/lib/permissions";
import { Callout } from "@/components/Callout";

export const dynamic = "force-dynamic";

// TO-only global nav (dashboard, identity, teams, access, system). Mods/captains reach their
// work through the season hubs, not this bar — so it only renders for OWNER/TO.
const ADMIN_NAV = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/access", label: "Access", icon: KeyRound },
  { href: "/admin/identity", label: "Identity", icon: Fingerprint },
  { href: "/admin/teams", label: "Teams", icon: Users },
  { href: "/admin/env-health", label: "System", icon: Activity },
];

// The shell gates on "has ANY access" (TO, a mod grant, or captaincy). Individual pages gate
// their own capability — TO-only pages still call isAdmin(), delegable ones call can().
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (!(await hasAnyAccess(viewer))) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">You don&apos;t have access to the admin area.</Callout>
      </main>
    );
  }
  const to = await isAdmin();
  return (
    <>
      <div className="admin-bar">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-x-5 gap-y-1 px-6 py-2">
          <span className="admin-badge"><Settings className="size-3.5" /> {to ? "Admin mode" : "Team tools"}</span>
          {to && (
            <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              {ADMIN_NAV.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} className="admin-link inline-flex items-center gap-1.5">
                  <Icon className="size-3.5" /> {label}
                </Link>
              ))}
            </nav>
          )}
        </div>
      </div>
      {children}
    </>
  );
}

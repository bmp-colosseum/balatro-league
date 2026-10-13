// Every /admin/** route is noindex -- these are organiser tools, not public
// content, and most of them 404/redirect for non-admins anyway (see hasTier checks
// throughout app/admin/**). A layout-level `metadata` export applies to every page
// under this segment without touching 33 individual page.tsx files.
import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}

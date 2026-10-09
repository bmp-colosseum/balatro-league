// Legacy route -- merged into /admin/matches (see page.tsx there and
// .claude/knowledge/ux-audit/01-findings.md, "Target: three weekly pages").
// Redirects straight to the Disputed filter, which shows the same inline
// proposal + accept-proposed/keep-original actions this page used to.

import { redirect } from "next/navigation";

export default function LegacyDisputesRedirect() {
  redirect("/admin/matches?status=disputed");
}

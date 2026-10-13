// Shared footer (app/layout.tsx) -- felt-deep band, same recipe as the Tour
// site's own components/SiteFooter.tsx. design-system/MASTER.md /
// .claude/knowledge/ux-cohesion/01-findings.md section b: "Join Discord, Rules
// [How it works, for the League], the other product's link." The Discord
// invite is read from the same admin-configurable LeagueConfig value /join
// already uses (lib/loaders/discord-invite.ts) -- no invite configured, no
// link, rather than a guessed URL.
import Link from "next/link";
import { TOUR_PUBLIC_URL } from "@/lib/tour-profile";

export function SiteFooter({ discordInviteUrl }: { discordInviteUrl: string | null }) {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <p className="muted m-0">
          Balatro League and Pizza Power Team Tour are community-run Balatro Multiplayer events on Discord.
        </p>
        <nav className="site-footer-links" aria-label="Footer">
          {discordInviteUrl && (
            <a href={discordInviteUrl} target="_blank" rel="noreferrer">
              Join Discord
            </a>
          )}
          <Link href="/how-it-works">How it works</Link>
          {/* The league's sibling site -- a real cross-site navigation (two
              separate Next.js apps on two subdomains), so a plain <a>. Full
              name, not just "Team Tour", so the anchor text itself tells a
              crawler (and anyone pasting the link) what's on the other end
              (SEO audit L8, .claude/knowledge/seo/01-audit-and-plan.md). */}
          <a href={TOUR_PUBLIC_URL}>Pizza Power Team Tour</a>
        </nav>
      </div>
    </footer>
  );
}

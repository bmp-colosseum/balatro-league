"use client";

// ⌘K / Ctrl+K command palette, mounted globally in the root layout. Entries are
// filtered to what the viewer can actually use: public pages for everyone,
// logged-in pages once signed in, the Admin group only for admins, and the
// player roster (logged-in only). Permission context is fetched lazily the
// first time the palette opens, so anonymous browsing never sees admin links.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { PRIMARY_LINKS, ADMIN_LINKS } from "@/lib/nav-links";

interface Item {
  label: string;
  href: string;
}

// All three lists derive from the shared nav-links module so the palette never
// drifts from the navs (same labels, same destinations). Palette-only extras
// (Join, Report, the WIP draft pages) are appended explicitly.
const PUBLIC_PAGES: Item[] = [
  ...PRIMARY_LINKS.map((l) => ({ label: l.label, href: l.href })),
  { label: "Join the league", href: "/join" },
  // /how-to-play is still an admin-only WIP draft -- this points at the
  // public "How it works" panel on /join instead so the entry resolves for
  // everyone (see .claude/knowledge/ux-audit/01-findings.md, backlog #33).
  { label: "How to play", href: "/join#how-it-works" },
];

// Require a signed-in session (the pages themselves redirect otherwise).
const AUTHED_PAGES: Item[] = [
  { label: "Report a match", href: "/report" },
  { label: "My profile", href: "/me" },
];

// Mirror the admin nav (minus devOps-only links the palette can't gate without
// extra context), plus the one WIP draft page that lives only here ("How to
// play" moved to PUBLIC_PAGES above, pointing at the public /join anchor). Nav
// entries can be a group (Matches, Messages, Settings, System -- a dropdown
// with `children`, not itself a destination) or a plain link (Inbox, Season
// tools); flatten groups to their children so every individual admin page
// stays searchable here, same as before the nav regroup.
const ADMIN_PAGES: Item[] = [
  ...ADMIN_LINKS.flatMap((l) =>
    l.children && l.children.length > 0
      ? l.children.filter((c) => !c.devOpsOnly).map((c) => ({ label: c.label, href: c.href }))
      : l.devOpsOnly
        ? []
        : [{ label: l.label, href: l.href }],
  ),
  { label: "MP Changes (WIP)", href: "/changes" },
];

interface Ctx {
  loggedIn: boolean;
  admin: boolean;
  players: { id: string; displayName: string; discordId?: string; username?: string | null }[];
  divisions: { id: string; label: string }[];
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<Ctx>({ loggedIn: false, admin: false, players: [], divisions: [] });
  const [loaded, setLoaded] = useState(false);
  const router = useRouter();

  // Lazy-load permission context + roster + divisions the first time it opens.
  useEffect(() => {
    if (!open || loaded) return;
    setLoaded(true);
    fetch("/api/command-context")
      .then((r) => r.json())
      .then((d) =>
        setCtx({
          loggedIn: !!d.loggedIn,
          admin: !!d.admin,
          players: d.players ?? [],
          divisions: d.divisions ?? [],
        }),
      )
      .catch(() => {});
  }, [open, loaded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onToggle = () => setOpen((o) => !o); // fired by the nav Search button
    document.addEventListener("keydown", onKey);
    window.addEventListener("command:toggle", onToggle);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("command:toggle", onToggle);
    };
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const pages = [...PUBLIC_PAGES, ...(ctx.loggedIn ? AUTHED_PAGES : [])];

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Jump to" description="Search pages">
      <Command>
        <CommandInput placeholder="Jump to a page…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Pages">
            {pages.map((it) => (
              <CommandItem key={it.href} value={`page ${it.label}`} onSelect={() => go(it.href)}>
                {it.label}
              </CommandItem>
            ))}
          </CommandGroup>
          {ctx.admin && (
            <CommandGroup heading="Admin">
              {ADMIN_PAGES.map((it) => (
                <CommandItem key={it.href} value={`admin ${it.label}`} onSelect={() => go(it.href)}>
                  {it.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {ctx.divisions.length > 0 && (
            <CommandGroup heading="Divisions">
              {ctx.divisions.map((d) => (
                <CommandItem key={d.id} value={`division ${d.label}`} onSelect={() => go(`/divisions/${d.id}`)}>
                  {d.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {ctx.players.length > 0 && (
            <CommandGroup heading="Players">
              {ctx.players.map((p) => (
                <CommandItem key={p.id} value={`player ${p.displayName} ${p.username ?? ""}`} onSelect={() => go(`/profile/${p.id}`)}>
                  {p.displayName}
                  {p.username && <span className="discord-username">(@{p.username})</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

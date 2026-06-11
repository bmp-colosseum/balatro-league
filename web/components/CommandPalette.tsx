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

interface Item {
  label: string;
  href: string;
}

const PUBLIC_PAGES: Item[] = [
  { label: "Standings", href: "/standings" },
  { label: "Stats", href: "/stats" },
  { label: "Traits", href: "/traits" },
  { label: "Past seasons", href: "/seasons" },
  { label: "Join the league", href: "/join" },
];

// Require a signed-in session (the pages themselves redirect otherwise).
const AUTHED_PAGES: Item[] = [
  { label: "Players", href: "/players" },
  { label: "Report a match", href: "/report" },
  { label: "My profile", href: "/me" },
];

const ADMIN_PAGES: Item[] = [
  { label: "Admin dashboard", href: "/admin" },
  { label: "Seasons", href: "/admin/seasons" },
  { label: "Players (admin)", href: "/admin/players" },
  { label: "Results", href: "/admin/results" },
  { label: "Disputes", href: "/admin/disputes" },
  { label: "Divisions", href: "/admin/divisions" },
  { label: "Config", href: "/admin/config" },
  { label: "Audit log", href: "/admin/audit" },
  // WIP draft pages — admin-only (the pages themselves 404 for non-admins).
  { label: "MP Changes (WIP)", href: "/changes" },
  { label: "How to play (WIP)", href: "/how-to-play" },
];

interface Ctx {
  loggedIn: boolean;
  admin: boolean;
  players: { id: string; displayName: string }[];
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<Ctx>({ loggedIn: false, admin: false, players: [] });
  const [loaded, setLoaded] = useState(false);
  const router = useRouter();

  // Lazy-load permission context + roster the first time the palette opens.
  useEffect(() => {
    if (!open || loaded) return;
    setLoaded(true);
    fetch("/api/command-context")
      .then((r) => r.json())
      .then((d) => setCtx({ loggedIn: !!d.loggedIn, admin: !!d.admin, players: d.players ?? [] }))
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
          {ctx.players.length > 0 && (
            <CommandGroup heading="Players">
              {ctx.players.map((p) => (
                <CommandItem key={p.id} value={`player ${p.displayName}`} onSelect={() => go(`/profile/${p.id}`)}>
                  {p.displayName}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

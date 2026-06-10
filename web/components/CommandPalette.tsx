"use client";

// ⌘K / Ctrl+K command palette for jumping anywhere. Mounted globally in the
// root layout. Admin routes are gated server-side, so listing them is harmless.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";

const GROUPS: { heading: string; items: { label: string; href: string }[] }[] = [
  {
    heading: "Pages",
    items: [
      { label: "Standings", href: "/standings" },
      { label: "Players", href: "/players" },
      { label: "Stats", href: "/stats" },
      { label: "Traits", href: "/traits" },
      { label: "Past seasons", href: "/seasons" },
      { label: "MP Changes", href: "/changes" },
      { label: "How to play", href: "/how-to-play" },
      { label: "Join the league", href: "/join" },
      { label: "Report a match", href: "/report" },
      { label: "My profile", href: "/me" },
    ],
  },
  {
    heading: "Admin",
    items: [
      { label: "Admin dashboard", href: "/admin" },
      { label: "Seasons", href: "/admin/seasons" },
      { label: "Players (admin)", href: "/admin/players" },
      { label: "Results", href: "/admin/results" },
      { label: "Disputes", href: "/admin/disputes" },
      { label: "Divisions", href: "/admin/divisions" },
      { label: "Config", href: "/admin/config" },
      { label: "Audit log", href: "/admin/audit" },
    ],
  },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

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

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Jump to" description="Search pages">
      <CommandInput placeholder="Jump to a page…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {GROUPS.map((g) => (
          <CommandGroup key={g.heading} heading={g.heading}>
            {g.items.map((it) => (
              <CommandItem key={it.href} value={`${g.heading} ${it.label}`} onSelect={() => go(it.href)}>
                {it.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

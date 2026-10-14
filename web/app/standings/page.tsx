// /standings merged into the home page ("/"), which now renders the exact
// same full standings content for every visitor (see app/page.tsx,
// components/StandingsBoard.tsx) -- one canonical standings URL instead of
// two. Kept as a permanent (308) redirect, not removed outright, so every
// existing /standings link (bookmarks, shared links, search results indexed
// before the merge) still lands somewhere instead of 404ing. A "#division-
// <id>" deep link carries over automatically -- browsers reattach the
// original fragment to a Location header with no fragment of its own, and
// LadderStrip's own "#division-<id>" anchors are relative already, so they
// resolve against "/" with no code change needed here.
//
// No query string to preserve: this page never read searchParams.

import { permanentRedirect } from "next/navigation";

export default function StandingsPage(): never {
  permanentRedirect("/");
}

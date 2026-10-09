import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/CommandPalette";
import { getUiPreviewV2 } from "@/lib/preferences";

// Crisp pixel font for headings + accents — a nod to Balatro's pixel look,
// without hurting readability of the dense tables (body text stays system).
// Silkscreen has sharper, blockier glyphs than Pixelify (whose rounded digits
// read poorly). Kept as-is for the current (v1) look.
//
// Self-hosted (latin subset woff2 files in ./fonts) instead of next/font/google
// so production builds don't need to reach fonts.googleapis.com at build time.
// See ./fonts/LICENSE-*.txt for the OFL license text of each family.
const pixel = localFont({
  src: [
    { path: "./fonts/silkscreen-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/silkscreen-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-pixel",
  display: "swap",
});

// v2 "Card Table" design system type -- only applied when html[data-ui="v2"]
// (see globals.css); loaded unconditionally here since next/font needs a
// module-scope call, but an unused @font-face costs nothing until something
// references its CSS variable.
const displayV2 = localFont({
  src: [{ path: "./fonts/jersey-10-400.woff2", weight: "400", style: "normal" }],
  variable: "--font-display-v2",
  display: "swap",
});

// Nunito Sans ships from Google as a single variable woff2 (wght 200..1000,
// sliced into weight-specific @font-face blocks that all point at the same
// file) -- so we keep the one file and declare the full variable range.
const bodyV2 = localFont({
  src: [{ path: "./fonts/nunito-sans-variable.woff2", weight: "200 1000", style: "normal" }],
  variable: "--font-body-v2",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Balatro League",
  description: "League standings, schedules, and history",
  icons: { icon: "/Balatro_League.png", apple: "/Balatro_League.png" },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // @username visibility is decided per-name by the <DiscordId> server
  // component (members-only), so nothing to gate at the body level here.
  //
  // v2 preview: an admin-only cookie (see app/admin/ui-preview-actions.ts)
  // flips data-ui so the whole page tree can be restyled via
  // html[data-ui="v2"] selectors in globals.css, with zero effect on anyone
  // without the cookie.
  const uiV2 = await getUiPreviewV2();
  return (
    <html
      lang="en"
      className={`${pixel.variable} ${displayV2.variable} ${bodyV2.variable}`}
      data-ui={uiV2 ? "v2" : undefined}
    >
      <body>
        {children}
        <CommandPalette />
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}

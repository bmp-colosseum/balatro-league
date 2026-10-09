import type { Metadata } from "next";
import { Silkscreen, Pixelify_Sans, Nunito_Sans } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/CommandPalette";
import { getUiPreviewV2 } from "@/lib/preferences";

// Crisp pixel font for headings + accents — a nod to Balatro's pixel look,
// without hurting readability of the dense tables (body text stays system).
// Silkscreen has sharper, blockier glyphs than Pixelify (whose rounded digits
// read poorly). Kept as-is for the current (v1) look.
const pixel = Silkscreen({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-pixel",
  display: "swap",
});

// v2 "Card Table" design system type -- only applied when html[data-ui="v2"]
// (see globals.css); loaded unconditionally here since next/font needs a
// module-scope call, but an unused @font-face costs nothing until something
// references its CSS variable.
const displayV2 = Pixelify_Sans({
  subsets: ["latin"],
  weight: ["500", "700"],
  variable: "--font-display-v2",
  display: "swap",
});

const bodyV2 = Nunito_Sans({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
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

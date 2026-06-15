import type { Metadata } from "next";
import { Silkscreen } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/CommandPalette";
import { getShowUsernames } from "@/lib/preferences";

// Crisp pixel font for headings + accents — a nod to Balatro's pixel look,
// without hurting readability of the dense tables (body text stays system).
// Silkscreen has sharper, blockier glyphs than Pixelify (whose rounded digits
// read poorly).
const pixel = Silkscreen({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-pixel",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Balatro League",
  description: "League standings, schedules, and history",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Public Discord usernames — everyone, default on (⚙️ toggle). Numeric Discord
  // IDs are never shown on any page.
  const showUsernames = await getShowUsernames();
  return (
    <html lang="en" className={pixel.variable}>
      <body className={showUsernames ? "show-usernames" : undefined}>
        {children}
        <CommandPalette />
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}

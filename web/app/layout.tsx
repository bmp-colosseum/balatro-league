import type { Metadata } from "next";
import { Silkscreen } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/CommandPalette";
import { getShowDiscordIds, getShowUsernames } from "@/lib/preferences";
import { isAdminUser } from "@/lib/admin";

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
  // Numeric Discord IDs are ADMIN-ONLY. The body class is applied only when the
  // viewer is an admin AND has the ⚙️ "Show Discord IDs" toggle on — so a
  // non-admin can never reveal raw user IDs, cookie or not. (Public username
  // display is separate and not gated here.)
  const showDiscordIds = (await getShowDiscordIds()) && (await isAdminUser());
  // Public Discord usernames — everyone, default on (⚙️ toggle).
  const showUsernames = await getShowUsernames();
  const bodyClass = [showDiscordIds ? "show-discord-ids" : "", showUsernames ? "show-usernames" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <html lang="en" className={pixel.variable}>
      <body className={bodyClass || undefined}>
        {children}
        <CommandPalette />
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}

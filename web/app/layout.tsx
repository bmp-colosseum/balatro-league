import type { Metadata } from "next";
import { Silkscreen } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/CommandPalette";

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
  icons: { icon: "/Balatro_League.png", apple: "/Balatro_League.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // @username visibility is decided per-name by the <DiscordId> server
  // component (members-only), so nothing to gate at the body level here.
  return (
    <html lang="en" className={pixel.variable}>
      <body>
        {children}
        <CommandPalette />
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Pixelify_Sans } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/CommandPalette";

// Chunky pixel font for headings + accents — a nod to Balatro's m6x11 look,
// without hurting readability of the dense tables (body text stays system).
const pixel = Pixelify_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-pixel",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Balatro League",
  description: "League standings, schedules, and history",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
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

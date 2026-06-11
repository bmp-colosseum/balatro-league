import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/CommandPalette";

export const metadata: Metadata = {
  title: "Balatro League",
  description: "League standings, schedules, and history",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <CommandPalette />
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}

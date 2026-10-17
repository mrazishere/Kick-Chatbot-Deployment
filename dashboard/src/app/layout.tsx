import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mr-AI-is-Here · Kick Dashboard",
  description: "Kick bot management & earnings analytics",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0a0a0a] text-neutral-200 antialiased">{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Target API Manager",
  description: "API key manager + Kaggle session watcher & restarter",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
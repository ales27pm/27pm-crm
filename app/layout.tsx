import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "27PM CRM",
  description:
    "Boîte courriel, contacts, projets et suivis du studio 27PM.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
  icons: {
    icon: "/favicon-64.png",
    shortcut: "/favicon-64.png",
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr-CA">
      <body>{children}</body>
    </html>
  );
}

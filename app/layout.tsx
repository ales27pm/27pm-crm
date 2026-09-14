import type { Metadata, Viewport } from "next";
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
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/visual-assets/app-icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/visual-assets/app-icons/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: [
      {
        url: "/visual-assets/app-icons/apple-touch-icon-180.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  manifest: "/visual-assets/app-icons/site.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#2846B8",
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

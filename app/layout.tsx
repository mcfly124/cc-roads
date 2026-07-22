import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "cc-roads — navigazione per cilindrata",
  description: "Percorsi filtrati in base alla cilindrata del veicolo. Pensato per l'Ape 50 in Italia.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "cc-roads",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b7285",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}

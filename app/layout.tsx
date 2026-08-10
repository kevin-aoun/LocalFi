import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { PRIVACY_BOOT_SCRIPT } from "@/lib/privacy";

export const metadata: Metadata = {
  title: "LocalFi",
  description: "Self-hosted personal finance. Your data stays on your machine.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PRIVACY_BOOT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

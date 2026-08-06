import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { PRIVACY_BOOT_SCRIPT } from "@/lib/privacy";

const inter = Inter({ subsets: ["latin"] });

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
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

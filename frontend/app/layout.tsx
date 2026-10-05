import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClarityPay | Payment Safety",
  description: "A moment of clarity before you send. Uganda payment scam prevention prototype."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Seller Manager",
  description: "A focused operations workspace for Flipkart sellers",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

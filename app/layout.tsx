import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Flipkart Seller Manager",
  description: "Personal Flipkart seller operations dashboard"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
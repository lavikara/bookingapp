import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clinic appointments",
  description: "Browse available clinic times and manage your appointments.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

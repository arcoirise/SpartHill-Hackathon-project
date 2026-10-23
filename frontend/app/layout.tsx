import type { ReactNode } from "react";

export const metadata = {
  title: "EdgeSense",
  description: "Privacy-first accident prevention at the edge",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

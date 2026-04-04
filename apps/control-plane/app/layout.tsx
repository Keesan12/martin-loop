import "./globals.css";

import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Fragment, type ReactNode } from "react";

export const metadata: Metadata = {
  title: "Martin Loop Control Plane",
  description: "Hosted SaaS dashboard for Martin Loop spend, savings, and policy operations."
};

export default function RootLayout(props: { children: ReactNode }) {
  const AuthProvider =
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim()
      ? ClerkProvider
      : Fragment;

  return (
    <html lang="en">
      <body>
        <AuthProvider>{props.children}</AuthProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import React from "react";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Design System",
  robots: {
    index: false,
    follow: false,
  },
};

export default function DevUiLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return <>{children}</>;
}

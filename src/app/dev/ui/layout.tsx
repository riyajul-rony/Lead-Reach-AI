import type { Metadata } from "next";
import React from "react";

export const metadata: Metadata = {
  title: "Design System — Lead Reach AI",
  robots: {
    index: false,
    follow: false,
  },
};

export default function DevUiLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RSS 리더",
  description: "수집한 RSS 글을 살펴보는 웹 앱입니다.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

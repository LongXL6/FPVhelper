import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "FPVHelper 训练工作台",
  description: "面向 FPV 俱乐部的训练量化工作台：本机观察实时画面与打杆，并按选手代号归档训练 Session。",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

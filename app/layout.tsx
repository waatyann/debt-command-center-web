import type { Metadata, Viewport } from "next";
import "./globals.css";
import PwaRegister from "@/components/PwaRegister";
export const metadata: Metadata = { title:"借金返済司令室", description:"借金・返済額・元金・利息を見える化するスマホ対応Webアプリ", applicationName:"借金返済司令室" };
export const viewport: Viewport = { width:"device-width", initialScale:1, themeColor:"#090b10" };
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="ja"><body><PwaRegister />{children}</body></html>; }

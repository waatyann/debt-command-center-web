import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest { return { name:"借金返済司令室", short_name:"返済司令室", description:"借金・返済額・元金・利息を見える化するスマホ対応Webアプリ", start_url:"/", display:"standalone", background_color:"#090b10", theme_color:"#090b10", orientation:"portrait", icons:[{src:"/icon.svg",sizes:"any",type:"image/svg+xml"}] }; }

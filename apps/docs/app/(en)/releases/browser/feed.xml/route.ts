import { releaseFeed } from "@/lib/feed";

export const revalidate = false;

export function GET() {
  return releaseFeed("browser");
}

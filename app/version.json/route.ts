import { getAppVersionPayload } from "@/lib/app-version";

export async function GET() {
  return Response.json(getAppVersionPayload(), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

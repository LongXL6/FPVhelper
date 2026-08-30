import { handleAnalyticsEventsRequest } from "@/lib/analytics/server";
import {
  analyticsAllowedHostnames,
  authorizeAnalyticsIngest,
  insertAnalyticsEvents,
} from "@/lib/supabase/analytics-admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleAnalyticsEventsRequest(request, {
    allowedHostnames: analyticsAllowedHostnames(),
    authorize: authorizeAnalyticsIngest,
    insert: insertAnalyticsEvents,
  });
}

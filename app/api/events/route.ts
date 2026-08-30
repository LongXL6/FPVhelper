import { handleAnalyticsEventsRequest } from "@/lib/analytics/server";
import {
  analyticsAllowedHostnames,
  authorizeAndConsumeAnalyticsQuota,
  insertAnalyticsEvents,
} from "@/lib/supabase/analytics-admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleAnalyticsEventsRequest(request, {
    allowedHostnames: analyticsAllowedHostnames(),
    authorizeAndConsumeQuota: authorizeAndConsumeAnalyticsQuota,
    insert: insertAnalyticsEvents,
  });
}

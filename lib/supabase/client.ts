"use client";

import { createBrowserClient } from "@supabase/ssr";
import { requireSupabasePublicConfig } from "@/lib/supabase/env";

let browserClient: ReturnType<typeof createBrowserClient> | undefined;

export function createClient() {
  if (!browserClient) {
    const { url, key } = requireSupabasePublicConfig();
    browserClient = createBrowserClient(url, key);
  }

  return browserClient;
}

import { defineConfig } from "@playwright/test";
import original from "./playwright.config";

// Dedicated test service: never reuse the operator's configured 3107 workstation.
export default defineConfig({
  ...original,
  use: { ...original.use, baseURL: "http://127.0.0.1:3137" },
  outputDir: "output/playwright/phase2a/full-smoke-01",
  webServer: {
    command: "npm run build && npm run start -- --hostname 127.0.0.1 --port 3137",
    url: "http://127.0.0.1:3137",
    reuseExistingServer: false,
    timeout: 60000,
    env: { NEXT_PUBLIC_ANALYTICS_ENABLED: "true", NEXT_PUBLIC_ANALYTICS_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", FPV_MEASUREMENT_BUILD: "0" },
  },
});

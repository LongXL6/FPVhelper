import type { NextConfig } from "next";
import { getPublicBuildEnvironment } from "./lib/app-version";

const publicBuildEnvironment = getPublicBuildEnvironment();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_ANALYTICS_ENABLED: publicBuildEnvironment.analyticsEnabled ? "true" : "false",
    NEXT_PUBLIC_ANALYTICS_ENV: publicBuildEnvironment.analyticsEnvironment,
    NEXT_PUBLIC_APP_VERSION: publicBuildEnvironment.appVersion,
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;

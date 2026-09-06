import type { NextConfig } from "next";
import { getPublicBuildEnvironment } from "./lib/app-version";

const publicBuildEnvironment = getPublicBuildEnvironment();
const measurementBuild = process.env.FPV_MEASUREMENT_BUILD === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: measurementBuild ? ".next-measurement" : ".next",
  env: {
    NEXT_PUBLIC_FPV_MEASUREMENT: measurementBuild ? "true" : "false",
    NEXT_PUBLIC_ANALYTICS_ENABLED: publicBuildEnvironment.analyticsEnabled ? "true" : "false",
    NEXT_PUBLIC_ANALYTICS_ENV: publicBuildEnvironment.analyticsEnvironment,
    NEXT_PUBLIC_APP_VERSION: publicBuildEnvironment.appVersion,
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;

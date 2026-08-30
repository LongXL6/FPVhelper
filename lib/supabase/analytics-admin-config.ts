export interface AnalyticsAdminConfig {
  url: string;
  secretKey: string;
}

export interface AnalyticsAdminEnvironment {
  [name: string]: string | undefined;
  FPVHELPER_ANALYTICS_SUPABASE_URL?: string;
  FPVHELPER_ANALYTICS_SUPABASE_SECRET_KEY?: string;
}

export function readAnalyticsAdminConfig(
  environment: AnalyticsAdminEnvironment = process.env,
): AnalyticsAdminConfig | null {
  const url = environment.FPVHELPER_ANALYTICS_SUPABASE_URL?.trim();
  const secretKey = environment.FPVHELPER_ANALYTICS_SUPABASE_SECRET_KEY?.trim();
  if (!url || !secretKey) return null;
  return { url, secretKey };
}

import packageJson from "../package.json";

export interface AppVersionPayload {
  version: string;
  build: string;
  commitSha: string | null;
  environment: string;
}

export const APP_VERSION = packageJson.version;

function normalizedCommitSha(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 12) : null;
}

export function getAppVersionPayload(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppVersionPayload {
  const commitSha = normalizedCommitSha(env.VERCEL_GIT_COMMIT_SHA ?? env.GITHUB_SHA);
  return {
    version: APP_VERSION,
    build: commitSha ? `${APP_VERSION}+${commitSha.slice(0, 7)}` : `${APP_VERSION}+local`,
    commitSha,
    environment: env.VERCEL_ENV ?? env.NODE_ENV ?? "development",
  };
}

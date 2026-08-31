import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export type AnalyticsTokenOperation = "issue" | "rotate" | "revoke";

export interface AnalyticsTokenCommand {
  operation: AnalyticsTokenOperation;
  workstationId: string;
  clubCode: string;
}

interface ProvisioningDependencies {
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLUB_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const HELP_FLAGS = new Set(["-h", "--help"]);

export const ANALYTICS_TOKEN_USAGE = `用法:
  npm run analytics:token -- issue  --workstation-id <UUID> --club-code <CODE>
  npm run analytics:token -- rotate --workstation-id <UUID> --club-code <CODE>
  npm run analytics:token -- revoke --workstation-id <UUID> --club-code <CODE>

说明:
  issue/rotate 会在私密终端中仅显示一次新明文 token；SQL/JSON 永不包含明文。
  本工具不连接数据库，也不接收数据库 URL、密钥或现有 token 参数。`;

function validatedCommand(command: AnalyticsTokenCommand): AnalyticsTokenCommand {
  if (!UUID_PATTERN.test(command.workstationId)) throw new Error("workstation ID 必须是完整 UUID。");
  if (!CLUB_CODE_PATTERN.test(command.clubCode)) {
    throw new Error("club code 仅允许 1-32 位英文字母、数字、点、下划线或连字符。");
  }
  return {
    operation: command.operation,
    workstationId: command.workstationId.toLowerCase(),
    clubCode: command.clubCode,
  };
}

export function parseAnalyticsTokenArgs(args: string[]): AnalyticsTokenCommand | null {
  if (args.length === 0 || args.some((argument) => HELP_FLAGS.has(argument))) return null;
  const operation = args[0];
  if (operation !== "issue" && operation !== "rotate" && operation !== "revoke") {
    throw new Error("命令必须是 issue、rotate 或 revoke。");
  }

  let workstationId: string | null = null;
  let clubCode: string | null = null;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("参数缺少值或包含不支持的参数。");
    if (flag === "--workstation-id" && workstationId === null) workstationId = value;
    else if (flag === "--club-code" && clubCode === null) clubCode = value;
    else throw new Error("参数重复或不受支持；本工具不接受任何 secret/token 参数。");
    index += 1;
  }

  if (!workstationId || !clubCode) throw new Error("必须同时提供 workstation ID 与 club code。");
  return validatedCommand({ operation, workstationId, clubCode });
}

export function hashAnalyticsIngestToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function createAnalyticsIngestToken(randomBytesFunction: (size: number) => Uint8Array) {
  const entropy = randomBytesFunction(32);
  if (entropy.byteLength !== 32) throw new Error("安全随机源未返回 32 字节。");
  return `fpvh_ingest_${Buffer.from(entropy).toString("base64url")}`;
}

function registrationSql(command: AnalyticsTokenCommand, tokenHash: string | null) {
  const workstation = `'${command.workstationId}'::uuid`;
  if (command.operation === "issue" && tokenHash) {
    return `insert into public.analytics_ingest_tokens (workstation_id, token_hash, purpose)
values (${workstation}, '${tokenHash}', 'event_ingest')
returning id, workstation_id, created_at;`;
  }
  if (command.operation === "rotate" && tokenHash) {
    return `with revoked as (
  update public.analytics_ingest_tokens
  set revoked_at = clock_timestamp()
  where workstation_id = ${workstation}
    and revoked_at is null
  returning workstation_id
)
insert into public.analytics_ingest_tokens (workstation_id, token_hash, purpose)
select workstation_id, '${tokenHash}', 'event_ingest'
from revoked
returning id, workstation_id, created_at;`;
  }
  return `update public.analytics_ingest_tokens
set revoked_at = clock_timestamp()
where workstation_id = ${workstation}
  and revoked_at is null
returning id, workstation_id, revoked_at;`;
}

export function renderAnalyticsTokenBundle(
  rawCommand: AnalyticsTokenCommand,
  dependencies: ProvisioningDependencies = {},
) {
  const command = validatedCommand(rawCommand);
  const generatedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const plaintextToken = command.operation === "revoke"
    ? null
    : createAnalyticsIngestToken(dependencies.randomBytes ?? randomBytes);
  const tokenHash = plaintextToken ? hashAnalyticsIngestToken(plaintextToken) : null;
  const registration = tokenHash
    ? { workstation_id: command.workstationId, token_hash: tokenHash, purpose: "event_ingest" }
    : { workstation_id: command.workstationId };
  const auditJson = JSON.stringify({
    schema_version: 1,
    operation: command.operation,
    generated_at: generatedAt,
    club_code: command.clubCode,
    registration,
    expected_returning_rows: 1,
    storage_boundary: "secure_operations_record_only_not_analytics_database_or_git",
  }, null, 2);
  const sections = plaintextToken
    ? [
      "=== PLAINTEXT TOKEN (仅显示本次；立即安装，勿保存/转发) ===",
      plaintextToken,
      "",
    ]
    : [];

  sections.push(
    "=== OPERATOR AUDIT / REGISTRATION JSON (不含明文 token；不得入 analytics DB 或 Git) ===",
    auditJson,
    "",
    "=== REGISTRATION SQL (仅用于独立 FPVHelper analytics Supabase；不含 club 映射) ===",
    registrationSql(command, tokenHash),
    "",
    "必须核对 SQL 返回恰好 1 行；0 行或多行均视为未完成。",
    "",
  );
  return sections.join("\n");
}

function isDirectExecution() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const command = parseAnalyticsTokenArgs(process.argv.slice(2));
    process.stdout.write(command ? renderAnalyticsTokenBundle(command) : `${ANALYTICS_TOKEN_USAGE}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法解析命令。";
    process.stderr.write(`错误：${message}\n\n${ANALYTICS_TOKEN_USAGE}\n`);
    process.exitCode = 1;
  }
}

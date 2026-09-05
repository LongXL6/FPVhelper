import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseAnalyticsTokenArgs,
  renderAnalyticsTokenBundle,
  type AnalyticsTokenCommand,
} from "./analytics-ingest-token.mjs";

const WORKSTATION_ID = "10000000-0000-4000-8000-000000000001";
const CLUB_CODE = "fpv-club_01";
const FIXED_TOKEN = `fpvh_ingest_${Buffer.alloc(32, 7).toString("base64url")}`;
const FIXED_HASH = createHash("sha256").update(FIXED_TOKEN, "utf8").digest("hex");

function command(operation: AnalyticsTokenCommand["operation"]): AnalyticsTokenCommand {
  return { operation, workstationId: WORKSTATION_ID, clubCode: CLUB_CODE };
}

function render(operation: AnalyticsTokenCommand["operation"]) {
  return renderAnalyticsTokenBundle(command(operation), {
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    randomBytes: () => Buffer.alloc(32, 7),
  });
}

describe("analytics ingest token provisioning CLI", () => {
  it("issues 256-bit token material once and keeps plaintext out of SQL/JSON", () => {
    const output = render("issue");
    const sql = output.split("=== REGISTRATION SQL")[1];

    expect(output.match(/fpvh_ingest_/g)).toHaveLength(1);
    expect(FIXED_TOKEN).toMatch(/^fpvh_ingest_[A-Za-z0-9_-]{43}$/);
    expect(output).toContain(FIXED_TOKEN);
    expect(output).toContain(FIXED_HASH);
    expect(sql).not.toContain(FIXED_TOKEN);
    expect(sql).not.toContain(CLUB_CODE);
    expect(sql).toContain(WORKSTATION_ID);
    expect(sql).toContain("insert into public.analytics_ingest_tokens");
  });

  it("rotates atomically only when one active workstation row is revoked", () => {
    const output = render("rotate");
    const sql = output.split("=== REGISTRATION SQL")[1];

    expect(output.match(/fpvh_ingest_/g)).toHaveLength(1);
    expect(sql).toContain("with revoked as");
    expect(sql).toContain("and revoked_at is null");
    expect(sql).toContain("from revoked");
    expect(sql).toContain(FIXED_HASH);
    expect(sql).not.toContain(FIXED_TOKEN);
  });

  it("renders an explicit revoke without generating token material", () => {
    const output = render("revoke");

    expect(output).not.toContain("fpvh_ingest_");
    expect(output).not.toContain(FIXED_HASH);
    expect(output).toContain('"operation": "revoke"');
    expect(output).toContain("set revoked_at = clock_timestamp()");
    expect(output).toContain("returning id, workstation_id, revoked_at");
  });

  it("accepts only validated non-secret arguments", () => {
    expect(parseAnalyticsTokenArgs([
      "issue", "--workstation-id", WORKSTATION_ID.toUpperCase(), "--club-code", CLUB_CODE,
    ])).toEqual(command("issue"));
    expect(() => parseAnalyticsTokenArgs([
      "issue", "--workstation-id", WORKSTATION_ID, "--club-code", "club';drop table tokens;--",
    ])).toThrow(/club code/);
    expect(() => parseAnalyticsTokenArgs([
      "issue", "--workstation-id", WORKSTATION_ID, "--club-code", CLUB_CODE, "--secret-key", "private",
    ])).toThrow(/不接受任何 secret\/token/);
  });
});

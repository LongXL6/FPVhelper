import { describe, expect, it } from "vitest";
import {
  getOrCreateWorkstationId,
  isWorkstationId,
  WORKSTATION_ID_STORAGE_KEY,
} from "./workstation-id";

const FIRST_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_ID = "20000000-0000-4000-8000-000000000002";

describe("local workstation identity", () => {
  it("creates one persisted UUID and reuses it across sessions", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    expect(getOrCreateWorkstationId(storage, () => FIRST_ID)).toBe(FIRST_ID);
    expect(getOrCreateWorkstationId(storage, () => SECOND_ID)).toBe(FIRST_ID);
    expect(values.get(WORKSTATION_ID_STORAGE_KEY)).toBe(FIRST_ID);
  });

  it("rejects invalid or unpersisted workstation identifiers", () => {
    const storage = {
      getItem: () => null,
      setItem: () => undefined,
    };

    expect(isWorkstationId("machine-name")).toBe(false);
    expect(getOrCreateWorkstationId(storage, () => FIRST_ID)).toBeNull();
    expect(getOrCreateWorkstationId(storage, () => "machine-name")).toBeNull();
  });
});

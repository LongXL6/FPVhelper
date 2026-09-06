import { expect, test } from "vitest";
import { checkCpuProfile } from "./phase1b-r1-profile";
const valid = { nodes: [{id: 1}], samples: [1], timeDeltas: [1000], startTime: 1, endTime: 1001 };
test("CPU profile accepts valid sample nodes and rejects actual byte/sample over-limit branches", () => {
  expect(checkCpuProfile(valid, 100).valid).toBe(true);
  expect(checkCpuProfile(valid, 101, 100).truncated).toBe(true);
  expect(checkCpuProfile({...valid, samples: [1,1], timeDeltas: [500,500]}, 100, 1000, 1).truncated).toBe(true);
  expect(checkCpuProfile({...valid, samples: [2]}, 100).valid).toBe(false);
  expect(checkCpuProfile({...valid, timeDeltas: []}, 100).valid).toBe(false);
});

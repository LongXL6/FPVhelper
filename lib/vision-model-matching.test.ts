import { describe, expect, it } from "vitest";
import { createVisionPatchGrid, createVisionReference, findVisionModelCandidates, matchVisionModel, visionLetterbox, type VisionPatchGrid } from "./vision-model-matching";

function grid(width: number, height: number): VisionPatchGrid {
  const features = new Float32Array(width * height * 9);
  for (let patch = 0; patch < width * height; patch += 1) features[patch * 9 + 8] = 1;
  return { width, height, dimensions: 9, features, contentBox: { x: 0, y: 0, width: 1, height: 1 }, imageWidth: width, imageHeight: height };
}

function placeTarget(target: VisionPatchGrid, left: number, top: number, scale = 1) {
  const cells = [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]];
  cells.forEach(([x, y], feature) => {
    for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) {
      const offset = ((top + y * scale + dy) * target.width + left + x * scale + dx) * target.dimensions;
      target.features.fill(0, offset, offset + target.dimensions);
      target.features[offset + feature] = 1;
    }
  });
}

function reference() {
  const target = grid(3, 3);
  placeTarget(target, 0, 0);
  return createVisionReference(target);
}

describe("local DINOv2 reference matching", () => {
  it("retains wide and portrait aspect ratios in the square model input", () => {
    expect(visionLetterbox(1600, 900)).toEqual({ x: 0, y: 0.21875, width: 1, height: 0.5625 });
    expect(visionLetterbox(900, 1600)).toEqual({ x: 0.21875, y: 0, width: 0.5625, height: 1 });
    expect(() => visionLetterbox(0, 900)).toThrow("图像尺寸无效");
  });

  it("reads normalized patch tokens and excludes the classification token", () => {
    const values = new Float32Array(10 * 2);
    values[0] = 999;
    for (let token = 1; token < 10; token += 1) { values[token * 2] = 3; values[token * 2 + 1] = 4; }
    const result = createVisionPatchGrid(values, [1, 10, 2], 300, 300);
    expect(result.width).toBe(3);
    expect(result.features.length).toBe(18);
    expect(result.features[0]).toBeCloseTo(0.6);
    expect(result.features[1]).toBeCloseTo(0.8);
    expect(() => createVisionPatchGrid(values, [1, 9, 2], 300, 300)).toThrow("局部特征");
    values[2] = Number.NaN;
    expect(() => createVisionPatchGrid(values, [1, 10, 2], 300, 300)).toThrow("无效特征");
  });

  it("finds the reference pattern at its observed location without inventing other candidates", () => {
    const frame = grid(16, 16);
    placeTarget(frame, 8, 4);
    const matches = findVisionModelCandidates(reference(), frame, 0.99);
    expect(matches).toHaveLength(1);
    expect(matches[0].box).toEqual({ x: 0.5, y: 0.25, width: 0.1875, height: 0.1875 });
    expect(matches[0].similarity).toBeCloseTo(1);
    expect(findVisionModelCandidates(reference(), grid(16, 16), 0.55)).toEqual([]);
  });

  it("matches larger targets while excluding the changing scene through the opening", () => {
    const frame = grid(16, 16);
    placeTarget(frame, 4, 5, 2);
    const matches = findVisionModelCandidates(reference(), frame, 0.99);
    expect(matches[0].box).toEqual({ x: 0.25, y: 0.3125, width: 0.375, height: 0.375 });
    expect(matches[0].similarity).toBeCloseTo(1);
  });

  it("maps matches back to the original wide image instead of including letterbox padding", () => {
    const frame = grid(16, 16);
    frame.contentBox = visionLetterbox(1600, 900);
    frame.imageWidth = 1600;
    frame.imageHeight = 900;
    placeTarget(frame, 6, 5);
    const [match] = findVisionModelCandidates(reference(), frame, 0.99);
    expect(match.box.x).toBeCloseTo(6 / 16);
    expect(match.box.y).toBeCloseTo(1 / 6);
    expect(match.box.width).toBeCloseTo(3 / 16);
    expect(match.box.height).toBeCloseTo(1 / 3);
  });

  it("keeps at most three distinct hypotheses and rejects incompatible reference features", () => {
    const frame = grid(16, 16);
    for (const [x, y] of [[0, 0], [8, 0], [0, 8], [8, 8]]) placeTarget(frame, x, y);
    expect(findVisionModelCandidates(reference(), frame, 0.99)).toHaveLength(3);
    expect(() => findVisionModelCandidates(reference(), frame, Number.NaN)).toThrow("阈值");
    expect(() => findVisionModelCandidates({ ...reference(), dimensions: 10 }, frame)).toThrow("不兼容");
    const empty = grid(3, 3);
    empty.features.fill(0);
    expect(() => createVisionReference(empty)).toThrow("没有可用特征");
  });

  it("reports the true best below-threshold window without accepting it", () => {
    const frame = grid(16, 16);
    placeTarget(frame, 8, 4);
    const ref = reference();
    // Orthogonal background mixed into the reference lowers every true cosine.
    for (const cell of ref.cells) { for (let d = 0; d < 8; d++) cell[d] *= .5; cell[8] = Math.sqrt(.75); }
    const diagnostics = matchVisionModel(ref, frame, .99);
    expect(diagnostics.candidates).toEqual([]);
    expect(diagnostics.bestMatch).not.toBeNull();
    const unfiltered = findVisionModelCandidates(ref, frame, -1);
    expect(diagnostics.bestMatch).toEqual(unfiltered[0]);
    expect(diagnostics.bestMatch!.similarity).toBeLessThan(.99);
  });

  it("uses the same normalized image coordinates and unchanged accepted selection for diagnostics", () => {
    const frame = grid(16, 16);
    frame.contentBox = visionLetterbox(1600, 900);
    frame.imageWidth = 1600;
    frame.imageHeight = 900;
    placeTarget(frame, 6, 5);
    const result = matchVisionModel(reference(), frame, .99);
    expect(result.candidates).toEqual(findVisionModelCandidates(reference(), frame, .99));
    expect(result.bestMatch).toEqual(result.candidates[0]);
    expect(result.bestMatch!.box.y).toBeCloseTo(1 / 6);
    frame.contentBox = { x: 0, y: .49, width: 1, height: .02 };
    expect(matchVisionModel(reference(), frame)).toEqual({ candidates: [], bestMatch: null });
  });
});

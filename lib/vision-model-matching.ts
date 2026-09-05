import type { VisionModelBox, VisionModelCandidate } from "./vision-model";

export interface VisionPatchGrid {
  width: number;
  height: number;
  dimensions: number;
  features: Float32Array;
  /** Unpadded image bounds in the square model input. */
  contentBox: VisionModelBox;
  imageWidth: number;
  imageHeight: number;
}

export interface VisionReferenceFeatures {
  dimensions: number;
  aspectRatio: number;
  cells: Float32Array[];
}

const TEMPLATE_CELLS = [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]] as const;

export function visionLetterbox(width: number, height: number): VisionModelBox {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("图像尺寸无效");
  const scale = 1 / Math.max(width, height);
  const normalizedWidth = width * scale;
  const normalizedHeight = height * scale;
  return { x: (1 - normalizedWidth) / 2, y: (1 - normalizedHeight) / 2, width: normalizedWidth, height: normalizedHeight };
}

export function createVisionPatchGrid(
  data: ArrayLike<number>,
  shape: readonly number[],
  imageWidth: number,
  imageHeight: number,
): VisionPatchGrid {
  const [batch, tokenCount, dimensions] = shape;
  const side = Math.sqrt(tokenCount - 1);
  if (shape.length !== 3 || batch !== 1 || !Number.isInteger(side) || side < 3 || !Number.isInteger(dimensions) || dimensions < 1 || data.length !== tokenCount * dimensions) {
    throw new Error("模型输出不是有效的 DINOv2 图像局部特征");
  }
  const features = new Float32Array((tokenCount - 1) * dimensions);
  for (let patch = 0; patch < tokenCount - 1; patch += 1) {
    let squaredLength = 0;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const value = data[(patch + 1) * dimensions + dimension];
      if (!Number.isFinite(value)) throw new Error("模型产生了无效特征值");
      features[patch * dimensions + dimension] = value;
      squaredLength += value * value;
    }
    const length = Math.sqrt(squaredLength);
    if (length > 0) for (let dimension = 0; dimension < dimensions; dimension += 1) features[patch * dimensions + dimension] /= length;
  }
  return { width: side, height: side, dimensions, features, contentBox: visionLetterbox(imageWidth, imageHeight), imageWidth, imageHeight };
}

function validateGrid(grid: VisionPatchGrid) {
  if (!Number.isInteger(grid.width) || grid.width < 3 || !Number.isInteger(grid.height) || grid.height < 3 || !Number.isInteger(grid.dimensions) || grid.dimensions < 1 || grid.features.length !== grid.width * grid.height * grid.dimensions) {
    throw new Error("局部特征网格无效");
  }
  const box = grid.contentBox;
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.x + box.width > 1.000001 || box.y + box.height > 1.000001) throw new Error("图像有效区域无效");
}

function contentBounds(grid: VisionPatchGrid) {
  const { x, y, width, height } = grid.contentBox;
  return {
    left: Math.max(0, Math.ceil(x * grid.width - 0.5)),
    top: Math.max(0, Math.ceil(y * grid.height - 0.5)),
    right: Math.min(grid.width, Math.floor((x + width) * grid.width + 0.5)),
    bottom: Math.min(grid.height, Math.floor((y + height) * grid.height + 0.5)),
  };
}

function buildIntegral(grid: VisionPatchGrid) {
  const stride = grid.width + 1;
  const integral = new Float32Array(stride * (grid.height + 1) * grid.dimensions);
  for (let y = 1; y <= grid.height; y += 1) for (let x = 1; x <= grid.width; x += 1) for (let d = 0; d < grid.dimensions; d += 1) {
    const at = (y * stride + x) * grid.dimensions + d;
    integral[at] = grid.features[((y - 1) * grid.width + x - 1) * grid.dimensions + d]
      + integral[at - grid.dimensions] + integral[at - stride * grid.dimensions] - integral[at - (stride + 1) * grid.dimensions];
  }
  return integral;
}

function cellDescriptor(grid: VisionPatchGrid, integral: Float32Array, x: number, y: number, width: number, height: number, cellX: number, cellY: number) {
  const left = x + Math.floor(width * cellX / 3);
  const top = y + Math.floor(height * cellY / 3);
  const right = x + Math.floor(width * (cellX + 1) / 3);
  const bottom = y + Math.floor(height * (cellY + 1) / 3);
  const result = new Float32Array(grid.dimensions);
  const stride = grid.width + 1;
  let squaredLength = 0;
  for (let d = 0; d < grid.dimensions; d += 1) {
    const value = integral[(bottom * stride + right) * grid.dimensions + d] - integral[(top * stride + right) * grid.dimensions + d]
      - integral[(bottom * stride + left) * grid.dimensions + d] + integral[(top * stride + left) * grid.dimensions + d];
    result[d] = value;
    squaredLength += value * value;
  }
  const length = Math.sqrt(squaredLength);
  if (length > 0) for (let d = 0; d < grid.dimensions; d += 1) result[d] /= length;
  return result;
}

export function createVisionReference(grid: VisionPatchGrid): VisionReferenceFeatures {
  validateGrid(grid);
  const bounds = contentBounds(grid);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (width < 3 || height < 3) throw new Error("参考图过于狭长，请重新框选目标");
  const integral = buildIntegral(grid);
  // Use the eight outer cells so the scene visible through a gate does not dominate its reference.
  const cells = TEMPLATE_CELLS.map(([x, y]) => cellDescriptor(grid, integral, bounds.left, bounds.top, width, height, x, y));
  if (cells.every((cell) => cell.every((value) => value === 0))) throw new Error("参考图没有可用特征");
  return { dimensions: grid.dimensions, aspectRatio: grid.imageWidth / grid.imageHeight, cells };
}

function toImageBox(grid: VisionPatchGrid, x: number, y: number, width: number, height: number): VisionModelBox {
  const content = grid.contentBox;
  const left = Math.max(0, (x / grid.width - content.x) / content.width);
  const top = Math.max(0, (y / grid.height - content.y) / content.height);
  const right = Math.min(1, ((x + width) / grid.width - content.x) / content.width);
  const bottom = Math.min(1, ((y + height) / grid.height - content.y) / content.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function overlap(a: VisionModelBox, b: VisionModelBox) {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

export function matchVisionModel(reference: VisionReferenceFeatures, grid: VisionPatchGrid, threshold = 0.55): { candidates: VisionModelCandidate[]; bestMatch: VisionModelCandidate | null } {
  validateGrid(grid);
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) throw new Error("相似度阈值必须在 -1 至 1");
  if (reference.dimensions !== grid.dimensions || reference.cells.length !== TEMPLATE_CELLS.length || reference.cells.some((cell) => cell.length !== grid.dimensions) || !Number.isFinite(reference.aspectRatio) || reference.aspectRatio <= 0) throw new Error("参考特征与当前模型不兼容");
  const bounds = contentBounds(grid);
  const integral = buildIntegral(grid);
  const candidates: VisionModelCandidate[] = [];
  let bestMatch: VisionModelCandidate | null = null;
  for (let height = 3; height <= bounds.bottom - bounds.top; height += 1) {
    const widths = new Set([0.75, 1, 1.25].map((aspect) => Math.round(height * reference.aspectRatio * aspect)));
    for (const width of widths) {
      if (width < 3 || width > bounds.right - bounds.left) continue;
      for (let y = bounds.top; y + height <= bounds.bottom; y += 1) for (let x = bounds.left; x + width <= bounds.right; x += 1) {
        let similarity = 0;
        for (let index = 0; index < TEMPLATE_CELLS.length; index += 1) {
          const [cellX, cellY] = TEMPLATE_CELLS[index];
          const descriptor = cellDescriptor(grid, integral, x, y, width, height, cellX, cellY);
          for (let d = 0; d < grid.dimensions; d += 1) similarity += descriptor[d] * reference.cells[index][d];
        }
        similarity = Math.max(-1, Math.min(1, similarity / TEMPLATE_CELLS.length));
        if (similarity >= threshold || !bestMatch || similarity >= bestMatch.similarity) {
          const candidate = { box: toImageBox(grid, x, y, width, height), similarity };
          if (!bestMatch || similarity > bestMatch.similarity || (similarity === bestMatch.similarity && candidate.box.width * candidate.box.height > bestMatch.box.width * bestMatch.box.height)) bestMatch = candidate;
          if (similarity >= threshold) candidates.push(candidate);
        }
      }
    }
  }
  candidates.sort((a, b) => b.similarity - a.similarity || b.box.width * b.box.height - a.box.width * a.box.height);
  const selected: VisionModelCandidate[] = [];
  for (const candidate of candidates) {
    if (selected.every((previous) => overlap(previous.box, candidate.box) <= 0.35)) selected.push(candidate);
    if (selected.length === 3) break;
  }
  return { candidates: selected, bestMatch };
}

export function findVisionModelCandidates(reference: VisionReferenceFeatures, grid: VisionPatchGrid, threshold = 0.55): VisionModelCandidate[] {
  return matchVisionModel(reference, grid, threshold).candidates;
}

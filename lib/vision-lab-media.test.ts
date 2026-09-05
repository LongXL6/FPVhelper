import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hashVisionFile } from "./vision-lab-media";

describe("large local video identity", () => {
  it("hashes every byte in bounded chunks without reading the entire video at once", async () => {
    const bytes = new Uint8Array(9 * 1024 * 1024).map((_, index) => index % 251);
    const file = new Blob([bytes]);
    const readAll = vi.spyOn(file, "arrayBuffer");
    const slice = vi.spyOn(file, "slice");
    const progress: number[] = [];
    expect(await hashVisionFile(file, (fraction) => progress.push(fraction))).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readAll).not.toHaveBeenCalled();
    expect(slice).toHaveBeenCalledTimes(3);
    expect(progress.at(-1)).toBe(1);
  });

  it("aborts before reading another chunk when the user cancels", async () => {
    const file = new Blob([new Uint8Array(9 * 1024 * 1024)]);
    const slice = vi.spyOn(file, "slice");
    const abort = new AbortController();
    await expect(hashVisionFile(file, () => abort.abort(), abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(slice).toHaveBeenCalledTimes(1);
  });
});

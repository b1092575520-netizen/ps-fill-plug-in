import { describe, expect, it, vi } from "vitest";
import { AssetLifecycleManager, measureImageBytes } from "../src/assetLifecycleManager";

const owner = (documentId: string, jobId = "job-1", revision = 1) => ({
  documentId,
  jobId,
  revision,
  ownerPrefix: "ps-fill",
});

describe("AssetLifecycleManager", () => {
  it("cleans a job idempotently and releases held candidate bytes", async () => {
    const manager = new AssetLifecycleManager();
    const asset = { bytes: new Uint8Array([1, 2, 3, 4]) };
    const revoke = vi.fn();
    manager.registerBytes("ps-fill-candidate-a", owner("doc-a"), asset);
    manager.register("ps-fill-blob-a", "blob-url", owner("doc-a"), revoke);

    expect(manager.stats("doc-a").candidateBytes).toBe(4);
    await manager.cleanupJob("doc-a", "job-1", 1);
    await manager.cleanupJob("doc-a", "job-1", 1);

    expect(asset.bytes).toHaveLength(0);
    expect(revoke).toHaveBeenCalledOnce();
    expect(manager.stats("doc-a").candidateBytes).toBe(0);
  });

  it("never cleans another document or an unowned user layer", async () => {
    const manager = new AssetLifecycleManager();
    const deleteA = vi.fn();
    const deleteB = vi.fn();
    manager.register("ps-fill-preview-a", "preview-layer", owner("doc-a"), deleteA);
    manager.register("ps-fill-preview-b", "preview-layer", owner("doc-b"), deleteB);
    expect(() => manager.register("portrait-background", "preview-layer", {
      ...owner("doc-a"),
      ownerPrefix: "ps-fill",
    }, vi.fn())).toThrow(/所有者前缀/);

    await manager.cleanupDocument("doc-a");

    expect(deleteA).toHaveBeenCalledOnce();
    expect(deleteB).not.toHaveBeenCalled();
    expect(manager.stats("doc-b").previewLayers).toBe(1);
  });

  it("enforces candidate count and decoded image limits", () => {
    const manager = new AssetLifecycleManager({
      maxCandidates: 4,
      maxImageBytes: 10,
      maxPixels: 100,
      maxDimension: 20,
    });
    expect(() => manager.assertImage({ bytes: 11, width: 5, height: 5 })).toThrow(/字节/);
    expect(() => manager.assertImage({ bytes: 5, width: 11, height: 10 })).toThrow(/像素/);
    expect(() => manager.assertImage({ bytes: 5, width: 21, height: 4 })).toThrow(/尺寸/);
    expect(() => manager.assertCandidateCount(5)).toThrow(/4/);
  });

  it("reads decoded PNG dimensions before retaining candidate bytes", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    const view = new DataView(png.buffer);
    view.setUint32(16, 320);
    view.setUint32(20, 240);
    expect(measureImageBytes(png)).toEqual({ bytes: 24, width: 320, height: 240 });
    expect(() => measureImageBytes(new Uint8Array([1, 2, 3]))).toThrow(/解码尺寸/);
  });

  it("reuses one uploaded reference result inside a document session", async () => {
    const manager = new AssetLifecycleManager();
    const upload = vi.fn(async () => "https://example.test/reference.png");
    const first = manager.reuseUpload("doc-a", "sha256:a", upload);
    const second = manager.reuseUpload("doc-a", "sha256:a", upload);

    await expect(Promise.all([first, second])).resolves.toEqual([
      "https://example.test/reference.png",
      "https://example.test/reference.png",
    ]);
    expect(upload).toHaveBeenCalledOnce();
  });

  it("uploads again once a cached reference URL could have expired", async () => {
    let now = 1_000;
    const manager = new AssetLifecycleManager({}, () => now);
    const upload = vi.fn()
      .mockResolvedValueOnce("https://example.test/first.png")
      .mockResolvedValueOnce("https://example.test/second.png");

    await expect(manager.reuseUpload("doc-a", "blob-1", upload)).resolves.toBe("https://example.test/first.png");
    now += 44 * 60 * 1000;
    await expect(manager.reuseUpload("doc-a", "blob-1", upload)).resolves.toBe("https://example.test/first.png");
    now += 2 * 60 * 1000;
    await expect(manager.reuseUpload("doc-a", "blob-1", upload)).resolves.toBe("https://example.test/second.png");
    expect(upload).toHaveBeenCalledTimes(2);
  });
});

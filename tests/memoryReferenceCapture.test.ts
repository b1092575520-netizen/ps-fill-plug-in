import { describe, it, expect, vi } from "vitest";
import { UxpPhotoshopRuntime } from "../src/backend/runtime";

function setup(width = 4000, height = 2000) {
  const snapshot = { id: 99, flatten: vi.fn(), closeWithoutSaving: vi.fn() };
  const source = { id: 7, width, height, duplicate: vi.fn(async () => snapshot) };
  const dispose = vi.fn();
  const imaging = { getPixels: vi.fn(async () => ({ imageData: { dispose } })), encodeImageData: vi.fn().mockResolvedValue([255, 216, 255, 217]) };
  const getTemporaryFolder = vi.fn(() => { throw new Error("no such file or directory"); });
  const runtime = new UxpPhotoshopRuntime(name => name === "photoshop"
    ? { app: { documents: [source], activeDocument: source }, imaging }
    : { storage: { localFileSystem: { getTemporaryFolder } } });
  return { runtime, source, snapshot, dispose, imaging, getTemporaryFolder };
}

describe("in-memory document reference", () => {
  it("captures JPEG with an inaccessible temp directory and no file reads", async () => {
    const h = setup();
    const result = await h.runtime.captureVisibleComposite("document", "7");
    expect(result.bytes).toEqual(new Uint8Array([255, 216, 255, 217]));
    expect(result.mimeType).toBe("image/jpeg");
    expect(h.getTemporaryFolder).not.toHaveBeenCalled();
    expect(h.imaging.getPixels).toHaveBeenCalledWith(expect.objectContaining({ documentID: 99, targetSize: { width: 3072 }, colorSpace: "RGB", componentSize: 8, applyAlpha: true }));
    expect(h.snapshot.flatten).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.snapshot.closeWithoutSaving).toHaveBeenCalledOnce();
  });
  it("reduces oversized encoded references and releases both buffers", async () => {
    const h = setup(2000, 4000);
    h.imaging.encodeImageData.mockResolvedValueOnce(new Uint8Array(1_800_001));
    await h.runtime.captureVisibleComposite("document", "7");
    expect(h.imaging.getPixels.mock.calls.map(([options]) => (options as any).targetSize)).toEqual([{ height: 3072 }, { height: 2048 }]);
    expect(h.dispose).toHaveBeenCalledTimes(2);
  });
  it("releases pixels and closes the snapshot when encoding fails", async () => {
    const h = setup();
    h.imaging.encodeImageData.mockRejectedValue(new Error("encode failed"));
    await expect(h.runtime.captureVisibleComposite("document", "7")).rejects.toThrow("读取当前画面失败：encode failed");
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.snapshot.closeWithoutSaving).toHaveBeenCalledOnce();
    expect(h.getTemporaryFolder).not.toHaveBeenCalled();
  });
  it("does not upscale small documents and rejects empty encoded data", async () => {
    const h = setup(100, 50);
    h.imaging.encodeImageData.mockResolvedValue([]);
    await expect(h.runtime.captureVisibleComposite("document", "7")).rejects.toThrow("编码结果为空");
    expect(h.imaging.getPixels).toHaveBeenCalledWith(expect.objectContaining({ targetSize: { width: 100 } }));
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.snapshot.closeWithoutSaving).toHaveBeenCalledOnce();
  });
});
